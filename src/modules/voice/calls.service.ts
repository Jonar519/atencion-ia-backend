import { Prisma, type CallEndReason, type CallStatus } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { ApiError } from "../../utils/apiError";
import { dbNow } from "../../utils/dbTime";
import { audit } from "../../services/audit/audit.service";
import { getVoice, SAMPLE_RATE } from "../../services/voice";
import { voiceCallEvents } from "../../observability/metrics";
import { publishCallUpdated, publishMessagesCreated } from "../../realtime/publish";
import { publishVoice } from "../../realtime/bus";
import type { AuthUser } from "../../middlewares/auth.middleware";
import type { WidgetIdentity } from "../widget/widgetAuth.middleware";
import { assertWithinBudget } from "../engine/budget.service";
import { canClose, canViewConversation, conversationScope } from "../conversations/conversations.access";
import { conversationsService } from "../conversations/conversations.service";
import { CONSENT_VERSION } from "./consent";
import { assertWithinVoiceBudget } from "./voiceBudget";
import type { Request } from "express";

/**
 * LLAMADAS DE VOZ: ciclo de vida y reglas.
 *
 *   connecting ──(el cliente conecta el audio)──▶ in_progress ⇄ waiting_agent
 *        │                                             │  (escala)   │ (un agente se une)
 *        └──(nunca conecta: timeout)──▶ failed         └──────▶ ended ◀┘ (cuelgan, tope, cierre del caso)
 *
 * Reglas que se aplican AQUÍ (y en la base, que es la última palabra):
 *  - Sin consentimiento vigente no hay llamada (calls.consent_given_at NOT NULL + versión actual).
 *  - Una sola llamada activa por conversación (índice único parcial → 409).
 *  - El dueño de la conversación es el único cliente que puede iniciarla, verla o colgarla.
 *  - Un agente solo se une si puede ver el caso: si está en cola lo TOMA (misma regla
 *    atómica que el panel, con su máximo de conversaciones); si ya es suyo, entra.
 *  - Toda transición es condicional al estado actual (UPDATE … WHERE status IN …):
 *    dos "colgar" simultáneos terminan la llamada una sola vez.
 *  - Cada transición se publica (panel y widget) después de confirmarse.
 */

export const ACTIVE_CALL: CallStatus[] = ["connecting", "in_progress", "waiting_agent"];
const NOT_FOUND = "Llamada no encontrada";
const PURGED_PLACEHOLDER = "[Transcripción eliminada por la política de retención]";

export const AUDIO_FORMAT = { encoding: "pcm_s16le", sampleRate: SAMPLE_RATE, channels: 1, frameMs: 100 } as const;

function callSetup() {
  return {
    audio: AUDIO_FORMAT,
    iceServers: env.voice.iceServers,
    maxCallSeconds: env.voice.maxCallSeconds,
  };
}

const SEGMENT_FIELDS = {
  seq: true,
  speaker: true,
  text: true,
  startMs: true,
  endMs: true,
  confidence: true,
  messageId: true,
  createdAt: true,
} satisfies Prisma.CallTranscriptSegmentSelect;

