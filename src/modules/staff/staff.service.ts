import bcrypt from "bcrypt";
import { Prisma, type AgentAvailability } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { BCRYPT_COST } from "../auth/auth.service";
import { sessionsService } from "../auth/sessions.service";
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
} satisfies Prisma.StaffUserSelect;

export const staffService = {
  async list() {
    return prisma.staffUser.findMany({ select: PUBLIC_FIELDS, orderBy: [{ isActive: "desc" }, { name: "asc" }] });
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
    await this.getPublic(id);
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
};
