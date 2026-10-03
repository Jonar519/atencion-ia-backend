import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import type { CreateCannedInput, UpdateCannedInput } from "./canned.schema";

/**
 * Respuestas predefinidas. Las crea y edita un admin; cualquier miembro del
 * staff lee las ACTIVAS para insertarlas en su caja de texto. No se envían
 * solas: el asesor las revisa y las manda como un mensaje suyo.
 */
const FIELDS = {
  id: true,
  title: true,
  body: true,
  shortcut: true,
  isActive: true,
  updatedAt: true,
} satisfies Prisma.CannedResponseSelect;

function conflict(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    throw new ApiError(409, "Ya existe una respuesta con ese título o ese atajo");
  }
  throw err;
}

export const cannedService = {
  async list({ includeInactive = false }: { includeInactive?: boolean } = {}) {
    const items = await prisma.cannedResponse.findMany({
      where: includeInactive ? {} : { isActive: true },
      select: FIELDS,
      orderBy: [{ isActive: "desc" }, { title: "asc" }],
    });
    return { items };
  },

  async create(actorId: string, input: CreateCannedInput) {
    return prisma.cannedResponse
      .create({ data: { ...input, createdBy: actorId, updatedBy: actorId }, select: FIELDS })
      .catch(conflict);
  },

  async update(actorId: string, id: string, input: UpdateCannedInput) {
    const { count } = await prisma.cannedResponse
      .updateMany({ where: { id }, data: { ...input, updatedBy: actorId } })
      .catch(conflict);
    if (count === 0) throw new ApiError(404, "Respuesta no encontrada");
    return prisma.cannedResponse.findUniqueOrThrow({ where: { id }, select: FIELDS });
  },

  async remove(id: string) {
    const { count } = await prisma.cannedResponse.deleteMany({ where: { id } });
    if (count === 0) throw new ApiError(404, "Respuesta no encontrada");
  },
};
