import { Request, Response } from "express";
import { AccountLockedError, InvalidMfaCodeError, authService, type LoginResult } from "./auth.service";
import { invitationsService } from "../staff/invitations.service";
import {
  ClientInfo,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  RefreshReuseError,
  SessionResult,
  refreshCookieOptions,
  sessionsService,
} from "./sessions.service";
import { RESET_REQUESTED, passwordService } from "./password.service";
import { profileService } from "../profile/profile.service";
import { audit } from "../../services/audit/audit.service";
import { ApiError } from "../../utils/apiError";
import { authEvents } from "../../observability/metrics";
import { currentUser } from "../../utils/params";

export function readRefreshCookie(req: Request): string | undefined {
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

/** Desde dónde se conecta (panel de sesiones). req.ip ya respeta TRUST_PROXY. */
export const clientOf = (req: Request): ClientInfo => ({ ip: req.ip, userAgent: req.get("user-agent") });

/** Access token en el cuerpo; refresh token SOLO en la cookie httpOnly (nunca en el JSON). */
function sendSession(res: Response, session: SessionResult, extra: Record<string, unknown> = {}) {
  res.cookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOptions());
  res.status(200).json({ accessToken: session.accessToken, staff: session.staff, ...extra });
}

function auditLoginSuccess(req: Request, staffId: string, mfa: boolean) {
  audit(req, {
    action: "auth.login_success",
    actorId: staffId,
    entityType: "staff_user",
    entityId: staffId,
    metadata: { mfa },
  });
  authEvents.inc({ event: "login_success" });
}

/** Fallos de login y de MFA: contador + auditoría SIN el correo (solo HMAC de la IP y el user agent). */
function auditFailure(req: Request, err: unknown) {
  if (err instanceof AccountLockedError) {
    authEvents.inc({ event: "login_locked" });
    audit(req, { action: "auth.login_locked", actorId: null });
  } else if (err instanceof InvalidMfaCodeError) {
    authEvents.inc({ event: "mfa_failure" });
    audit(req, { action: "auth.mfa_failure", actorId: null });
  } else if (err instanceof ApiError && err.statusCode === 401) {
    authEvents.inc({ event: "login_failure" });
    audit(req, { action: "auth.login_failure", actorId: null });
  }
}

/** Misma respuesta para el login y para completar una invitación: sesión, código de MFA o activar MFA. */
function sendLoginResult(req: Request, res: Response, result: LoginResult) {
  if (result.kind === "session") {
    auditLoginSuccess(req, result.session.staff.id, false);
    sendSession(res, result.session);
  } else if (result.kind === "mfa_required") {
    res.status(200).json({ mfaRequired: true, challengeToken: result.challengeToken });
  } else {
    res.status(200).json({ mfaEnrollmentRequired: true, enrollmentToken: result.enrollmentToken });
  }
}

export const authController = {
  async login(req: Request, res: Response) {
    try {
      sendLoginResult(req, res, await authService.login(req.body, clientOf(req)));
    } catch (err) {
      auditFailure(req, err);
      throw err;
    }
  },

  /** Invitación (bloque F2): a quién invitaron. Cualquier enlace que no sirva → el mismo 400. */
  async inspectInvitation(req: Request, res: Response) {
    res.json(await invitationsService.inspect(req.body.token));
  },

  /** Completar la cuenta con la contraseña propia; luego, lo mismo que un login. */
  async acceptInvitation(req: Request, res: Response) {
    const staffId = await invitationsService.accept(req.body.token, req.body.password);
    audit(req, {
      action: "staff.invitation_accepted",
      actorId: staffId,
      entityType: "staff_user",
      entityId: staffId,
    });
    sendLoginResult(req, res, await authService.afterInvitationAccepted(staffId, clientOf(req)));
  },

  async verifyMfa(req: Request, res: Response) {
    try {
      const result = await authService.verifyMfa(req.body, clientOf(req));
      auditLoginSuccess(req, result.session.staff.id, true);
      if (result.usedBackupCode) {
        audit(req, {
          action: "auth.mfa_backup_code_used",
          actorId: result.session.staff.id,
          entityType: "staff_user",
          entityId: result.session.staff.id,
          metadata: { remaining: result.backupCodesRemaining ?? 0 },
        });
      }
      sendSession(
        res,
        result.session,
        result.usedBackupCode ? { backupCodesRemaining: result.backupCodesRemaining } : {}
      );
    } catch (err) {
      auditFailure(req, err);
      throw err;
    }
  },

  async startEnrollment(req: Request, res: Response) {
    res.json(await authService.startEnrollment(req.body.enrollmentToken));
  },

  async confirmEnrollment(req: Request, res: Response) {
    const result = await authService.confirmEnrollment(req.body, clientOf(req));
    const staffId = result.session.staff.id;
    audit(req, { action: "mfa.enabled", actorId: staffId, entityType: "staff_user", entityId: staffId });
    auditLoginSuccess(req, staffId, true);
    // Los códigos de respaldo viajan UNA vez, en esta respuesta (en la base solo quedan sus hashes).
    sendSession(res, result.session, { backupCodes: result.backupCodes });
  },

  async refresh(req: Request, res: Response) {
    try {
      sendSession(res, await sessionsService.rotate(readRefreshCookie(req), clientOf(req)));
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
    res.json(await profileService.get(currentUser(req).staffId));
  },

  /** Siempre 202 con el mismo cuerpo, al instante: no revela si el correo tiene cuenta. */
  async forgotPassword(req: Request, res: Response) {
    passwordService.requestReset(req.body.email);
    res.status(202).json({ message: RESET_REQUESTED });
  },

  async resetPassword(req: Request, res: Response) {
    const staffId = await passwordService.reset(req.body.token, req.body.password);
    audit(req, { action: "auth.password_reset", actorId: staffId, entityType: "staff_user", entityId: staffId });
    clearRefreshCookie(res);
    res.status(200).json({ message: "Tu contraseña cambió. Inicia sesión con la nueva." });
  },

  /** Confirmación del correo nuevo: sin sesión (el enlace llega a la bandeja nueva, quizá en otro equipo). */
  async confirmEmail(req: Request, res: Response) {
    const staffId = await profileService.confirmEmailChange(req.body.token);
    audit(req, { action: "profile.email_changed", actorId: staffId, entityType: "staff_user", entityId: staffId });
    res.status(200).json({ message: "Tu correo quedó actualizado. Úsalo para iniciar sesión." });
  },
};
