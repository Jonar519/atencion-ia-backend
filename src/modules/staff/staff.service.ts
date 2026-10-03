import { randomBytes } from "crypto";
import bcrypt from "bcrypt";
import { Prisma, type AgentAvailability } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { BCRYPT_COST } from "../auth/auth.service";
import { sessionsService } from "../auth/sessions.service";
import { lockoutService } from "../auth/lockout.service";
import { getStorage } from "../../services/storage";
import { logger } from "../../config/logger";
import type { CreateStaffInput, UpdateStaffInput } from "./staff.schema";

// Lo que la API expone de un miembro del staff. NUNCA el passwordHash.
const PUBLIC_FIELDS = {
  id: true,
  name: true,
  email: true,
  role: true,
  availability: true,
  maxConcurrent: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  deletedAt: true,
} satisfies Prisma.StaffUserSelect;

export const staffService = {
  /** Lista del equipo (admin), con cuántos casos atiende cada uno ahora (para reasignar antes de eliminar). */
  async list() {
    const rows = await prisma.staffUser.findMany({
      select: {
        ...PUBLIC_FIELDS,
        _count: { select: { assignedConversations: { where: { status: "agent_active" } } } },
      },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    });
    return rows.map(({ _count, ...staff }) => ({ ...staff, activeConversations: _count.assignedConversations }));
  },

  async getPublic(id: string) {
    const staff = await prisma.staffUser.findUnique({ where: { id }, select: PUBLIC_FIELDS });
    if (!staff) throw new ApiError(404, "Miembro del staff no encontrado");
    return staff;
  },

  async create(input: CreateStaffInput) {
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
    try {
      return await prisma.staffUser.create({
        data: {
          name: input.name,
          email: input.email,
          passwordHash,
          role: input.role,
          maxConcurrent: input.maxConcurrent,
        },
        select: PUBLIC_FIELDS,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ApiError(409, "Ya existe un miembro del staff con ese correo");
      }
      throw err;
    }
  },

  /**
   * Un admin no puede quitarse a sí mismo el rol de admin ni desactivarse:
   * así nunca se queda la plataforma sin nadie que pueda administrarla por
   * un clic equivocado. Desactivar a alguien cierra todas sus sesiones.
   */
  async update(actorId: string, id: string, input: UpdateStaffInput) {
    if (actorId === id && (input.isActive === false || input.role === "agent")) {
      throw new ApiError(409, "No puedes desactivarte ni quitarte el rol de administrador a ti mismo");
    }
    const target = await this.getPublic(id);
    // Una cuenta anonimizada es definitiva: no se reactiva ni se edita (la base también lo impide).
    if (target.deletedAt) throw new ApiError(409, "La cuenta fue eliminada (anonimizada) y no se puede modificar");
    const updated = await prisma.staffUser.update({
      where: { id },
      data: {
        ...input,
        // Un agente desactivado deja de aparecer como disponible para escalamientos.
        ...(input.isActive === false ? { availability: "offline" as const } : {}),
      },
      select: PUBLIC_FIELDS,
    });
    if (input.isActive === false || input.role !== undefined) await sessionsService.revokeAllFor(id);
    return updated;
  },

  async setAvailability(id: string, availability: AgentAvailability) {
    return prisma.staffUser.update({ where: { id }, data: { availability }, select: PUBLIC_FIELDS });
  },

  /**
   * "Eliminar" la cuenta de un AGENTE = anonimizarla (docs/data-retention.md).
   * No se borra la fila: sus mensajes, llamadas y la auditoría la referencian
   * (FK RESTRICT) y son registro del banco. Se borra todo lo PERSONAL: nombre,
   * correo, teléfono, avatar, secreto MFA, códigos, tokens y sesiones.
   *
   * Requisito: no puede tener conversaciones en curso ni estar en una llamada
   * (hay que reasignarlas antes, POST /api/conversations/:id/reassign). La
   * comprobación se repite DENTRO de la transacción con la fila bloqueada:
   * un "tomar" simultáneo espera y luego ve la cuenta desactivada.
   */
  async anonymize(actorId: string, id: string) {
    if (actorId === id) throw new ApiError(409, "No puedes eliminar tu propia cuenta");
    const result = await prisma.$transaction(async (tx) => {
      const [staff] = await tx.$queryRaw<
        { role: string; email: string; deleted_at: Date | null; avatar_storage_key: string | null }[]
      >`SELECT role, email, deleted_at, avatar_storage_key FROM staff_users WHERE id = ${id}::uuid FOR UPDATE`;
      if (!staff) throw new ApiError(404, "Miembro del staff no encontrado");
      if (staff.deleted_at) throw new ApiError(409, "La cuenta ya fue eliminada");
      if (staff.role !== "agent") {
        throw new ApiError(409, "Solo se eliminan cuentas de agente. Quítale el rol de administrador primero.");
      }
      const [active, inCall] = await Promise.all([
        tx.conversation.count({ where: { assignedAgentId: id, status: "agent_active" } }),
        tx.callParticipant.count({ where: { agentId: id, leftAt: null } }),
      ]);
      if (active > 0 || inCall > 0) {
        throw new ApiError(
          409,
          "El agente tiene casos en curso. Reasígnalos (o ciérralos) antes de eliminar la cuenta.",
          { activeConversations: active, activeCalls: inCall }
        );
      }
      const shortId = id.slice(0, 8);
      await tx.staffUser.update({
        where: { id },
        data: {
          name: `Agente eliminado ${shortId}`,
          email: `eliminado-${id}@anonimizado.invalid`,
          // Contraseña imposible: nadie la conoce y la cuenta queda inactiva.
          passwordHash: await bcrypt.hash(randomBytes(32).toString("hex"), BCRYPT_COST),
          phone: null,
          avatarStorageKey: null,
          mfaSecretEncrypted: null,
          mfaEnabledAt: null,
          mfaLastUsedStep: null,
          isActive: false,
          availability: "offline",
          deletedAt: new Date(),
        },
      });
      await tx.mfaBackupCode.deleteMany({ where: { staffUserId: id } });
      await tx.staffToken.deleteMany({ where: { staffUserId: id } });
      // Sesiones: se cierran todas y se borra desde dónde se conectaba.
      await tx.refreshToken.updateMany({
        where: { staffUserId: id, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: "account_deleted" },
      });
      await tx.refreshToken.updateMany({
        where: { staffUserId: id },
        data: { userAgent: null, ipAddress: null, locationLabel: null },
      });
      // Los correos simulados contienen su dirección: se borran con la cuenta.
      await tx.emailOutbox.deleteMany({ where: { relatedStaffId: id } });
      return { previousEmail: staff.email, avatarKey: staff.avatar_storage_key };
    });
    await lockoutService.registerSuccess(result.previousEmail);
    if (result.avatarKey) {
      await getStorage()
        .delete(result.avatarKey)
        .catch((err: unknown) =>
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, "No se pudo borrar el avatar")
        );
    }
    return this.getPublic(id);
  },
};
