import { Request, Response } from "express";
import { AccountLockedError, authService } from "./auth.service";
import {
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  RefreshReuseError,
  SessionResult,
  refreshCookieOptions,
  sessionsService,
} from "./sessions.service";
import { staffService } from "../staff/staff.service";
import { audit } from "../../services/audit/audit.service";
import { ApiError } from "../../utils/apiError";
import { authEvents } from "../../observability/metrics";
import { currentUser } from "../../utils/params";

function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  // Parseo mínimo del header Cookie: solo interesa una cookie conocida.
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== REFRESH_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim()) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function clearRefreshCookie(res: Response) {
  const { maxAge: _maxAge, ...options } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE, { ...options, path: REFRESH_COOKIE_PATH });
}

/** Access token en el cuerpo; refresh token SOLO en la cookie httpOnly (nunca en el JSON). */
function sendSession(res: Response, session: SessionResult) {
  res.cookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOptions());
  res.status(200).json({ accessToken: session.accessToken, staff: session.staff });
}

export const authController = {
  async login(req: Request, res: Response) {
    try {
      const session = await authService.login(req.body, req.get("user-agent"));
      audit(req, {
        action: "auth.login_success",
        actorId: session.staff.id,
        entityType: "staff_user",
        entityId: session.staff.id,
      });
      authEvents.inc({ event: "login_success" });
      sendSession(res, session);
    } catch (err) {
      // Sin el correo: la auditoría de fallos solo guarda el HMAC de la IP y el user agent.
      if (err instanceof AccountLockedError) {
        authEvents.inc({ event: "login_locked" });
        audit(req, { action: "auth.login_locked", actorId: null });
      } else if (err instanceof ApiError && err.statusCode === 401) {
        authEvents.inc({ event: "login_failure" });
        audit(req, { action: "auth.login_failure", actorId: null });
      }
      throw err;
    }
  },

  async refresh(req: Request, res: Response) {
    try {
      sendSession(res, await sessionsService.rotate(readRefreshCookie(req)));
    } catch (err) {
      if (err instanceof RefreshReuseError) {
        authEvents.inc({ event: "refresh_reuse_detected" });
        audit(req, { action: "auth.refresh_reuse_detected", actorId: err.staffId, entityType: "session" });
      }
      // 409 = carrera entre pestañas: la cookie del navegador ya es la nueva, no se borra.
      if (!(err instanceof ApiError && err.statusCode === 409)) clearRefreshCookie(res);
      throw err;
    }
  },

  async logout(req: Request, res: Response) {
    const staffId = await sessionsService.end(readRefreshCookie(req));
    if (staffId) audit(req, { action: "auth.logout", actorId: staffId, entityType: "staff_user", entityId: staffId });
    clearRefreshCookie(res);
    res.status(204).end();
  },

  async me(req: Request, res: Response) {
    res.json(await staffService.getPublic(currentUser(req).staffId));
  },
};
