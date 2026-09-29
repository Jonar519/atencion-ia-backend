import { Prisma, type ChannelType, type ConversationStatus } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { engineTurns } from "../../observability/metrics";
import { AiRefusalError, getAi, type Classification, type KbContextChunk } from "../../services/ai";
import { ApiError } from "../../utils/apiError";
import { retrieveKnowledge } from "../rag/rag.service";
import { assertWithinBudget, usageRows, type UsageRecord } from "./budget.service";
import { decideEscalation, handoffMessage, type EscalationDecision } from "./escalationRules";
import { escalate } from "./escalation.service";
import { loadHistory } from "./history";
import { publishConversationUpdated, publishMessagesCreated } from "../../realtime/publish";

/**
 * MOTOR CONVERSACIONAL: procesa UN turno del cliente, venga de donde venga.
 *
 * No depende del canal: el widget de texto lo llama con channel "text" y, en
 * la Fase 5, la transcripción de voz lo llamará con channel "voice" y el id de
 * la llamada, una vez por cada segmento final transcrito. Misma función, mismo
 * RAG, mismas reglas de escalamiento.
 *
 * Pasos:
 *  1. Idempotencia por clientMsgId (un reenvío no se procesa dos veces).
 *  2. Tope diario de IA del cliente.
 *  3. Clasificación del turno (intención, sentimiento) → se guarda con el mensaje.
 *  4. Si la conversación está con la IA: RAG (solo la KB publicada) + historial
 *     de ESTA conversación → respuesta.
 *  5. Reglas de escalamiento. Si corresponde: escalamiento (sin duplicados),
 *     mensaje de traspaso y aviso a los agentes.
 *  Si la conversación ya está con un humano, el mensaje solo se guarda
 *  (clasificado) para el agente: la IA no interviene.
 *
 * Las llamadas a la IA ocurren FUERA de transacciones (pueden tardar segundos);
 * cada escritura es atómica por separado.
 */

export interface CustomerTurnInput {
  conversationId: string;
  /** Dueño de la conversación según la sesión del widget (o de la llamada, en voz). */
  customerId: string;
  content: string;
  channel: ChannelType;
  /** Obligatorio si channel = "voice": la llamada de esta conversación. */
  callId?: string | null;
  clientMsgId?: string | null;
}

const PUBLIC_MESSAGE_FIELDS = {
  id: true,
  senderType: true,
  channel: true,
  content: true,
  createdAt: true,
  clientMsgId: true,
  senderAgent: { select: { name: true } },
} satisfies Prisma.MessageSelect;

export type PublicMessage = Prisma.MessageGetPayload<{ select: typeof PUBLIC_MESSAGE_FIELDS }>;

export interface TurnResult {
  customerMessage: PublicMessage;
  /** Respuesta de la IA o mensaje de traspaso; null si la atiende un humano o era un reenvío. */
  reply: PublicMessage | null;
  conversationStatus: ConversationStatus;
  escalation: { created: boolean; reason: string } | null;
  duplicate: boolean;
}

export { PUBLIC_MESSAGE_FIELDS };

