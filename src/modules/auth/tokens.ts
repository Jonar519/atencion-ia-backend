import jwt, { SignOptions } from "jsonwebtoken";
import type { StaffRole } from "@prisma/client";
import { env } from "../../config/env";

export interface AccessTokenPayload {
  staffId: string;
  role: StaffRole;
  /** Sesión (familia de refresh tokens) que emitió este token: marca "esta sesión" y "cerrar las demás". */
  sessionId?: string;
  /** Expiración (segundos desde epoch), para cerrar a tiempo conexiones largas (WebSocket). */
  exp?: number;
}

const ROLES: readonly StaffRole[] = ["admin", "agent"];
const ISSUER = "atencion-ia";
const AUDIENCE = "atencion-ia-staff";

/** Access token del staff: JWT HS256 de vida corta. `sub` = id del staff. */
export function issueAccessToken(staff: { id: string; role: StaffRole }, sessionId?: string): string {
  return jwt.sign({ role: staff.role, ...(sessionId ? { sid: sessionId } : {}) }, env.jwtSecret, {
    algorithm: "HS256",
    subject: staff.id,
    issuer: ISSUER,
    // La audiencia distingue este token de los futuros tokens de cliente/widget:
    // un token de cliente nunca podrá usarse contra el panel de agentes.
    audience: AUDIENCE,
    expiresIn: env.jwtExpiresIn as SignOptions["expiresIn"],
  });
}

/**
 * Verifica un access token y devuelve su contenido, o null si es inválido o
 * expiró. Único punto de verificación: lo usan el middleware HTTP y, en la
 * Fase 4, el servidor WebSocket. Fija el algoritmo (evita "alg: none" y la
 * confusión HS/RS), el emisor y la audiencia.
 */
export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const payload = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE });
    if (typeof payload !== "object" || typeof payload.sub !== "string" || !ROLES.includes(payload.role)) {
      return null;
    }
    return {
      staffId: payload.sub,
      role: payload.role as StaffRole,
      sessionId: typeof payload.sid === "string" ? payload.sid : undefined,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}
