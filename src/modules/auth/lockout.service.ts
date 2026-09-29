import { prisma } from "../../config/prisma";
import { sha256 } from "../../utils/hash";

/**
 * Bloqueo progresivo tras logins fallidos, POR CUENTA. (Por IP lo hace el
 * rate limiter: 10 intentos fallidos / 15 min.)
 *
 * La clave es el SHA-256 del correo normalizado y se lleva igual para correos
 * que NO existen: el bloqueo se comporta idéntico en ambos casos y no revela
 * qué cuentas existen (ni guarda el correo en claro).
 *
 * Esquema: los primeros FREE_ATTEMPTS fallos no bloquean; a partir de ahí
 * cada fallo bloquea 1, 2, 4, 8… minutos, con tope de MAX_LOCK_MINUTES. Un
 * login exitoso borra el contador.
 */
export const FREE_ATTEMPTS = 5;
export const MAX_LOCK_MINUTES = 60;

const keyFor = (email: string) => sha256(email);

export function lockMinutesFor(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(2 ** (failures - FREE_ATTEMPTS), MAX_LOCK_MINUTES);
}

export const lockoutService = {
  /** Milisegundos que faltan de bloqueo (0 si no está bloqueada). */
  async remainingLockMs(email: string, now = new Date()): Promise<number> {
    const attempt = await prisma.loginAttempt.findUnique({ where: { keyHash: keyFor(email) } });
    if (!attempt?.lockedUntil) return 0;
    return Math.max(0, attempt.lockedUntil.getTime() - now.getTime());
  },

  async registerFailure(email: string, now = new Date()): Promise<void> {
    const keyHash = keyFor(email);
    // upsert atómico del contador; luego se calcula el bloqueo con el valor real.
    const attempt = await prisma.loginAttempt.upsert({
      where: { keyHash },
      create: { keyHash, failures: 1, lastFailure: now },
      update: { failures: { increment: 1 }, lastFailure: now },
    });
    const minutes = lockMinutesFor(attempt.failures);
    if (minutes > 0) {
      await prisma.loginAttempt.update({
        where: { keyHash },
        data: { lockedUntil: new Date(now.getTime() + minutes * 60_000) },
      });
    }
  },

  async registerSuccess(email: string): Promise<void> {
    await prisma.loginAttempt.deleteMany({ where: { keyHash: keyFor(email) } });
  },
};