export async function handleCustomerTurn(input: CustomerTurnInput): Promise<TurnResult> {
  if (input.channel === "voice" && !input.callId) throw new ApiError(400, "Un turno de voz requiere la llamada");

  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, customerId: input.customerId },
    select: { id: true, status: true },
  });
  // Mismo 404 exista o no: un cliente no puede sondear conversaciones ajenas.
  if (!conversation) throw new ApiError(404, "Conversación no encontrada");
  if (conversation.status === "closed") throw new ApiError(409, "La conversación está cerrada. Inicia una nueva.");

  // 1. Idempotencia.
  if (input.clientMsgId) {
    const existing = await prisma.message.findUnique({
      where: { conversationId_clientMsgId: { conversationId: conversation.id, clientMsgId: input.clientMsgId } },
      select: PUBLIC_MESSAGE_FIELDS,
    });
    if (existing) {
      engineTurns.inc({ channel: input.channel, outcome: "duplicate" });
      return {
        customerMessage: existing,
        reply: null,
        conversationStatus: conversation.status,
        escalation: null,
        duplicate: true,
      };
    }
  }

  // 2. Tope diario (antes de gastar un solo token).
  await assertWithinBudget(input.customerId);

  const ai = getAi();
  const usage: UsageRecord[] = [];

  // 3. Clasificación. Si falla, el turno sigue sin análisis (no se pierde el mensaje).
  let classification: Classification | null = null;
  try {
    const result = await ai.classifier.classify(input.content);
    classification = { intent: result.intent, sentiment: result.sentiment, confidence: result.confidence };
    usage.push({ kind: "classification", model: result.model, usage: result.usage });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.name : String(err) }, "Clasificación no disponible para el turno");
  }

  const customerMessage = await saveCustomerMessage(input, classification);
  if (!customerMessage) {
    // Carrera: el mismo clientMsgId llegó dos veces a la vez y ganó el otro.
    const winner = await prisma.message.findUniqueOrThrow({
      where: { conversationId_clientMsgId: { conversationId: conversation.id, clientMsgId: input.clientMsgId! } },
      select: PUBLIC_MESSAGE_FIELDS,
    });
    return {
      customerMessage: winner,
      reply: null,
      conversationStatus: conversation.status,
      escalation: null,
      duplicate: true,
    };
  }

  const history = await loadHistory(conversation.id, customerMessage.id);
  const withAi = conversation.status === "ai_active";

  // 4. Respuesta con RAG (solo si la conversación sigue con la IA).
  let kbChunks: KbContextChunk[] = [];
  let kbSupportFound: boolean | null = null;
  let aiFailure: "unavailable" | "refusal" | null = null;
  let replyText: string | null = null;
  let replyModel: string | null = null;
  let replyLatencyMs: number | null = null;

  const preDecision = decideEscalation({
    current: signalsOf(classification),
    previousCustomerTurns: history.previousCustomerTurns,
    consecutiveUnsupportedAiReplies: history.consecutiveUnsupportedAiReplies,
    kbSupportFound: null,
    aiFailure: null,
  });

  // Si ya se sabe que escala (fraude, pide humano, enojo…), no se gasta una respuesta del modelo.
  if (withAi && !preDecision.escalate) {
    try {
      const retrieval = await retrieveKnowledge(input.content);
      usage.push({ kind: "embedding", model: ai.embedder.model, usage: retrieval.usage });
      kbChunks = retrieval.chunks;
      kbSupportFound = kbChunks.length > 0;

      const started = Date.now();
      const reply = await ai.chat.reply({ history: history.turns, kbChunks, customerMessage: input.content });
      replyLatencyMs = Date.now() - started;
      usage.push({ kind: "chat", model: reply.model, usage: reply.usage });
      replyText = reply.text;
      replyModel = reply.model;
    } catch (err) {
      aiFailure = err instanceof AiRefusalError ? "refusal" : "unavailable";
      logger.warn({ err: err instanceof Error ? err.name : String(err) }, "La IA no pudo responder el turno");
    }
  }

  // 5. Escalamiento.
  const decision: EscalationDecision = preDecision.escalate
    ? preDecision
    : decideEscalation({
        current: signalsOf(classification),
        previousCustomerTurns: history.previousCustomerTurns,
        consecutiveUnsupportedAiReplies: history.consecutiveUnsupportedAiReplies,
        kbSupportFound,
        aiFailure,
      });

  let escalationInfo: TurnResult["escalation"] = null;
  if (decision.escalate) {
    const outcome = await escalate({
      conversationId: conversation.id,
      triggeringMessageId: customerMessage.id,
      callId: input.callId ?? null,
      reason: decision.reason,
      trigger: decision.trigger,
      priority: decision.priority,
      signal: { ...decision.signal, provider: ai.provider },
    });
    escalationInfo = { created: outcome.created, reason: decision.reason };
  }

  // Qué ve el cliente: la respuesta de la IA, o el aviso de traspaso si escaló
  // estando con la IA. Con un humano a cargo, nada (le responde el agente).
  let reply: PublicMessage | null = null;
  if (withAi && decision.escalate && escalationInfo?.created) {
    reply = await saveReply(input, { senderType: "system", content: handoffMessage(decision.reason) });
  } else if (withAi && replyText) {
    reply = await saveReply(input, {
      senderType: "ai",
      content: replyText,
      model: replyModel,
      latencyMs: replyLatencyMs,
      citations: kbChunks,
    });
  }

  if (usage.length) {
    await prisma.aiUsage.createMany({
      data: usageRows(usage, { customerId: input.customerId, conversationId: conversation.id, callId: input.callId }),
    });
  }

  const after = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversation.id },
    select: { status: true },
  });

  // Tiempo real (después de confirmar todo): el mensaje del cliente, la respuesta
  // o el traspaso, y el cambio de estado si escaló. Llega al cliente (sus otras
  // pestañas) y a los agentes que pueden ver la conversación (realtime/audience.ts).
  await publishMessagesCreated(conversation.id, [customerMessage.id, ...(reply ? [reply.id] : [])]);
  if (after.status !== conversation.status) {
    await publishConversationUpdated(conversation.id, { status: conversation.status, assignedAgentId: null });
  }
  engineTurns.inc({
    channel: input.channel,
    outcome: decision.escalate ? "escalated" : withAi ? "ai_reply" : "to_agent",
  });
  return { customerMessage, reply, conversationStatus: after.status, escalation: escalationInfo, duplicate: false };
}

