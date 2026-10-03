import { z } from "zod";
import { cleanText } from "../../utils/schemas";

// Mismo patrón que la base (migración 016): minúsculas, números y guiones.
const shortcut = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(30)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Solo minúsculas, números y guiones (ej. bloqueo-tarjeta)");

export const createCannedSchema = z
  .object({
    title: cleanText(2, 80),
    body: cleanText(1, 2000),
    shortcut: shortcut.nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .strict();

export const updateCannedSchema = z
  .object({
    title: cleanText(2, 80).optional(),
    body: cleanText(1, 2000).optional(),
    shortcut: shortcut.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: "No hay campos para actualizar" });

export const listCannedQuerySchema = z
  .object({
    // Solo admin: incluir las desactivadas (para administrarlas).
    includeInactive: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

export type CreateCannedInput = z.infer<typeof createCannedSchema>;
export type UpdateCannedInput = z.infer<typeof updateCannedSchema>;
