import { NextFunction, Request, Response, CookieOptions } from "express";
import { randomBytes } from "crypto";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { ApiError } from "../../utils/apiError";
import { sha256 } from "../../utils/hash";
import { readCookie } from "../../utils/cookies";
import { csrfProtection } from "../../middlewares/csrf.middleware";

/**
 * Identidad del CLIENTE en el widget: un token opaco "wgt_…" (32 bytes
 * aleatorios), no un JWT. En la base solo se guarda su SHA-256.
 *
 * Dos formas de presentarlo:
 *  - Navegador (widget): cookie httpOnly `atencion_ia_widget`, SameSite=Strict.
 *    El JavaScript de la página NUNCA ve el token (un XSS no puede robarlo),
 *    igual que el refresh token del staff. Como la cookie viaja sola, toda
 *    escritura autenticada con ella exige el encabezado anti-CSRF (y un Origin
 *    permitido): un formulario de otro sitio no puede ponerlo.
 *  - Clientes de API (curl, la demo de la Fase 3, tests): "Authorization: Bearer wgt_…".
 *    Un header no viaja solo desde otro sitio, así que no necesita CSRF.
 *
 * Separación de identidades: un token de widget no es un JWT (el panel del
 * staff lo rechaza) y un JWT del staff no empieza con "wgt_" (aquí se rechaza).
 */

export const WIDGET_TOKEN_PREFIX = "wgt_";
export const WIDGET_COOKIE = "atencion_ia_widget";

export interface WidgetIdentity {
  sessionId: string;
  customerId: string;
  expiresAt: Date;
}

declare module "express-serve-static-core" {
  interface Request {
    widget?: WidgetIdentity;
  }
}

export function newWidgetToken(): string {
  return `${WIDGET_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function widgetCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: "strict",
    // "/" y no "/api/widget": el mismo token autentica el WebSocket (/ws).
    path: "/",
    maxAge: env.widgetSessionTtlHours * 3_600_000,
  };
}

/** Actualizar last_seen_at en cada petición sería una escritura por mensaje: basta cada 5 min. */
const LAST_SEEN_RESOLUTION_MS = 5 * 60 * 1000;
const INVALID = "Sesión del chat inválida o expirada";

/**
 * Busca la sesión de un token. La usan el middleware HTTP y el servidor
 * WebSocket (misma verificación en los dos lados).
 */
export async function resolveWidgetToken(token: string | undefined): Promise<WidgetIdentity | null> {
  if (!token || !token.startsWith(WIDGET_TOKEN_PREFIX) || token.length > 100) return null;
  const session = await prisma.widgetSession.findUnique({
    where: { tokenHash: sha256(token) },
    select: { id: true, customerId: true, expiresAt: true, revokedAt: true, lastSeenAt: true },
  });
  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
  if (Date.now() - session.lastSeenAt.getTime() > LAST_SEEN_RESOLUTION_MS) {
    await prisma.widgetSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  }
  return { sessionId: session.id, customerId: session.customerId, expiresAt: session.expiresAt };
}

export async function widgetAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    const cookie = readCookie(req.headers.cookie, WIDGET_COOKIE);
    // Si viene el header, manda el header (clientes de API); si no, la cookie (navegador).
    const identity = await resolveWidgetToken(bearer ?? cookie);
    if (!identity) throw new ApiError(401, INVALID);

    if (!bearer && req.method !== "GET" && req.method !== "HEAD") {
      // Autenticado por cookie: toda escritura exige la protección anti-CSRF.
      csrfProtection(req, res, () => undefined);
    }
    req.widget = identity;
    next();
  } catch (err) {
    next(err);
  }
}

export function currentWidget(req: Request): WidgetIdentity {
  if (!req.widget) throw new ApiError(401, INVALID);
  return req.widget;
}
