import { logger } from "../../config/logger";
import { handleCustomerTurn } from "../engine/conversationEngine";
import { getVoice, SAMPLE_RATE } from "../../services/voice";
import { voiceTurnLatency } from "../../observability/metrics";
import { callsService } from "./calls.service";
import { recordTtsUsage } from "./voiceBudget";

/**
 * Un segmento FINAL del STT → un turno. Aquí NO hay lógica conversacional
 * propia: la frase del cliente entra a la MISMA función que un mensaje de
 * texto (handleCustomerTurn, Fase 3) con channel "voice" y la llamada. RAG,
 * intención, tope de IA y reglas de escalamiento son exactamente las mismas.
 * Lo único propio de la voz: guardar el segmento en la transcripción y
 * convertir la respuesta en audio (TTS).
 */

export interface VoiceTurnContext {
  callId: string;
  conversationId: string;
  customerId: string;
  /** ms entre el inicio de la llamada y el inicio de ESTE stream de audio (tiempos de la transcripción). */
  offsetMs: number;
}

export interface VoiceOutput {
  json(message: Record<string, unknown>): void;
  audio(chunk: Buffer): void;
}

const TTS_FRAME_BYTES = 3_200; // 100 ms de PCM16 a 16 kHz

export async function processCustomerSegment(
  ctx: VoiceTurnContext,
  segment: { text: string; startMs: number; endMs: number; confidence: number | null },
  out: VoiceOutput
): Promise<{ escalated: boolean }> {
  const heardAt = Date.now();
  const result = await handleCustomerTurn({
    conversationId: ctx.conversationId,
    customerId: ctx.customerId,
    content: segment.text,
    channel: "voice",
    callId: ctx.callId,
  });
  await callsService.appendSegment({
    callId: ctx.callId,
    speaker: "customer",
    text: segment.text,
    startMs: ctx.offsetMs + segment.startMs,
    endMs: ctx.offsetMs + segment.endMs,
    confidence: segment.confidence,
    messageId: result.customerMessage.id,
  });
  out.json({ type: "transcript.final", speaker: "customer", text: segment.text, messageId: result.customerMessage.id });

  if (result.reply) {
    const reply = result.reply;
    const voice = getVoice();
    const replyStartMs = ctx.offsetMs + segment.endMs + (Date.now() - heardAt);
    let speech: Awaited<ReturnType<typeof voice.tts.synthesize>> | null = null;
    try {
      speech = await voice.tts.synthesize(reply.content, { sampleRate: SAMPLE_RATE });
    } catch (err) {
      // Sin audio, la respuesta igual quedó en la conversación: el cliente la ve como texto.
      logger.warn({ err: err instanceof Error ? err.name : String(err) }, "No se pudo sintetizar la respuesta");
    }
    // La transcripción se guarda ANTES de enviar el audio: un agente que se une en
    // ese instante recibe la respuesta en su transcripción acumulada.
    await callsService.appendSegment({
      callId: ctx.callId,
      speaker: "ai",
      text: reply.content,
      startMs: replyStartMs,
      endMs: replyStartMs + (speech?.durationMs ?? 0),
      confidence: null,
      messageId: reply.id,
    });
    if (!speech) {
      out.json({ type: "tts.unavailable", messageId: reply.id, text: reply.content });
    } else {
      voiceTurnLatency.observe((Date.now() - heardAt) / 1000);
      out.json({
        type: "tts.start",
        messageId: reply.id,
        text: reply.content,
        sampleRate: speech.sampleRate,
        durationMs: speech.durationMs,
      });
      for (let offset = 0; offset < speech.audio.length; offset += TTS_FRAME_BYTES) {
        out.audio(speech.audio.subarray(offset, offset + TTS_FRAME_BYTES));
      }
      out.json({ type: "tts.end", messageId: reply.id });
      await recordTtsUsage({
        characters: speech.characters,
        provider: voice.tts.provider,
        model: voice.tts.model,
        customerId: ctx.customerId,
        conversationId: ctx.conversationId,
        callId: ctx.callId,
      });
    }
  }

  // Mismo motor de escalamiento: si la conversación pasó a la cola, la llamada queda en espera de agente.
  const escalated = result.conversationStatus === "waiting_agent";
  if (escalated) await callsService.markWaitingAgent(ctx.callId);
  return { escalated };
}

export async function processAgentSegment(
  input: { callId: string; staffId: string; offsetMs: number },
  segment: { text: string; startMs: number; endMs: number; confidence: number | null },
  out: VoiceOutput
): Promise<void> {
  const messageId = await callsService.agentVoiceTurn(input.staffId, input.callId, segment.text);
  if (!messageId) return;
  await callsService.appendSegment({
    callId: input.callId,
    speaker: "agent",
    text: segment.text,
    startMs: input.offsetMs + segment.startMs,
    endMs: input.offsetMs + segment.endMs,
    confidence: segment.confidence,
    messageId,
  });
  out.json({ type: "transcript.final", speaker: "agent", text: segment.text, messageId });
}
