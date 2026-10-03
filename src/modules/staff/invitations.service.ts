import bcrypt from "bcrypt";
import { Prisma, type StaffRole } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { dbNow } from "../../utils/dbTime";
import { getEmail } from "../../services/email";
import { templates } from "../../services/email/templates";
import { BCRYPT_COST } from "../auth/passwordCheck";
import { passwordProblems } from "../auth/passwordPolicy";
import { consumeToken, findLiveToken, issueToken } from "../auth/singleUseTokens";

/**
 * ALTA DE ASESORES SOLO POR INVITACIÓN (bloque F2). No hay registro público ni
 * contraseñas que elija un admin: el admin invita (nombre, correo, rol), la
 * persona recibe un enlace de un solo uso (72 h) y elige SU contraseña.
 *
 *  - La cuenta invitada existe SIN contraseña e inactiva (la base lo impone,
 *    migración 018): no puede entrar ni recibir otros enlaces.
 *  - El enlace solo viaja por correo (en modo simulado, a email_outbox). La API
 *    NUNCA lo devuelve al admin: quien tuviera el enlace podría elegir la
 *    contraseña de otra persona.
 *  - Reenviar emite un enlace nuevo e invalida el anterior (uno vigente).
 *  - Cualquier enlace que no sirva (inventado, vencido, usado, cancelado o de
 *    una cuenta que ya no está pendiente) recibe el MISMO mensaje: no se
 *    revela si el correo existe ni en qué estado está.
 */
export const INVALID_INVITATION =
  "La invitación no es válida: venció, ya se usó o el enlace está incompleto. Pide a un administrador que te invite de nuevo.";

export interface InviteInput {
  name: string;
  email: string;
  role: StaffRole;
  maxConcurrent: number;
}

async function sendInvitation(staff: { id: string; email: string; name: string; role: StaffRole }) {
  const token = await issueToken(staff.id, "invitation");
  await getEmail().send(templates.invitation(staff.email, staff.id, token, { name: staff.name, role: staff.role }));
}

/** La cuenta pendiente de una invitación vigente, o null (sin distinguir por qué no sirve). */
async function pendingOf(rawToken: string | undefined) {
  const token = await findLiveToken(rawToken, "invitation");
  if (!token) return null;
  const staff = await prisma.staffUser.findUnique({ where: { id: token.staffUserId } });
  if (!staff || staff.passwordHash !== null || staff.deletedAt) return null;
  return staff;
}

export const invitationsService = {
  async invite(actorId: string, input: InviteInput) {
    let staff;
    try {
      staff = await prisma.staffUser.create({
        data: {
          name: input.name,
          email: input.email,
          passwordHash: null,
          role: input.role,
          maxConcurrent: input.maxConcurrent,
          isActive: false,
          availability: "offline",
          invitedAt: await dbNow(prisma),
          invitedById: actorId,
        },
        select: { id: true, name: true, email: true, role: true },
      });
    } catch (err) {
      // Solo el admin (de confianza) ve este 409: el invitado nunca ve nada sobre otros correos.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ApiError(409, "Ya existe una cuenta (o una invitación) con ese correo");
      }
      throw err;
    }
    await sendInvitation(staff);
    return staff;
  },

  /** Nuevo enlace (el anterior deja de servir). Solo para invitaciones pendientes. */
  async resend(id: string) {
    const staff = await prisma.staffUser.findUnique({ where: { id } });
    if (!staff) throw new ApiError(404, "Miembro del staff no encontrado");
    if (staff.passwordHash !== null || staff.deletedAt) {
      throw new ApiError(409, "Esa cuenta no tiene una invitación pendiente");
    }
    await sendInvitation(staff);
    return { id: staff.id };
  },

  /** Cancelar = borrar la cuenta pendiente (nunca se usó: no tiene historial). Sus enlaces se van con ella. */
  async cancel(id: string) {
    const deleted = await prisma.staffUser.deleteMany({ where: { id, passwordHash: null, deletedAt: null } });
    if (deleted.count === 0) {
      const exists = await prisma.staffUser.count({ where: { id } });
      throw exists
        ? new ApiError(409, "Esa cuenta no tiene una invitación pendiente")
        : new ApiError(404, "Miembro del staff no encontrado");
    }
  },

  /** Para la pantalla "Completa tu cuenta": a quién invitaron y si deberá activar la verificación en dos pasos. */
  async inspect(rawToken: string) {
    const staff = await pendingOf(rawToken);
    if (!staff) throw new ApiError(400, INVALID_INVITATION);
    return { name: staff.name, email: staff.email, role: staff.role, mfaRequired: staff.role === "admin" };
  },

  /**
   * Completa la cuenta con la contraseña que elige la persona. Una sola
   * transacción: consumir el enlace (un solo uso, aunque lleguen dos envíos a
   * la vez) y activar la cuenta. Si la contraseña no cumple la política, la
   * transacción se revierte y el enlace NO se gasta.
   */
  async accept(rawToken: string, password: string): Promise<string> {
    return prisma.$transaction(async (tx) => {
      const consumed = await consumeToken(rawToken, "invitation", tx);
      if (!consumed) throw new ApiError(400, INVALID_INVITATION);
      const staff = await tx.staffUser.findUnique({ where: { id: consumed.staffUserId } });
      if (!staff || staff.passwordHash !== null || staff.deletedAt) throw new ApiError(400, INVALID_INVITATION);
      const problems = passwordProblems(password, { email: staff.email, name: staff.name });
      if (problems.length) throw new ApiError(400, "La contraseña no cumple la política", problems);
      // Condicional: solo si sigue pendiente (una cuenta en uso nunca se "re-activa" con un enlace).
      const updated = await tx.staffUser.updateMany({
        where: { id: staff.id, passwordHash: null },
        data: {
          passwordHash: await bcrypt.hash(password, BCRYPT_COST),
          isActive: true,
          activatedAt: await dbNow(tx),
        },
      });
      if (updated.count !== 1) throw new ApiError(400, INVALID_INVITATION);
      return staff.id;
    });
  },
};
