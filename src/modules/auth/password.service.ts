import bcrypt from "bcrypt";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { ApiError } from "../../utils/apiError";
import { getEmail } from "../../services/email";
import { templates } from "../../services/email/templates";
import { BCRYPT_COST, normalizeEmail } from "./auth.service";
import { lockoutService } from "./lockout.service";
import { passwordProblems } from "./passwordPolicy";
import { sessionsService } from "./sessions.service";
import { consumeToken, issueToken } from "./singleUseTokens";

/**
 * Recuperar la contraseña del staff.
 *
 *  - /forgot-password responde SIEMPRE lo mismo y EN EL ACTO, exista o no el
 *    correo: el trabajo (buscar la cuenta, emitir el token, "enviar" el correo)
 *    se hace después de responder. Así ni el cuerpo ni el tiempo de respuesta
 *    revelan qué correos tienen cuenta.
 *  - El enlace vence en 15 min, sirve UNA vez y pedir otro invalida el anterior.
 *  - Restablecer cierra TODAS las sesiones de la cuenta y limpia el bloqueo
 *    por intentos fallidos. NO desactiva el MFA: quien restablece con acceso al
 *    correo todavía necesita el segundo factor para entrar.
 */
export const RESET_REQUESTED =
  "Si el correo corresponde a una cuenta activa, te enviamos un enlace para restablecer la contraseña. Revisa tu bandeja.";

const pending = new Set<Promise<void>>();

async function processResetRequest(rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const staff = await prisma.staffUser.findUnique({
    where: { email },
    select: { id: true, email: true, isActive: true, deletedAt: true },
  });
  if (!staff || !staff.isActive || staff.deletedAt) return;
  const token = await issueToken(staff.id, "password_reset");
  await getEmail().send(templates.passwordReset(staff.email, staff.id, token));
}

export const passwordService = {
  /** No espera el trabajo: la respuesta es idéntica e inmediata para cualquier correo. */
  requestReset(email: string): void {
    const work = processResetRequest(email)
      .catch((err: unknown) =>
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "No se pudo procesar la recuperación")
      )
      .finally(() => pending.delete(work));
    pending.add(work);
  },

  /** Solo tests (y apagado ordenado): espera las solicitudes en curso. */
  async flush(): Promise<void> {
    await Promise.all([...pending]);
  },

  async reset(token: string, newPassword: string): Promise<string> {
    const staffId = await prisma.$transaction(async (tx) => {
      const consumed = await consumeToken(token, "password_reset", tx);
      if (!consumed) throw new ApiError(400, "El enlace no es válido, ya se usó o venció. Pide uno nuevo.");
      const staff = await tx.staffUser.findUniqueOrThrow({
        where: { id: consumed.staffUserId },
        select: { id: true, email: true, name: true, isActive: true },
      });
      if (!staff.isActive) throw new ApiError(400, "El enlace no es válido, ya se usó o venció. Pide uno nuevo.");
      const problems = passwordProblems(newPassword, { email: staff.email, name: staff.name });
      // Si la contraseña no cumple, el token NO se gasta (la transacción se revierte).
      if (problems.length) throw new ApiError(400, "La contraseña no cumple la política", problems);
      await tx.staffUser.update({
        where: { id: staff.id },
        data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_COST) },
      });
      return staff.id;
    });
    const staff = await prisma.staffUser.findUniqueOrThrow({ where: { id: staffId }, select: { email: true } });
    await sessionsService.revokeAllFor(staffId, "password_reset");
    await lockoutService.registerSuccess(staff.email);
    await getEmail().send(templates.passwordChanged(staff.email, staffId));
    return staffId;
  },
};
