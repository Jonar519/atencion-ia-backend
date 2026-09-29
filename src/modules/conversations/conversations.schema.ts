import { z } from "zod";
import { cleanText, uuidSchema } from "../../utils/schemas";
import { paginationQuerySchema } from "../../utils/pagination";

const statusSchema = z.enum(["ai_active", "waiting_agent", "agent_active", "closed"]);

export const listConversationsQuerySchema = paginationQuerySchema
  .extend({
    // mine: asignadas a mí · queue: cola general · all: todas (solo admin).
    // Por defecto: "mine" para un agente, "all" para un admin.
    scope: z.enum(["mine", "queue", "all"]).optional(),
    status: statusSchema.optional(),
  })
  .strict();

export const messagesQuerySchema = paginationQuerySchema.strict();

export const closeConversationSchema = z
  .object({
    reason: z.enum(["resolved_by_agent", "customer_abandoned", "inactivity", "spam"]).default("resolved_by_agent"),
    note: cleanText(1, 500).optional(),
  })
  .strict();

export const sendMessageSchema = z
  .object({
    content: cleanText(1, 4000),
    // UUID generado por el cliente: un reenvío (reconexión, doble clic) no duplica el mensaje.
    clientMsgId: uuidSchema.optional(),
  })
  .strict();

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;
export type MessagesQuery = z.infer<typeof messagesQuerySchema>;
export type CloseConversationInput = z.infer<typeof closeConversationSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
