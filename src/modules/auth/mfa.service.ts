import { randomBytes } from "crypto";
import bcrypt from "bcrypt";
import QRCode from "qrcode";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { sha256 } from "../../utils/hash";
import { getEmail } from "../../services/email";
import { templates } from "../../services/email/templates";
import { decryptSecret, encryptSecret } from "./mfaCrypto";
import { generateSecret, otpauthUrl, verifyTotp } from "./totp";

/**
 * Verificación en dos pasos (TOTP) del staff.
 *
 * Reglas (probadas en tests/integration/mfa.test.ts y con mutaciones):
 *  - OBLIGATORIA para admin (se enrola en el login si no la tiene; no puede
 *    desactivarla); OPCIONAL para agent.
 *  - El secreto se guarda CIFRADO (AES-256-GCM) y solo se muestra al enrolar.
 *  - Un código TOTP no se puede reutilizar: se guarda el último paso aceptado
 *    y la actualización es condicional (dos logins simultáneos con el mismo
 *    código → solo uno entra).
 *  - 10 códigos de respaldo de un solo uso, guardados como hash; se muestran
 *    una única vez.
 */
export const BACKUP_CODE_COUNT = 10;

export interface EnrollmentSetup {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

/** "abcd-efgh" en minúsculas; se compara sin guion ni mayúsculas. */
function newBackupCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // sin 0/o/1/l/i (confusos)
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export const normalizeBackupCode = (code: string) => code.trim().toLowerCase().replace(/[\s-]/g, "");

async function staffForMfa(staffId: string) {
  const staff = await prisma.staffUser.findUnique({
    where: { id: staffId },
    select: {
      id: true,
      email: true,
      role: true,
      isActive: true,
      passwordHash: true,
      mfaSecretEncrypted: true,
      mfaEnabledAt: true,
      mfaLastUsedStep: true,
    },
  });
  if (!staff || !staff.isActive) throw new ApiError(401, "Cuenta no disponible");
  return staff;
}

export const mfaService = {
  /** Genera (o regenera) un secreto PENDIENTE: no se activa hasta confirmar un código. */
  async beginEnrollment(staffId: string): Promise<EnrollmentSetup> {
    const staff = await staffForMfa(staffId);
    if (staff.mfaEnabledAt) throw new ApiError(409, "La verificación en dos pasos ya está activa");
    const secret = generateSecret();
    await prisma.staffUser.update({
      where: { id: staffId },
      data: { mfaSecretEncrypted: encryptSecret(secret), mfaLastUsedStep: null },
    });
    const url = otpauthUrl(staff.email, secret);
    return { secret, otpauthUrl: url, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
  },

  /** Confirma el enrolamiento con un código de la app. Devuelve los códigos de respaldo (única vez). */
  async confirmEnrollment(staffId: string, code: string): Promise<string[]> {
    const staff = await staffForMfa(staffId);
    if (staff.mfaEnabledAt) throw new ApiError(409, "La verificación en dos pasos ya está activa");
    if (!staff.mfaSecretEncrypted) throw new ApiError(409, "Primero genera el código QR");
    const step = verifyTotp(decryptSecret(staff.mfaSecretEncrypted), code);
    if (step === null)
      throw new ApiError(400, "El código no es correcto. Revisa la hora de tu teléfono e intenta de nuevo.");
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, newBackupCode);
    await prisma.$transaction([
      prisma.staffUser.update({
        where: { id: staffId },
        data: { mfaEnabledAt: new Date(), mfaLastUsedStep: BigInt(step) },
      }),
      prisma.mfaBackupCode.deleteMany({ where: { staffUserId: staffId } }),
      prisma.mfaBackupCode.createMany({
        data: codes.map((c) => ({ staffUserId: staffId, codeHash: sha256(normalizeBackupCode(c)) })),
      }),
    ]);
    await getEmail().send(templates.mfaChanged(staff.email, staffId, true));
    return codes;
  },

  /**
   * Verifica un código TOTP para un inicio de sesión. Anti-replay: el paso
   * aceptado debe ser POSTERIOR al último guardado, y se guarda con una
   * actualización condicional.
   */
  async verifyCode(staffId: string, code: string): Promise<boolean> {
    const staff = await staffForMfa(staffId);
    if (!staff.mfaEnabledAt || !staff.mfaSecretEncrypted) return false;
    const lastUsedStep = staff.mfaLastUsedStep === null ? null : Number(staff.mfaLastUsedStep);
    const step = verifyTotp(decryptSecret(staff.mfaSecretEncrypted), code, { lastUsedStep });
    if (step === null) return false;
    const updated = await prisma.$executeRaw`
      UPDATE staff_users SET mfa_last_used_step = ${step}
      WHERE id = ${staffId}::uuid AND (mfa_last_used_step IS NULL OR mfa_last_used_step < ${step})`;
    return updated === 1;
  },

  /** Usa un código de respaldo (un solo uso, condicional: dos usos simultáneos → uno gana). */
  async useBackupCode(staffId: string, code: string): Promise<boolean> {
    const normalized = normalizeBackupCode(code);
    if (!/^[a-z0-9]{8}$/.test(normalized)) return false;
    const used = await prisma.$executeRaw`
      UPDATE mfa_backup_codes SET used_at = now()
      WHERE staff_user_id = ${staffId}::uuid AND code_hash = ${sha256(normalized)} AND used_at IS NULL`;
    return used === 1;
  },

  async remainingBackupCodes(staffId: string): Promise<number> {
    return prisma.mfaBackupCode.count({ where: { staffUserId: staffId, usedAt: null } });
  },

  /** Nuevos códigos de respaldo (invalida los anteriores). Exige un código TOTP vigente. */
  async regenerateBackupCodes(staffId: string, code: string): Promise<string[]> {
    if (!(await this.verifyCode(staffId, code))) throw new ApiError(400, "El código no es correcto");
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, newBackupCode);
    await prisma.$transaction([
      prisma.mfaBackupCode.deleteMany({ where: { staffUserId: staffId } }),
      prisma.mfaBackupCode.createMany({
        data: codes.map((c) => ({ staffUserId: staffId, codeHash: sha256(normalizeBackupCode(c)) })),
      }),
    ]);
    return codes;
  },

  /** Desactivar: solo agentes (para admin es obligatoria), con contraseña Y código. */
  async disable(staffId: string, password: string, code: string): Promise<void> {
    const staff = await staffForMfa(staffId);
    if (staff.role === "admin") {
      throw new ApiError(409, "Para una cuenta de administrador la verificación en dos pasos es obligatoria");
    }
    if (!staff.mfaEnabledAt) throw new ApiError(409, "La verificación en dos pasos no está activa");
    if (!(await bcrypt.compare(password, staff.passwordHash))) throw new ApiError(400, "La contraseña no es correcta");
    if (!(await this.verifyCode(staffId, code))) throw new ApiError(400, "El código no es correcto");
    await prisma.$transaction([
      prisma.staffUser.update({
        where: { id: staffId },
        data: { mfaEnabledAt: null, mfaSecretEncrypted: null, mfaLastUsedStep: null },
      }),
      prisma.mfaBackupCode.deleteMany({ where: { staffUserId: staffId } }),
    ]);
    await getEmail().send(templates.mfaChanged(staff.email, staffId, false));
  },
};
