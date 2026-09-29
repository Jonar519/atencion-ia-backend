import { NextFunction, Request, Response } from "express";
import { randomBytes } from "crypto";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { sha256 } from "../../utils/hash";

/**
 * Identidad del CLIENTE en el widget: un token opaco "wgt_…" (32 bytes
 * aleatorios), no un JWT. En la base solo se guarda su SHA-256
 * (widget_sessions.token_hash).
 *
 * Separación de identidades:
 *  - Un token de widget no es un JWT: authMiddleware del staff lo rechaza.
 *  - Un JWT del staff no empieza con "wgt_": este middleware lo rechaza.
 * Así un cliente nunca llega al panel de agentes, ni un agente "se hace pasar"
 * por un cliente en el widget.
 */

export const WIDGET_TOKEN_PREFIX = "wgt_";

export interface WidgetIdentity {
  sessionId: string;
  customerId: string;
}

declare module "express-serve-static-core" {
  interface Request {
    widget?: WidgetIdentity;
  }
}

export function newWidgetToken(): string {
  return `${WIDGET_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Actualizar last_seen_at en cada petición sería una escritura por mensaje: basta cada 5 min. */
const LAST_SEEN_RESOLUTION_MS = 5 * 60 * 1000;

export async function widgetAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!token.startsWith(WIDGET_TOKEN_PREFIX) || token.length > 100) {
      throw new ApiError(401, "Sesión del chat inválida o expirada");
    }
    const session = await prisma.widgetSession.findUnique({
      where: { tokenHash: sha256(token) },
      select: { id: true, customerId: true, expiresAt: true, revokedAt: true, lastSeenAt: true },
    });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
      throw new ApiError(401, "Sesión del chat inválida o expirada");
    }
    if (Date.now() - session.lastSeenAt.getTime() > LAST_SEEN_RESOLUTION_MS) {
      await prisma.widgetSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    }
    req.widget = { sessionId: session.id, customerId: session.customerId };
    next();
  } catch (err) {
    next(err);
  }
}

export function currentWidget(req: Request): WidgetIdentity {
  if (!req.widget) throw new ApiError(401, "Sesión del chat inválida o expirada");
  return req.widget;
}
