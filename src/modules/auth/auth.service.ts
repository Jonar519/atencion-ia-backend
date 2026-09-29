import bcrypt from "bcrypt";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { lockoutService } from "./lockout.service";
import { sessionsService } from "./sessions.service";

export const BCRYPT_COST = 10;

// Mismo mensaje para "no existe", "contraseña incorrecta" y "cuenta
// desactivada": no se revela qué correos tienen cuenta.
export const INVALID_CREDENTIALS = "Credenciales inválidas";

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

export const authService = {
  async login(input: { email: string; password: string }, userAgent?: string) {
    const email = normalizeEmail(input.email);

    const remaining = await lockoutService.remainingLockMs(email);
    if (remaining > 0) throw new AccountLockedError(remaining);

    const staff = await prisma.staffUser.findUnique({ where: { email } });
    const valid = await bcrypt.compare(input.password, staff?.passwordHash ?? DUMMY_HASH);
    if (!staff || !valid) {
      await lockoutService.registerFailure(email);
      throw new ApiError(401, INVALID_CREDENTIALS);
    }
    // Contraseña correcta pero cuenta desactivada: mismo 401, y no cuenta como fallo.
    if (!staff.isActive) throw new ApiError(401, INVALID_CREDENTIALS);

    await lockoutService.registerSuccess(email);
    await prisma.staffUser.update({ where: { id: staff.id }, data: { lastLoginAt: new Date() } });
    return sessionsService.start(staff, userAgent);
  },
};
