import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { ApiError } from "../../utils/apiError";

/**
 * Consumo de voz por cliente: segundos de audio enviados al STT en 24 h
 * (tabla ai_usage, unit = 'seconds'). Es la defensa contra "agotar créditos
 * por el canal de voz": una llamada abierta horas, o muchas llamadas seguidas.
 * Se suma al tope de tokens de IA (engine/budget.service.ts), que también
 * aplica a cada turno de voz.
 */
export class VoiceBudgetExceededError extends ApiError {
  constructor() {
    super(429, "Alcanzaste el límite diario de llamadas con el asistente. Puedes seguir por chat.");
  }
}

export async function voiceSecondsLast24h(customerId: string): Promise<number> {
  const [row] = await prisma.$queryRaw<{ total: bigint | null }[]>`
    SELECT SUM(input_units) AS total
    FROM ai_usage
    WHERE customer_id = ${customerId}::uuid AND kind = 'stt' AND unit = 'seconds'
      AND created_at > now() - interval '24 hours'`;
  return Number(row?.total ?? 0);
}

export async function assertWithinVoiceBudget(customerId: string, pendingSeconds = 0): Promise<void> {
  if ((await voiceSecondsLast24h(customerId)) + pendingSeconds >= env.voice.dailySecondsPerCustomer) {
    throw new VoiceBudgetExceededError();
  }
}

/** Registra segundos de STT. customerId null = audio de un agente (no cuenta en el tope del cliente). */
export async function recordSttUsage(input: {
  seconds: number;
  provider: string;
  model: string;
  customerId: string | null;
  conversationId: string;
  callId: string;
}): Promise<void> {
  const seconds = Math.ceil(input.seconds);
  if (seconds <= 0) return;
  await prisma.aiUsage.create({
    data: {
      kind: "stt",
      provider: input.provider,
      model: input.model,
      customerId: input.customerId,
      conversationId: input.conversationId,
      callId: input.callId,
      unit: "seconds",
      inputUnits: seconds,
    },
  });
}

export async function recordTtsUsage(input: {
  characters: number;
  provider: string;
  model: string;
  customerId: string;
  conversationId: string;
  callId: string;
}): Promise<void> {
  if (input.characters <= 0) return;
  await prisma.aiUsage.create({
    data: {
      kind: "tts",
      provider: input.provider,
      model: input.model,
      customerId: input.customerId,
      conversationId: input.conversationId,
      callId: input.callId,
      unit: "characters",
      outputUnits: input.characters,
    },
  });
}
