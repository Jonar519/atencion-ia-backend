import { randomBytes, randomUUID } from "crypto";
import type { CookieOptions } from "express";
import type { StaffUser } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { ApiError } from "../../utils/apiError";
import { sha256 } from "../../utils/hash";
import { truncateIp } from "../../utils/ip";
import { getGeo } from "../../services/geo";
import { issueAccessToken } from "./tokens";

/**
 * Sesión del staff: access token corto + refresh token rotativo (mismo
 * esquema que el Proyecto 1, docs/adr/0002-esquema-de-sesion.md).
 *
 *  - Access token: JWT de 15 min en el header Authorization. El navegador lo
 *    guarda SOLO en memoria (un XSS no lo encuentra en localStorage y dura poco).
 *    Lleva el id de la SESIÓN (sid = familia de refresh tokens): así el panel de
 *    sesiones marca "esta sesión" y puede cerrar las demás.
 *  - Refresh token: 32 bytes aleatorios en una cookie httpOnly (JavaScript no
 *    puede leerla), SameSite=Strict, Path=/api/auth, Secure en producción.
 *    En la base solo se guarda su SHA-256.
 *  - Rotación: cada /refresh entrega un refresh token nuevo y revoca el usado.
 *  - Reutilización: si llega un token YA rotado, alguien más lo tiene (robo):
 *    se revoca la familia completa y hay que volver a iniciar sesión.
 *    Excepción: dentro de REUSE_GRACE_MS se asume una carrera legítima (dos
 *    pestañas refrescando a la vez con la misma cookie) y se pide reintentar.
 *  - Panel de sesiones (Fase 7): cada token guarda la IP TRUNCADA (x.y.z.0) y
 *    una ubicación APROXIMADA calculada con una base local (services/geo).
 */

export const REFRESH_COOKIE = "atencion_ia_refresh";
export const REFRESH_COOKIE_PATH = "/api/auth";
export const REUSE_GRACE_MS = 10_000;

const ttlMs = () => env.refreshTokenTtlDays * 24 * 60 * 60 * 1000;

export type RevokeReason =
  "logout" | "reuse_detected" | "password_reset" | "password_changed" | "revoked_by_user" | "account_deleted";

type SessionStaff = Pick<StaffUser, "id" | "name" | "email" | "role" | "availability"> &
  Partial<Pick<StaffUser, "mfaEnabledAt" | "avatarStorageKey">>;

export function publicStaff(staff: SessionStaff) {
  return {
    id: staff.id,
    name: staff.name,
    email: staff.email,
    role: staff.role,
    availability: staff.availability,
    mfaEnabled: Boolean(staff.mfaEnabledAt),
    hasAvatar: Boolean(staff.avatarStorageKey),
  };
}

export function refreshCookieOptions(): CookieOptions {
  return { httpOnly: true, secure: env.cookieSecure, sameSite: "strict", path: REFRESH_COOKIE_PATH, maxAge: ttlMs() };
}

export interface SessionResult {
  accessToken: string;
  refreshToken: string;
  staff: ReturnType<typeof publicStaff>;
}

/** De dónde viene la petición (para el panel de sesiones). */
export interface ClientInfo {
  userAgent?: string;
  ip?: string;
}

export class RefreshReuseError extends ApiError {
  constructor(public readonly staffId: string) {
    super(401, "La sesión se cerró por seguridad: el token de sesión ya se había usado. Inicia sesión de nuevo.");
  }
}

const RETRY_CONFLICT = "La sesión se está renovando en otra pestaña; reintenta.";

/** IP truncada + ubicación aproximada. Si el proveedor falla, la sesión sigue (sin ubicación). */
async function whereFrom(ip: string | undefined) {
  let locationLabel: string | null = null;
  if (ip) {
    try {
      locationLabel = await getGeo().lookup(ip);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Ubicación aproximada no disponible");
    }
  }
  return { ipAddress: truncateIp(ip), locationLabel: locationLabel?.slice(0, 120) ?? null };
}

export const sessionsService = {
  /** Inicio de sesión: nueva familia de refresh tokens. */
  async start(staff: SessionStaff, client: ClientInfo = {}): Promise<SessionResult> {
    const raw = randomBytes(32).toString("base64url");
    const familyId = randomUUID();
    await prisma.refreshToken.create({
      data: {
        staffUserId: staff.id,
        familyId,
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + ttlMs()),
        userAgent: client.userAgent?.slice(0, 200),
        ...(await whereFrom(client.ip)),
      },
    });
    return { accessToken: issueAccessToken(staff, familyId), refreshToken: raw, staff: publicStaff(staff) };
  },

  async rotate(rawToken: string | undefined, client: ClientInfo = {}): Promise<SessionResult> {
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

    const where = client.ip ? await whereFrom(client.ip) : null;
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
          // La sesión muestra desde dónde se usó por ÚLTIMA vez.
          ipAddress: where?.ipAddress ?? current.ipAddress,
          locationLabel: where?.locationLabel ?? current.locationLabel,
        },
      });
      await tx.refreshToken.update({ where: { id: current.id }, data: { replacedById: record.id } });
      return raw;
    });

    return {
      accessToken: issueAccessToken(current.staffUser, current.familyId),
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

  async revokeFamily(familyId: string, reason: RevokeReason) {
    await prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  },

  /** Cierra TODAS las sesiones de un miembro del staff (desactivarlo, restablecer la contraseña…). */
  async revokeAllFor(staffId: string, reason: RevokeReason = "logout") {
    await prisma.refreshToken.updateMany({
      where: { staffUserId: staffId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
  },

  /**
   * Sesiones ACTIVAS de una persona: una por familia, con su token vigente
   * (fecha de inicio = primer token de la familia; última actividad = el vigente).
   */
  async listActive(staffId: string, currentSessionId?: string) {
    const live = await prisma.refreshToken.findMany({
      where: { staffUserId: staffId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { familyId: true, createdAt: true, userAgent: true, ipAddress: true, locationLabel: true },
      orderBy: { createdAt: "desc" },
    });
    const started = await prisma.refreshToken.groupBy({
      by: ["familyId"],
      where: { familyId: { in: live.map((t) => t.familyId) } },
      _min: { createdAt: true },
    });
    const startOf = new Map(started.map((row) => [row.familyId, row._min.createdAt]));
    return live.map((token) => ({
      id: token.familyId,
      startedAt: startOf.get(token.familyId) ?? token.createdAt,
      lastActiveAt: token.createdAt,
      userAgent: token.userAgent,
      ipAddress: token.ipAddress,
      location: token.locationLabel,
      locationIsApproximate: true,
      current: token.familyId === currentSessionId,
    }));
  },

  /** Cierra UNA sesión propia. Una sesión ajena responde 404 (no se revela que existe). */
  async revokeOwn(staffId: string, familyId: string) {
    const { count } = await prisma.refreshToken.updateMany({
      where: { staffUserId: staffId, familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: "revoked_by_user" },
    });
    if (count === 0) throw new ApiError(404, "Sesión no encontrada");
  },

  /** "Cerrar sesión en los demás dispositivos": todas menos la actual. */
  async revokeOthers(staffId: string, keepSessionId: string | undefined, reason: RevokeReason = "revoked_by_user") {
    const { count } = await prisma.refreshToken.updateMany({
      where: {
        staffUserId: staffId,
        revokedAt: null,
        ...(keepSessionId ? { familyId: { not: keepSessionId } } : {}),
      },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    return count;
  },
};
