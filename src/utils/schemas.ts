import { z } from "zod";
import { isUuid } from "./uuid";

// Piezas de validación compartidas por los *.schema.ts de cada módulo.

// Mensajes de error de zod en español (los consumidores de la API los ven en
// `details`). Los mensajes personalizados de cada schema tienen prioridad.
z.setErrorMap((issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return { message: issue.received === "undefined" ? "Campo requerido" : `Se esperaba ${issue.expected}` };
    case z.ZodIssueCode.too_small:
      return {
        message:
          issue.type === "string"
            ? `Debe tener al menos ${issue.minimum} caracteres`
            : issue.type === "array"
              ? `Debe tener al menos ${issue.minimum} elementos`
              : `Debe ser mayor o igual a ${issue.minimum}`,
      };
    case z.ZodIssueCode.too_big:
      return {
        message:
          issue.type === "string"
            ? `Debe tener como máximo ${issue.maximum} caracteres`
            : issue.type === "array"
              ? `Debe tener como máximo ${issue.maximum} elementos`
              : `Debe ser menor o igual a ${issue.maximum}`,
      };
    case z.ZodIssueCode.invalid_string:
      return { message: issue.validation === "email" ? "Correo electrónico inválido" : "Formato inválido" };
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `Valor no permitido. Opciones: ${issue.options.join(", ")}` };
    case z.ZodIssueCode.unrecognized_keys:
      return { message: `Campos no permitidos: ${issue.keys.join(", ")}` };
    default:
      return { message: ctx.defaultError };
  }
});

export const uuidSchema = z.string().refine(isUuid, { message: "Debe ser un UUID válido" });

export function uuidParams<K extends string>(key: K) {
  return z.object({ [key]: uuidSchema } as Record<K, typeof uuidSchema>).strict();
}

const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]); // tabulación, salto de línea, retorno de carro

/**
 * true si el texto tiene caracteres de control (U+0000–U+001F y U+007F) que no
 * sean tabulación o saltos de línea. Un NUL rompe Postgres ("invalid byte
 * sequence") y los demás sirven para esconder texto en la UI o en los logs.
 */
export function hasForbiddenControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && !ALLOWED_CONTROL.has(code)) || code === 0x7f) return true;
  }
  return false;
}

/** Texto libre: sin espacios sobrantes y sin caracteres de control (salvo saltos de línea y tabulaciones). */
export function cleanText(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !hasForbiddenControlChars(value), { message: "Contiene caracteres de control no permitidos" });
}
