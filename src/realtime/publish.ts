import { prisma } from "../config/prisma";
import { logger } from "../config/logger";
import { publishRealtime } from "./bus";
import type { ConversationRef, RealtimeMessage } from "./events";

/**
 * Publicación de eventos a partir de lo que YA quedó guardado en la base
 * (se llama después de confirmar la transacción). Lee el estado actual de la
 * conversación para que el reparto por destinatario use datos frescos.
 */

async function conversationRef(conversationId: string): Promise<ConversationRef | null> {
  return prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, customerId: true, status: true, assignedAgentId: true, priority: true },
  });
}

export async function publishMessagesCreated(conversationId: string, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  try {
    const conversation = await conversationRef(conversationId);
    if (!conversation) return;
    const rows = await prisma.message.findMany({
      where: { id: { in: messageIds }, conversationId },
      select: {
        id: true,
        conversationId: true,
        senderType: true,
        channel: true,
        content: true,
        createdAt: true,
        clientMsgId: true,
        intent: true,
        sentiment: true,
        senderAgent: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const row of rows) {
      const message: RealtimeMessage = {
        id: row.id,
        conversationId: row.conversationId,
        senderType: row.senderType,
        channel: row.channel,
        content: row.content,
        createdAt: row.createdAt.toISOString(),
        clientMsgId: row.clientMsgId,
        agent: row.senderAgent,
        intent: row.intent,
        sentiment: row.sentiment,
      };
      await publishRealtime({ type: "message.created", conversation, message });
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "No se pudieron publicar los mensajes");
  }
}

export async function publishConversationUpdated(
  conversationId: string,
  previous: Pick<ConversationRef, "status" | "assignedAgentId"> | null
): Promise<void> {
  try {
    const conversation = await conversationRef(conversationId);
    if (!conversation) return;
    await publishRealtime({ type: "conversation.updated", conversation, previous });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "No se pudo publicar el cambio de estado");
  }
}

export async function publishCallUpdated(callId: string): Promise<void> {
  try {
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: { id: true, status: true, endReason: true, handledByAgentId: true, conversationId: true },
    });
    if (!call) return;
    const conversation = await conversationRef(call.conversationId);
    if (!conversation) return;
    const { conversationId: _conversationId, ...ref } = call;
    await publishRealtime({ type: "call.updated", conversation, call: ref });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "No se pudo publicar el estado de la llamada"
    );
  }
}

/** Transcripción parcial en vivo (no se guarda). Lee el estado ACTUAL del caso: decide quién la ve. */
export async function publishTranscriptPartial(
  conversationId: string,
  callId: string,
  speaker: "customer" | "agent",
  text: string
): Promise<void> {
  try {
    const conversation = await conversationRef(conversationId);
    if (!conversation) return;
    await publishRealtime({ type: "call.transcript.partial", conversation, callId, speaker, text });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "No se pudo publicar la transcripción parcial"
    );
  }
}
