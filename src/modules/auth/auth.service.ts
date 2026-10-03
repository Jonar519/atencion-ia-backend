import bcrypt from "bcrypt";
import type { StaffUser } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { lockoutService } from "./lockout.service";
import { mfaService } from "./mfa.service";
import { ClientInfo, SessionResult, sessionsService } from "./sessions.service";
import { consumeToken, findLiveToken, issueToken, registerFailedAttempt } from "./singleUseTokens";

export const BCRYPT_COST = 10;

// Mismo mensaje para "no existe", "contraseña incorrecta" y "cuenta
// desactivada": no se revela qué correos tienen cuenta.
export const INVALID_CREDENTIALS = "Credenciales inválidas";
export const INVALID_MFA_CODE = "El código no es correcto";
export const MFA_STEP_EXPIRED = "El paso de verificación venció o ya se usó. Inicia sesión de nuevo.";

// Hash de una contraseña aleatoria: cuando el correo no existe se compara
// igual contra este hash, para que la respuesta tarde lo mismo que con un
// correo real (si no, el tiempo de respuesta revelaría qué cuentas existen).
const DUMMY_HASH = bcrypt.hashSync(`dummy-${Math.random()}`, BCRYPT_COST);

/** Los correos se guardan y se buscan siempre en minúsculas (la base lo exige con un CHECK). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class AccountLockedError extends ApiError {
  constructor(remainingMs: number) {
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    super(429, `Demasiados intentos fallidos. Intenta de nuevo en ${minutes} minuto${minutes === 1 ? "" : "s"}.`);
  }
}

/** Código de la app (6 dígitos) o de respaldo ("abcd-efgh"). */
export class InvalidMfaCodeError extends ApiError {
  constructor() {
    super(401, INVALID_MFA_CODE);
  }
}

/**
 * Resultado del paso de contraseña:
 *  - session: sin MFA (agente que no la activó) → sesión inmediata.
 *  - mfa_required: la cuenta tiene MFA → hay que enviar el código con challengeToken (5 min, 5 intentos).
 *  - mfa_enrollment_required: admin SIN MFA → debe enrolarse ahora (10 min) antes de tener sesión.
 */
export type LoginResult =
  | { kind: "session"; session: SessionResult }
  | { kind: "mfa_required"; challengeToken: string }
  | { kind: "mfa_enrollment_required"; enrollmentToken: string };

async function completeLogin(staff: StaffUser, client: ClientInfo): Promise<SessionResult> {
  // El contador de fallos se borra SOLO al terminar el login completo: si se
  // borrara tras la contraseña, quien la conoce podría reiniciarlo entre
  // ráfagas de códigos de MFA.
  await lockoutService.registerSuccess(staff.email);
  await prisma.staffUser.update({ where: { id: staff.id }, data: { lastLoginAt: new Date() } });
  return sessionsService.start(staff, client);
}

async function staffOfToken(staffId: string) {
  const staff = await prisma.staffUser.findUnique({ where: { id: staffId } });
  if (!staff || !staff.isActive) throw new ApiError(401, MFA_STEP_EXPIRED);
  const remaining = await lockoutService.remainingLockMs(staff.email);
  if (remaining > 0) throw new AccountLockedError(remaining);
  return staff;
}

export const authService = {
  async login(input: { email: string; password: string }, client: ClientInfo = {}): Promise<LoginResult> {
    const email = normalizeEmail(input.email);

    const remaining = await lockoutService.remainingLockMs(email);
    if (remaining > 0) throw new AccountLockedError(remaining);

    const staff = await prisma.staffUser.findUnique({ where: { email } });
    const valid = await bcrypt.compare(input.password, staff?.passwordHash ?? DUMMY_HASH);
    if (!staff || !valid) {
      await lockoutService.registerFailure(email);
      throw new ApiError(401, INVALID_CREDENTIALS);
    }
    // Contraseña correcta pero cuenta desactivada (o anonimizada): mismo 401, y no cuenta como fallo.
    if (!staff.isActive) throw new ApiError(401, INVALID_CREDENTIALS);

    if (staff.mfaEnabledAt) {
      return { kind: "mfa_required", challengeToken: await issueToken(staff.id, "mfa_challenge") };
    }
    if (staff.role === "admin") {
      return { kind: "mfa_enrollment_required", enrollmentToken: await issueToken(staff.id, "mfa_enrollment") };
    }
    return { kind: "session", session: await completeLogin(staff, client) };
  },

  /**
   * Segundo paso del login. Cada código incorrecto cuenta DOS veces: contra el
   * desafío (muere a los 5) y contra el bloqueo progresivo de la cuenta (el
   * mismo de las contraseñas), así pedir desafíos nuevos no da intentos gratis.
   */
  async verifyMfa(input: { challengeToken: string; code: string }, client: ClientInfo = {}) {
    const challenge = await findLiveToken(input.challengeToken, "mfa_challenge");
    if (!challenge) throw new ApiError(401, MFA_STEP_EXPIRED);
    const staff = await staffOfToken(challenge.staffUserId);

    const isTotp = /^\d{6}$/.test(input.code.trim());
    const ok = isTotp
      ? await mfaService.verifyCode(staff.id, input.code.trim())
      : await mfaService.useBackupCode(staff.id, input.code);
    if (!ok) {
      await registerFailedAttempt(challenge.id);
      await lockoutService.registerFailure(staff.email);
      throw new InvalidMfaCodeError();
    }
    // Un solo uso: dos envíos simultáneos del mismo desafío → solo uno obtiene sesión.
    if (!(await consumeToken(input.challengeToken, "mfa_challenge"))) throw new ApiError(401, MFA_STEP_EXPIRED);
    const session = await completeLogin(staff, client);
    return {
      session,
      usedBackupCode: !isTotp,
      backupCodesRemaining: isTotp ? undefined : await mfaService.remainingBackupCodes(staff.id),
    };
  },

  /** Enrolamiento obligatorio (admin) durante el login: genera el QR. Puede repetirse (nuevo secreto). */
  async startEnrollment(enrollmentToken: string) {
    const token = await findLiveToken(enrollmentToken, "mfa_enrollment");
    if (!token) throw new ApiError(401, MFA_STEP_EXPIRED);
    const staff = await staffOfToken(token.staffUserId);
    return mfaService.beginEnrollment(staff.id);
  },

  /** Confirma el enrolamiento con un código y ENTONCES entrega la sesión y los códigos de respaldo. */
  async confirmEnrollment(input: { enrollmentToken: string; code: string }, client: ClientInfo = {}) {
    const token = await findLiveToken(input.enrollmentToken, "mfa_enrollment");
    if (!token) throw new ApiError(401, MFA_STEP_EXPIRED);
    const staff = await staffOfToken(token.staffUserId);
    let backupCodes: string[];
    try {
      backupCodes = await mfaService.confirmEnrollment(staff.id, input.code);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 400) await registerFailedAttempt(token.id);
      throw err;
    }
    await consumeToken(input.enrollmentToken, "mfa_enrollment");
    const fresh = await prisma.staffUser.findUniqueOrThrow({ where: { id: staff.id } });
    return { session: await completeLogin(fresh, client), backupCodes };
  },
};
