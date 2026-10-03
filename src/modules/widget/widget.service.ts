import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { ApiError } from "../../utils/apiError";
import { sha256, hashIp } from "../../utils/hash";
import { afterCursor, toPage, type Page } from "../../utils/pagination";
import { handleCustomerTurn, PUBLIC_MESSAGE_FIELDS, type PublicMessage } from "../engine/conversationEngine";
import { newWidgetToken, type WidgetIdentity } from "./widgetAuth.middleware";
import type { CustomerMessageInput } from "./widget.schema";
import { discardAttachment, storeAttachment } from "../attachments/attachments.service";
import { ATTACHMENT_PLACEHOLDER } from "../attachments/fileChecks";

/** Conversaciones abiertas simultáneas por cliente (evita abrir cientos para multiplicar el cupo). */
export const MAX_OPEN_CONVERSATIONS = 3;

const NOT_FOUND = "Conversación no encontrada";

/**
 * Lo que el cliente ve de un mensaje. NO incluye el análisis de IA sobre él
 * (intención, sentimiento), ni ids internos del staff: del agente, solo el
 * nombre de pila.
 */
function toCustomerView(message: PublicMessage) {
  return {
    id: message.id,
    sender: message.senderType,
    content: message.content,
    channel: message.channel,
    createdAt: message.createdAt,
    clientMsgId: message.clientMsgId,
    agentName: message.senderAgent ? (message.senderAgent.name.trim().split(/\s+/)[0] ?? null) : null,
    attachment: message.attachments[0] ?? null,
  };
}

/** Carga una conversación SOLO si es de este cliente; si no, 404 (no revela que existe). */
async function ownConversation(identity: WidgetIdentity, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, customerId: identity.customerId },
    select: { id: true, status: true, subject: true, createdAt: true, lastMessageAt: true },
  });
  if (!conversation) throw new ApiError(404, NOT_FOUND);
  return conversation;
}

export const widgetService = {
  async createSession(input: { displayName?: string }, meta: { ip?: string; userAgent?: string }) {
    const token = newWidgetToken();
    const expiresAt = new Date(Date.now() + env.widgetSessionTtlHours * 3_600_000);
    const customer = await prisma.customer.create({
      data: {
        displayName: input.displayName ?? null,
        widgetSessions: {
          create: {
            tokenHash: sha256(token),
            expiresAt,
            userAgent: meta.userAgent?.slice(0, 200) ?? null,
            ipHash: hashIp(meta.ip),
          },
        },
      },
      select: { id: true },
    });
    // El token se entrega UNA vez; en la base queda solo su hash.
    return { token, customerId: customer.id, expiresAt };
  },

  async createConversation(identity: WidgetIdentity, input: { subject?: string }) {
    const open = await prisma.conversation.count({
      where: { customerId: identity.customerId, status: { not: "closed" } },
    });
    if (open >= MAX_OPEN_CONVERSATIONS) {
      throw new ApiError(409, `Ya tienes ${open} conversaciones abiertas. Continúa en una de ellas.`);
    }
    return prisma.conversation.create({
      data: { customerId: identity.customerId, originChannel: "text", subject: input.subject ?? null },
      select: { id: true, status: true, subject: true, createdAt: true },
    });
  },

  async sessionInfo(identity: WidgetIdentity) {
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: identity.customerId },
      select: { id: true, displayName: true },
    });
    return { customerId: customer.id, displayName: customer.displayName, expiresAt: identity.expiresAt };
  },

  async endSession(identity: WidgetIdentity) {
    await prisma.widgetSession.update({ where: { id: identity.sessionId }, data: { revokedAt: new Date() } });
  },

  async listConversations(identity: WidgetIdentity) {
    return prisma.conversation.findMany({
      where: { customerId: identity.customerId },
      select: { id: true, status: true, subject: true, createdAt: true, lastMessageAt: true },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: 20,
    });
  },

  async messages(identity: WidgetIdentity, conversationId: string, query: { limit: number; cursor?: string }) {
    await ownConversation(identity, conversationId);
    const rows = await prisma.message.findMany({
      where: { conversationId, ...afterCursor("createdAt", query.cursor) },
      select: PUBLIC_MESSAGE_FIELDS,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
    });
    const page: Page<PublicMessage> = toPage(rows, query.limit, (row) => row.createdAt);
    return { items: page.items.reverse().map(toCustomerView), nextCursor: page.nextCursor };
  },

  async sendMessage(identity: WidgetIdentity, conversationId: string, input: CustomerMessageInput) {
    const result = await handleCustomerTurn({
      conversationId,
      customerId: identity.customerId,
      content: input.content,
      channel: "text",
      clientMsgId: input.clientMsgId ?? null,
    });
    return this.turnResponse(result);
  },

  /**
   * Mensaje con ADJUNTO (imagen o PDF, bloque C). Se valida y guarda el
   * archivo, y el turno pasa por el MISMO motor que un mensaje de texto. A la
   * IA solo le llega la señal del adjunto + el comentario (textForAi).
   * Si el turno no llega a guardarse (conversación cerrada, tope de IA,
   * reenvío duplicado), el archivo se borra: no quedan huérfanos.
   */
  async sendAttachment(
    identity: WidgetIdentity,
    conversationId: string,
    input: { data: unknown; fileName?: string; caption?: string; clientMsgId?: string }
  ) {
    const conversation = await ownConversation(identity, conversationId);
    if (conversation.status === "closed") throw new ApiError(409, "La conversación está cerrada. Inicia una nueva.");
    const stored = await storeAttachment({ conversationId, data: input.data, declaredName: input.fileName });
    let result: Awaited<ReturnType<typeof handleCustomerTurn>>;
    try {
      result = await handleCustomerTurn({
        conversationId,
        customerId: identity.customerId,
        content: input.caption ?? ATTACHMENT_PLACEHOLDER,
        channel: "text",
        clientMsgId: input.clientMsgId ?? null,
        attachment: stored,
      });
    } catch (err) {
      await discardAttachment(stored);
      throw err;
    }
    if (result.duplicate) await discardAttachment(stored);
    return this.turnResponse(result);
  },

  turnResponse(result: Awaited<ReturnType<typeof handleCustomerTurn>>) {
    return {
      message: toCustomerView(result.customerMessage),
      reply: result.reply ? toCustomerView(result.reply) : null,
      conversationStatus: result.conversationStatus,
      // Al cliente solo le importa si lo van a atender personas (no el motivo interno).
      handedOffToAgent: result.escalation !== null || result.conversationStatus !== "ai_active",
      duplicate: result.duplicate,
    };
  },
};
