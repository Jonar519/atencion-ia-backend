import { NextFunction, Request, Response } from "express";
import type { StaffRole } from "@prisma/client";
import { ApiError } from "../utils/apiError";
import { verifyAccessToken } from "../modules/auth/tokens";

export interface AuthUser {
  staffId: string;
  role: StaffRole;
  /** Sesión (familia de refresh tokens) del token; no está en tokens emitidos antes de la Fase 7. */
  sessionId?: string;
}

// Agrega req.user al tipo Request de Express (module augmentation).
declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

/**
 * Exige un access token válido en "Authorization: Bearer <jwt>".
 *
 * El token es autocontenido (15 min): no se consulta la base en cada petición.
 * Consecuencia conocida: si un admin desactiva a un agente, sus refresh tokens
 * se revocan al instante pero su access token sigue siendo válido hasta que
 * expire. Por eso las operaciones que cambian estado (tomar una conversación,
 * enviar un mensaje) vuelven a comprobar is_active en la base.
 */
export function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) throw new ApiError(401, "Token no proporcionado");

  const payload = verifyAccessToken(header.slice("Bearer ".length));
  if (!payload) throw new ApiError(401, "Token inválido o expirado");

  req.user = { staffId: payload.staffId, role: payload.role, sessionId: payload.sessionId };
  next();
}
