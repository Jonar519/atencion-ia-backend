import { z } from "zod";
import { cleanText } from "../../utils/schemas";
import { PASSWORD_MAX_LENGTH } from "../auth/passwordPolicy";
import { totpCode } from "../auth/auth.schema";

// Mismo patrón que chk_staff_users_phone (migración 015): +, dígitos, espacios, guiones y paréntesis.
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()-]{6,29}$/, "Teléfono inválido (ej.: +57 300 123 4567)");

export const updateProfileSchema = z
  .object({
    name: cleanText(2, 150).optional(),
    // null (o "") borra el teléfono.
    phone: z.union([phone, z.literal("").transform(() => null), z.null()]).optional(),
    // Sin "theme": el tema lo decide el sistema operativo (migración 019); .strict() lo rechaza con 400.
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: "No hay campos para actualizar" });

export const changeEmailSchema = z
  .object({
    newEmail: z.string().trim().toLowerCase().email().max(254),
    currentPassword: z.string().min(1).max(300),
  })
  .strict();

// La política (largo, comunes, correo/nombre) se aplica en el servicio.
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(300),
    newPassword: z
      .string()
      .min(1)
      .max(PASSWORD_MAX_LENGTH * 4),
  })
  .strict();

export const mfaCodeSchema = z.object({ code: totpCode }).strict();
export const mfaDisableSchema = z.object({ password: z.string().min(1).max(300), code: totpCode }).strict();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
