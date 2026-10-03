import { z } from "zod";
import { cleanText } from "../../utils/schemas";

const roleSchema = z.enum(["admin", "agent"]);
const availabilitySchema = z.enum(["offline", "available", "busy", "away"]);

// .strict(): un campo no declarado es un 400, no se ignora en silencio. En
// particular "password": el admin NUNCA elige la contraseña de otra persona
// (bloque F2: la cuenta solo se obtiene completando una invitación).
export const inviteStaffSchema = z
  .object({
    name: cleanText(2, 150),
    email: z.string().trim().toLowerCase().email().max(254),
    role: roleSchema.default("agent"),
    maxConcurrent: z.number().int().min(1).max(20).default(3),
  })
  .strict();

export const updateStaffSchema = z
  .object({
    name: cleanText(2, 150).optional(),
    role: roleSchema.optional(),
    maxConcurrent: z.number().int().min(1).max(20).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: "No hay campos para actualizar" });

export const availabilitySchemaBody = z.object({ availability: availabilitySchema }).strict();

export type InviteStaffInput = z.infer<typeof inviteStaffSchema>;
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;