export const callsService = {
  /** Inicia una llamada en una conversación del cliente, con su consentimiento. */
  async start(
    widget: WidgetIdentity,
    conversationId: string,
    input: { consentVersion: string; accepted: true },
    req: Request | null = null
  ) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, customerId: widget.customerId },
      select: { id: true, status: true },
    });
    if (!conversation) throw new ApiError(404, "Conversación no encontrada");
    if (conversation.status === "closed") throw new ApiError(409, "La conversación está cerrada. Inicia una nueva.");
    if (input.consentVersion !== CONSENT_VERSION) {
      throw new ApiError(409, "El aviso de la llamada cambió. Léelo de nuevo antes de llamar.");
    }
    // Antes de gastar un segundo de audio: topes de voz y de IA del cliente.
    await assertWithinVoiceBudget(widget.customerId);
    await assertWithinBudget(widget.customerId);

    const voice = getVoice();
    let call;
    try {
      call = await prisma.$transaction(async (tx) => {
        const now = await dbNow(tx);
        const created = await tx.call.create({
          data: {
            conversationId,
            status: "connecting",
            consentGivenAt: now,
            consentVersion: input.consentVersion,
            startedAt: now,
            sttProvider: voice.stt.provider,
            ttsProvider: voice.tts.provider,
            retainUntil: new Date(now.getTime() + env.voice.retentionDays * 86_400_000),
          },
          select: { id: true, status: true, startedAt: true, retainUntil: true, conversationId: true },
        });
        await tx.callParticipant.createMany({
          data: [
            { callId: created.id, participantType: "customer", joinedAt: now },
            { callId: created.id, participantType: "ai", joinedAt: now },
          ],
        });
        return created;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ApiError(409, "Ya hay una llamada en curso en esta conversación.");
      }
      throw err;
    }
    voiceCallEvents.inc({ event: "started", reason: "" });
    audit(req, {
      action: "call.start",
      actorType: "customer",
      actorId: widget.customerId,
      entityType: "call",
      entityId: call.id,
      metadata: { consentVersion: input.consentVersion },
    });
    await publishCallUpdated(call.id);
    return { call, ...callSetup() };
  },

  /** Estado de una llamada del cliente (404 si no es suya). */
  async getForCustomer(widget: WidgetIdentity, callId: string) {
    const call = await prisma.call.findFirst({
      where: { id: callId, conversation: { customerId: widget.customerId } },
      select: {
        id: true,
        conversationId: true,
        status: true,
        startedAt: true,
        answeredAt: true,
        endedAt: true,
        endReason: true,
        durationSeconds: true,
      },
    });
    if (!call) throw new ApiError(404, NOT_FOUND);
    return call;
  },

  async endByCustomer(widget: WidgetIdentity, callId: string) {
    await this.getForCustomer(widget, callId);
    await this.end(callId, "customer_hangup");
  },

  /**
   * Termina la llamada (idempotente: si ya terminó, no hace nada y devuelve
   * false). `failed` = nunca llegó a conectarse.
   */
  async end(callId: string, reason: CallEndReason, options: { failed?: boolean } = {}): Promise<boolean> {
    const result = await prisma.$transaction(async (tx) => {
      const now = await dbNow(tx);
      const { count } = await tx.call.updateMany({
        where: { id: callId, status: { in: ACTIVE_CALL } },
        data: { status: options.failed ? "failed" : "ended", endedAt: now, endReason: reason },
      });
      if (count === 0) return null;
      await tx.callParticipant.updateMany({ where: { callId, leftAt: null }, data: { leftAt: now } });
      const call = await tx.call.findUniqueOrThrow({ where: { id: callId }, select: { conversationId: true } });
      const message = await tx.message.create({
        data: {
          conversationId: call.conversationId,
          senderType: "system",
          content: options.failed ? "La llamada no se pudo conectar." : "La llamada de voz terminó.",
        },
        select: { id: true, createdAt: true },
      });
      await tx.conversation.update({ where: { id: call.conversationId }, data: { lastMessageAt: message.createdAt } });
      return { conversationId: call.conversationId, messageId: message.id };
    });
    if (!result) return false;
    voiceCallEvents.inc({ event: options.failed ? "failed" : "ended", reason });
    // Cada instancia cierra sus sockets de esta llamada; panel y widget ven el nuevo estado.
    await publishVoice({ kind: "ended", callId, reason });
    await publishCallUpdated(callId);
    await publishMessagesCreated(result.conversationId, [result.messageId]);
    return true;
  },

  /** El cliente conectó el audio: connecting → en curso (o en espera, si el caso ya está en cola). */
  async markAnswered(callId: string): Promise<void> {
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: { status: true, conversation: { select: { status: true } } },
    });
    if (call?.status !== "connecting") return;
    const next: CallStatus = call.conversation.status === "waiting_agent" ? "waiting_agent" : "in_progress";
    const updated = await prisma.$transaction(async (tx) => {
      const now = await dbNow(tx);
      const { count } = await tx.call.updateMany({
        where: { id: callId, status: "connecting" },
        data: { status: next, answeredAt: now },
      });
      return count;
    });
    if (updated === 0) return;
    voiceCallEvents.inc({ event: "answered", reason: "" });
    await publishCallUpdated(callId);
  },

  /** Tras un turno que escaló la conversación: la llamada queda "en espera de agente". */
  async markWaitingAgent(callId: string): Promise<void> {
    const { count } = await prisma.call.updateMany({
      where: { id: callId, status: "in_progress" },
      data: { status: "waiting_agent" },
    });
    if (count === 0) return;
    voiceCallEvents.inc({ event: "waiting_agent", reason: "" });
    await publishCallUpdated(callId);
  },

  /**
   * Un agente se une a una llamada en curso y recibe la transcripción acumulada.
   * Si el caso está en la cola, unirse = TOMARLO (conversationsService.take:
   * atómico, respeta max_concurrent, un solo ganador si dos se unen a la vez).
   */
  async join(user: AuthUser, callId: string, req: Request | null = null) {
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: {
        id: true,
        status: true,
        conversationId: true,
        conversation: { select: { status: true, assignedAgentId: true } },
      },
    });
    if (!call || !canViewConversation(user, call.conversation)) throw new ApiError(404, NOT_FOUND);
    if (!ACTIVE_CALL.includes(call.status)) throw new ApiError(409, "La llamada ya terminó.");

    const { conversation } = call;
    if (conversation.status === "waiting_agent" && conversation.assignedAgentId === null) {
      await conversationsService.take(user, call.conversationId);
    } else if (!(conversation.status === "agent_active" && conversation.assignedAgentId === user.staffId)) {
      throw new ApiError(409, "Solo el agente que atiende la conversación puede unirse a la llamada.");
    }

    await prisma.$transaction(async (tx) => {
      const now = await dbNow(tx);
      const present = await tx.callParticipant.findFirst({
        where: { callId, agentId: user.staffId, leftAt: null },
        select: { id: true },
      });
      // Volver a unirse (recargó el panel) no crea otra participación.
      if (!present) {
        await tx.callParticipant.create({
          data: { callId, participantType: "agent", agentId: user.staffId, joinedAt: now },
        });
      }
      await tx.call.updateMany({
        where: { id: callId, handledByAgentId: null },
        data: { handledByAgentId: user.staffId },
      });
      await tx.call.updateMany({ where: { id: callId, status: "waiting_agent" }, data: { status: "in_progress" } });
    });
    voiceCallEvents.inc({ event: "agent_joined", reason: "" });
    audit(req, { action: "call.join", entityType: "call", entityId: callId });
    await publishCallUpdated(callId);

    const current = await prisma.call.findUniqueOrThrow({
      where: { id: callId },
      select: { id: true, conversationId: true, status: true, startedAt: true, answeredAt: true },
    });
    return { call: current, transcript: await this.segments(callId), ...callSetup() };
  },

  async leave(user: AuthUser, callId: string, req: Request | null = null) {
    const { count } = await prisma.callParticipant.updateMany({
      where: { callId, agentId: user.staffId, leftAt: null },
      data: { leftAt: new Date() },
    });
    if (count === 0) throw new ApiError(404, NOT_FOUND);
    audit(req, { action: "call.leave", entityType: "call", entityId: callId });
  },

  /** Colgar desde el panel: el agente asignado o un admin (misma regla que cerrar el caso). */
  async endByStaff(user: AuthUser, callId: string, req: Request | null = null) {
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: { conversation: { select: { status: true, assignedAgentId: true } } },
    });
    if (!call || !canViewConversation(user, call.conversation)) throw new ApiError(404, NOT_FOUND);
    if (!canClose(user, call.conversation)) {
      throw new ApiError(409, "Solo el agente que atiende la conversación o un administrador pueden colgar.");
    }
    const ended = await this.end(callId, "agent_hangup");
    if (ended) audit(req, { action: "call.end", entityType: "call", entityId: callId });
  },

  /** Transcripción de una llamada, para quien puede ver el caso. */
  async transcript(user: AuthUser, callId: string) {
    const call = await prisma.call.findFirst({
      where: { id: callId, conversation: conversationScope(user) },
      select: { id: true, status: true, transcriptPurgedAt: true, retainUntil: true },
    });
    if (!call) throw new ApiError(404, NOT_FOUND);
    return { call, segments: await this.segments(callId) };
  },

  /** Llamadas activas que el usuario puede ver (panel: "llamadas en curso"). */
  async active(user: AuthUser) {
    return prisma.call.findMany({
      where: { status: { in: ACTIVE_CALL }, conversation: conversationScope(user) },
      select: {
        id: true,
        status: true,
        startedAt: true,
        conversationId: true,
        handledByAgent: { select: { id: true, name: true } },
        conversation: { select: { priority: true, customer: { select: { displayName: true } } } },
      },
      orderBy: { startedAt: "asc" },
    });
  },

  segments(callId: string) {
    return prisma.callTranscriptSegment.findMany({
      where: { callId },
      select: SEGMENT_FIELDS,
      orderBy: { seq: "asc" },
    });
  },

  /**
   * Agrega un segmento FINAL a la transcripción, con el siguiente número de
   * orden. Dos segmentos simultáneos (cliente y agente hablan a la vez, en
   * instancias distintas) chocan en UNIQUE (call_id, seq): se reintenta.
   */
  async appendSegment(input: {
    callId: string;
    speaker: "customer" | "ai" | "agent";
    text: string;
    startMs: number;
    endMs: number;
    confidence: number | null;
    messageId: string | null;
  }): Promise<void> {
    const text = input.text.trim().slice(0, 4000);
    if (!text) return;
    const startMs = Math.max(0, Math.round(input.startMs));
    const endMs = Math.max(startMs, Math.round(input.endMs));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await prisma.$executeRaw`
          INSERT INTO call_transcript_segments (call_id, seq, speaker, text, start_ms, end_ms, confidence, message_id)
          SELECT ${input.callId}::uuid, COALESCE(MAX(seq) + 1, 0), ${input.speaker}::participant_type, ${text},
                 ${startMs}, ${endMs}, ${input.confidence}::real, ${input.messageId}::uuid
          FROM call_transcript_segments WHERE call_id = ${input.callId}::uuid`;
        return;
      } catch (err) {
        const unique =
          err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2010" && /23505/.test(err.message);
        if (!unique || attempt === 4) throw err;
      }
    }
  },

  /**
   * Turno de VOZ de un agente (su frase transcrita): un mensaje del agente con
   * channel = voice. Mismas reglas que responder por texto: solo el agente que
   * atiende el caso y mientras la llamada siga activa.
   */
  async agentVoiceTurn(staffId: string, callId: string, text: string): Promise<string | null> {
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: { status: true, conversationId: true, conversation: { select: { status: true, assignedAgentId: true } } },
    });
    if (!call || !ACTIVE_CALL.includes(call.status)) return null;
    if (call.conversation.status !== "agent_active" || call.conversation.assignedAgentId !== staffId) return null;
    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId: call.conversationId,
          senderType: "agent",
          senderAgentId: staffId,
          channel: "voice",
          callId,
          content: text.trim().slice(0, 8000),
        },
        select: { id: true, createdAt: true },
      });
      await tx.conversation.update({ where: { id: call.conversationId }, data: { lastMessageAt: created.createdAt } });
      return created;
    });
    await publishMessagesCreated(call.conversationId, [message.id]);
    return message.id;
  },

  /**
   * Barrido (worker, cada minuto): llamadas que la instancia que las atendía
   * ya no puede cerrar (se cayó, se reinició):
   *  - creadas y nunca conectadas en VOICE_CONNECT_TIMEOUT_MS → failed;
   *  - activas más allá del máximo de duración (+1 min de margen) → ended por timeout.
   */
  async sweepStale(): Promise<number> {
    const stale = await prisma.$queryRaw<{ id: string; never_connected: boolean }[]>`
      SELECT id, status = 'connecting' AS never_connected
      FROM calls
      WHERE (status = 'connecting' AND started_at < now() - ${env.voice.connectTimeoutMs} * interval '1 millisecond')
         OR (status IN ('connecting', 'in_progress', 'waiting_agent')
             AND started_at < now() - ${env.voice.maxCallSeconds + 60} * interval '1 second')`;
    let ended = 0;
    for (const row of stale) {
      if (await this.end(row.id, "timeout", { failed: row.never_connected })) ended += 1;
    }
    if (ended) logger.info({ ended }, "Llamadas abandonadas cerradas por el barrido");
    return ended;
  },

  /**
   * Retención (worker, cada hora; también `npm run voice:purge`): a las llamadas
   * terminadas cuyo retain_until ya pasó se les borra la transcripción
   * (segmentos) y el texto de sus turnos de voz, y se marca transcript_purged_at.
   * Quedan los metadatos (duración, motivo, participantes) y el análisis de
   * intención, que no contienen lo que se dijo. Por lotes, sin bloquear.
   */
  async purgeExpiredTranscripts(batchSize = 100): Promise<number> {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM calls
        WHERE transcript_purged_at IS NULL AND retain_until <= now() AND status IN ('ended', 'failed')
        ORDER BY retain_until
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED`;
      const ids = rows.map((row) => row.id);
      if (ids.length === 0) return 0;
      await tx.callTranscriptSegment.deleteMany({ where: { callId: { in: ids } } });
      await tx.message.updateMany({ where: { callId: { in: ids } }, data: { content: PURGED_PLACEHOLDER } });
      const now = await dbNow(tx);
      await tx.call.updateMany({ where: { id: { in: ids } }, data: { transcriptPurgedAt: now } });
      audit(null, { action: "call.purge", actorType: "system", actorId: null, metadata: { calls: ids.length } });
      return ids.length;
    });
  },
};

export { PURGED_PLACEHOLDER };
