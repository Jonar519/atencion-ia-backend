import { prisma } from "../../config/prisma";
import type { HistoryTurn } from "../../services/ai";
import type { TurnSignals } from "./escalationRules";
import { textForAi } from "../attachments/fileChecks";

/** Turnos de historial que se envían al modelo (suficiente para el contexto, acotado en costo). */
export const HISTORY_TURNS = 12;

export interface ConversationHistory {
  /** Turnos anteriores de ESTA conversación, en orden cronológico, para el modelo. */
  turns: HistoryTurn[];
  /** Señales de los turnos anteriores del cliente, del más reciente al más antiguo. */
  previousCustomerTurns: TurnSignals[];
  /** Respuestas de la IA sin fragmentos de la KB, consecutivas desde la más reciente. */
  consecutiveUnsupportedAiReplies: number;
}

/**
 * Historial de UNA conversación.
 *
 * AISLAMIENTO: es la única función que lee mensajes para armar el contexto
 * del modelo y filtra SIEMPRE por conversationId. Un error aquí mezclaría
 * conversaciones de distintos clientes en el prompt: por eso hay un test que
 * siembra un "secreto" en otra conversación y verifica que nunca llega al
 * modelo (tests/integration/ragIsolation.test.ts), y una prueba de mutación
 * que rompe este filtro a propósito (docs/rag.md).
 */
export async function loadHistory(conversationId: string, excludeMessageId?: string): Promise<ConversationHistory> {
  const rows = await prisma.message.findMany({
    where: { conversationId, ...(excludeMessageId ? { id: { not: excludeMessageId } } : {}) },
    select: {
      senderType: true,
      content: true,
      intent: true,
      sentiment: true,
      analysisConfidence: true,
      _count: { select: { citations: true } },
      // Del adjunto, SOLO el tipo: ni el nombre ni el archivo llegan al modelo (bloque C).
      attachments: { select: { contentType: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HISTORY_TURNS,
  });

  const previousCustomerTurns = rows
    .filter((row) => row.senderType === "customer")
    .map((row) => ({ intent: row.intent, sentiment: row.sentiment, confidence: row.analysisConfidence }));

  let consecutiveUnsupportedAiReplies = 0;
  for (const row of rows) {
    if (row.senderType === "customer") continue;
    if (row.senderType !== "ai" || row._count.citations > 0) break;
    consecutiveUnsupportedAiReplies += 1;
  }

  return {
    turns: rows
      .reverse()
      .map((row) => ({ sender: row.senderType, content: textForAi(row.content, row.attachments[0]?.contentType) })),
    previousCustomerTurns,
    consecutiveUnsupportedAiReplies,
  };
}
