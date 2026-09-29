import { z } from "zod";
import { cleanText, uuidSchema } from "../../utils/schemas";
import { paginationQuerySchema } from "../../utils/pagination";

/**
 * La sesión del widget es ANÓNIMA: solo se acepta un nombre para mostrar.
 * No se pide correo ni teléfono a propósito: no están verificados, y si se
 * usaran para "reconocer" a un cliente existente, cualquiera podría escribir
 * el correo de otra persona y ver sus conversaciones (suplantación). Los datos
 * de contacto los registra un agente, o llegarán con las cuentas de cliente.
 */
export const createSessionSchema = z
  .object({
    displayName: cleanText(1, 60).optional(),
  })
  .strict();

export const createConversationSchema = z
  .object({
    subject: cleanText(1, 200).optional(),
  })
  .strict();

export const customerMessageSchema = z
  .object({
    content: cleanText(1, 2_000),
    clientMsgId: uuidSchema.optional(),
  })
  .strict();

export const widgetMessagesQuerySchema = paginationQuerySchema.strict();

export type CustomerMessageInput = z.infer<typeof customerMessageSchema>;
