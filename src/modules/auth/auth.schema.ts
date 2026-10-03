import { z } from "zod";
import "../../utils/schemas";

// No hay registro público: la ÚNICA forma de tener cuenta es una invitación de
// un admin (POST /api/staff/invitations, bloque F2). Aquí se inicia sesión.
export const loginSchema = z
  .object({
    email: z.string().trim().email().max(254),
    // Sin aplicar la política aquí: el seed y cuentas antiguas pueden no cumplirla.
    password: z.string().min(1).max(200),
  })
  .strict();

// Tokens de un solo uso: base64url de 32 bytes (43 caracteres).
const oneTimeToken = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{43}$/, "Token inválido");

// 6 dígitos (app) o un código de respaldo ("abcd-efgh", con o sin guion).
const mfaCode = z
  .string()
  .trim()
  .regex(/^(\d{6}|[A-Za-z0-9]{4}-?[A-Za-z0-9]{4})$/, "Escribe los 6 dígitos de tu app o un código de respaldo");

const totpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Escribe los 6 dígitos de tu app");

export const mfaVerifySchema = z.object({ challengeToken: oneTimeToken, code: mfaCode }).strict();
export const enrollmentStartSchema = z.object({ enrollmentToken: oneTimeToken }).strict();
export const enrollmentConfirmSchema = z.object({ enrollmentToken: oneTimeToken, code: totpCode }).strict();

export const forgotPasswordSchema = z.object({ email: z.string().trim().email().max(254) }).strict();
// La política se aplica en el servicio (necesita el correo y el nombre de la cuenta).
export const resetPasswordSchema = z.object({ token: oneTimeToken, password: z.string().min(1).max(300) }).strict();
export const confirmEmailSchema = z.object({ token: oneTimeToken }).strict();

// Invitación (bloque F2). El token se valida laxo A PROPÓSITO: un enlace mal copiado recibe
// el mismo "invitación no válida" que uno vencido o usado (el servicio responde igual a todos).
const invitationToken = z.string().trim().min(1).max(100);
export const invitationInspectSchema = z.object({ token: invitationToken }).strict();
// La política se aplica en el servicio (necesita el correo y el nombre de la cuenta invitada).
export const invitationAcceptSchema = z
  .object({ token: invitationToken, password: z.string().min(1).max(300) })
  .strict();

export { totpCode };
