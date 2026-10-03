import { randomBytes } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { sha256 } from "../../utils/hash";
import { dbNow } from "../../utils/dbTime";

/**
 * Tokens de UN SOLO USO (tabla staff_tokens): recuperar contraseña, confirmar
 * un correo nuevo, y los pasos de MFA en el login.
 *
 *  - Se entregan 32 bytes aleatorios; en la base solo queda su SHA-256.
 *  - Emitir uno nuevo INVALIDA el anterior del mismo propósito (la base
 *    exige a lo sumo uno vigente: índice único parcial).
 *  - Consumirlo es UNA sentencia condicional (sin usar y sin vencer): dos
 *    usos simultáneos del mismo enlace → solo uno gana.
 *
 * (No se usa un JWT firmado: no se podría invalidar tras usarlo.)
 */
export type TokenPurpose = "password_reset" | "email_change" | "mfa_challenge" | "mfa_enrollment" | "invitation";

export const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  password_reset: 15 * 60_000,
  email_change: 15 * 60_000,
  mfa_challenge: 5 * 60_000,
  mfa_enrollment: 10 * 60_000,
  // Invitación al panel (bloque F2): la persona puede no verla enseguida. La base topa en 72 h.
  invitation: 72 * 60 * 60_000,
};

/** Intentos fallidos permitidos contra un desafío de MFA antes de invalidarlo. */
export const MAX_MFA_ATTEMPTS = 5;

export async function issueToken(
  staffUserId: string,
  purpose: TokenPurpose,
  extra: { newEmail?: string } = {}
): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await prisma.$transaction(async (tx) => {
    // Serializa por cuenta: dos logins simultáneos (doble clic) no chocan contra
    // el índice "uno vigente por propósito"; el segundo invalida al primero.
    await tx.$executeRaw`SELECT 1 FROM staff_users WHERE id = ${staffUserId}::uuid FOR UPDATE`;
    const now = await dbNow(tx);
    await tx.staffToken.updateMany({ where: { staffUserId, purpose, usedAt: null }, data: { usedAt: now } });
    await tx.staffToken.create({
      data: {
        staffUserId,
        purpose,
        tokenHash: sha256(raw),
        newEmail: extra.newEmail ?? null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + TOKEN_TTL_MS[purpose]),
      },
    });
  });
  return raw;
}

/** Busca un token vigente SIN consumirlo (p. ej. un desafío de MFA mientras se prueba el código). */
export async function findLiveToken(raw: string | undefined, purpose: TokenPurpose) {
  if (!raw || raw.length > 100) return null;
  return prisma.staffToken.findFirst({
    where: { tokenHash: sha256(raw), purpose, usedAt: null, expiresAt: { gt: new Date() } },
  });
}

/** Consume el token (un solo uso). Devuelve su registro, o null si no existe, venció o ya se usó. */
export async function consumeToken(
  raw: string | undefined,
  purpose: TokenPurpose,
  tx: Prisma.TransactionClient = prisma
): Promise<{ staffUserId: string; newEmail: string | null } | null> {
  if (!raw || raw.length > 100) return null;
  const rows = await tx.$queryRaw<{ staff_user_id: string; new_email: string | null }[]>`
    UPDATE staff_tokens SET used_at = now()
    WHERE token_hash = ${sha256(raw)} AND purpose = ${purpose} AND used_at IS NULL AND expires_at > now()
    RETURNING staff_user_id, new_email`;
  const row = rows[0];
  return row ? { staffUserId: row.staff_user_id, newEmail: row.new_email } : null;
}

/** Un intento fallido contra un desafío de MFA; al llegar al máximo, el desafío muere. */
export async function registerFailedAttempt(tokenId: string): Promise<number> {
  const updated = await prisma.staffToken.update({
    where: { id: tokenId },
    data: { attempts: { increment: 1 } },
    select: { attempts: true },
  });
  if (updated.attempts >= MAX_MFA_ATTEMPTS) {
    // now() de la BASE (no el reloj de Node): el CHECK exige used_at >= created_at (docs/adr/0004).
    await prisma.$executeRaw`UPDATE staff_tokens SET used_at = now() WHERE id = ${tokenId}::uuid AND used_at IS NULL`;
  }
  return updated.attempts;
}
