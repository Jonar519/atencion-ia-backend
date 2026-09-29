import { randomBytes, randomUUID } from "crypto";
import type { CookieOptions } from "express";
import type { StaffUser } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { ApiError } from "../../utils/apiError";
import { sha256 } from "../../utils/hash";
import { issueAccessToken } from "./tokens";

/**
 * Sesión del staff: access token corto + refresh token rotativo (mismo
 * esquema que el Proyecto 1, docs/adr/0002-esquema-de-sesion.md).
 *
 *  - Access token: JWT de 15 min en el header Authorization. El navegador lo
 *    guarda SOLO en memoria (un XSS no lo encuentra en localStorage y dura poco).
 *  - Refresh token: 32 bytes aleatorios en una cookie httpOnly (JavaScript no
 *    puede leerla), SameSite=Strict, Path=/api/auth, Secure en producción.
 *    En la base solo se guarda su SHA-256.
 *  - Rotación: cada /refresh entrega un refresh token nuevo y revoca el usado.
 *  - Reutilización: si llega un token YA rotado, alguien más lo tiene (robo):
 *    se revoca la familia completa y hay que volver a iniciar sesión.
 *    Excepción: dentro de REUSE_GRACE_MS se asume una carrera legítima (dos
 *    pestañas refrescando a la vez con la misma cookie) y se pide reintentar.
 */

export const REFRESH_COOKIE = "atencion_ia_refresh";
export const REFRESH_COOKIE_PATH = "/api/auth";
export const REUSE_GRACE_MS = 10_000;

const ttlMs = () => env.refreshTokenTtlDays * 24 * 60 * 60 * 1000;

type SessionStaff = Pick<StaffUser, "id" | "name" | "email" | "role" | "availability">;

export function publicStaff(staff: SessionStaff) {
  return { id: staff.id, name: staff.name, email: staff.email, role: staff.role, availability: staff.availability };
}

export function refreshCookieOptions(): CookieOptions {
  return { httpOnly: true, secure: env.cookieSecure, sameSite: "strict", path: REFRESH_COOKIE_PATH, maxAge: ttlMs() };
}

export interface SessionResult {
  accessToken: string;
  refreshToken: string;
  staff: ReturnType<typeof publicStaff>;
}

export class RefreshReuseError extends ApiError {
  constructor(public readonly staffId: string) {
    super(401, "La sesión se cerró por seguridad: el token de sesión ya se había usado. Inicia sesión de nuevo.");
  }
}

const RETRY_CONFLICT = "La sesión se está renovando en otra pestaña; reintenta.";

export const sessionsService = {
  /** Inicio de sesión: nueva familia de refresh tokens. */
  async start(staff: SessionStaff, userAgent?: string): Promise<SessionResult> {
    const raw = randomBytes(32).toString("base64url");
    await prisma.refreshToken.create({
      data: {
        staffUserId: staff.id,
        familyId: randomUUID(),
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + ttlMs()),
        userAgent: userAgent?.slice(0, 200),
      },
    });
    return { accessToken: issueAccessToken(staff), refreshToken: raw, staff: publicStaff(staff) };
  },

  async rotate(rawToken: string | undefined): Promise<SessionResult> {
    if (!rawToken) throw new ApiError(401, "No hay una sesión activa");
    const current = await prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
      include: { staffUser: true },
    });
    if (!current) throw new ApiError(401, "Sesión inválida");

    if (current.revokedAt) {
      if (current.revokeReason === "rotated") {
        if (Date.now() - current.revokedAt.getTime() < REUSE_GRACE_MS) {
          // Otra pestaña acaba de rotarlo: la cookie nueva ya está en el navegador.
          throw new ApiError(409, RETRY_CONFLICT);
        }
        await this.revokeFamily(current.familyId, "reuse_detected");
        throw new RefreshReuseError(current.staffUserId);
      }
      throw new ApiError(401, "La sesión ya fue cerrada");
    }
    if (current.expiresAt.getTime() <= Date.now()) throw new ApiError(401, "La sesión expiró. Inicia sesión de nuevo.");
    // Un agente desactivado no puede renovar: su sesión muere con el access token actual.
    if (!current.staffUser.isActive) {
      await this.revokeFamily(current.familyId, "logout");
      throw new ApiError(401, "La cuenta está desactivada");
    }

    const next = await prisma.$transaction(async (tx) => {
      // Revocación condicional: si dos peticiones rotan a la vez el mismo
      // token, solo una gana (count = 1); la otra recibe 409 y reintenta.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: current.id, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: "rotated" },
      });
      if (count === 0) throw new ApiError(409, RETRY_CONFLICT);
      const raw = randomBytes(32).toString("base64url");
      const record = await tx.refreshToken.create({
        data: {
          staffUserId: current.staffUserId,
          familyId: current.familyId,
          tokenHash: sha256(raw),
          expiresAt: new Date(Date.now() + ttlMs()),
          userAgent: current.userAgent,
        },
      });
      await tx.refreshToken.update({ where: { id: current.id }, data: { replacedById: record.id } });
      return raw;
    });

    return {
      accessToken: issueAccessToken(current.staffUser),
      refreshToken: next,
      staff: publicStaff(current.staffUser),
    };
  },

  /** Cierre de sesión: revoca la familia del token presentado (todas sus rotaciones). */
  async end(rawToken: string | undefined): Promise<string | null> {
    if (!rawToken) return null;
    const current = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
    if (!current) return null;
    await this.revokeFamily(current.familyId, "logout");
    return current.staffUserId;
  },

  async revokeFamily(familyId: string, reason: "logout" | "reuse_detected") {
    await prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  },

  /** Cierra TODAS las sesiones de un miembro del staff (p. ej. al desactivarlo). */
  async revokeAllFor(staffId: string) {
    await prisma.refreshToken.updateMany({
      where: { staffUserId: staffId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: "logout" },
    });
  },
};
