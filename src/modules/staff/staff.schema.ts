import { z } from "zod";
import { cleanText } from "../../utils/schemas";
import { PASSWORD_MAX_LENGTH, passwordProblems } from "../auth/passwordPolicy";

const roleSchema = z.enum(["admin", "agent"]);
const availabilitySchema = z.enum(["offline", "available", "busy", "away"]);

// .strict(): un campo no declarado (p. ej. "passwordHash" o "isActive" donde
// no corresponde) es un 400, no se ignora en silencio.
export const createStaffSchema = z
  .object({
    name: cleanText(2, 150),
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().max(PASSWORD_MAX_LENGTH * 4),
    role: roleSchema.default("agent"),
    maxConcurrent: z.number().int().min(1).max(20).default(3),
  })
  .strict()
  .superRefine((data, ctx) => {
    for (const message of passwordProblems(data.password, { email: data.email, name: data.name })) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["password"], message });
    }
  });

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

export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;