function signalsOf(classification: Classification | null) {
  return {
    intent: classification?.intent ?? null,
    sentiment: classification?.sentiment ?? null,
    confidence: classification?.confidence ?? null,
  };
}

/** Guarda el mensaje del cliente con su análisis. null si perdió una carrera de clientMsgId. */
async function saveCustomerMessage(input: CustomerTurnInput, classification: Classification | null) {
  try {
    return await prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId: input.conversationId,
          senderType: "customer",
          channel: input.channel,
          callId: input.channel === "voice" ? input.callId : null,
          content: input.content,
          clientMsgId: input.clientMsgId ?? null,
          intent: classification?.intent ?? null,
          sentiment: classification?.sentiment ?? null,
          analysisConfidence: classification?.confidence ?? null,
        },
        select: PUBLIC_MESSAGE_FIELDS,
      });
      await tx.conversation.update({ where: { id: input.conversationId }, data: { lastMessageAt: message.createdAt } });
      return message;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && input.clientMsgId) return null;
    throw err;
  }
}

async function saveReply(
  input: CustomerTurnInput,
  reply: {
    senderType: "ai" | "system";
    content: string;
    model?: string | null;
    latencyMs?: number | null;
    citations?: KbContextChunk[];
  }
) {
  return prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        conversationId: input.conversationId,
        senderType: reply.senderType,
        // En voz, la respuesta también es un turno de la llamada (se sintetiza con TTS en la Fase 5).
        channel: input.channel,
        callId: input.channel === "voice" ? input.callId : null,
        content: reply.content,
        aiModel: reply.senderType === "ai" ? (reply.model ?? null) : null,
        aiLatencyMs: reply.senderType === "ai" ? (reply.latencyMs ?? null) : null,
        citations: reply.citations?.length
          ? {
              create: reply.citations.map((chunk, i) => ({
                rank: i + 1,
                articleId: chunk.articleId,
                chunkId: chunk.chunkId,
                articleVersion: chunk.articleVersion,
                score: Math.max(-1, Math.min(1, chunk.score)),
              })),
            }
          : undefined,
      },
      select: PUBLIC_MESSAGE_FIELDS,
    });
    await tx.conversation.update({ where: { id: input.conversationId }, data: { lastMessageAt: message.createdAt } });
    return message;
  });
}
