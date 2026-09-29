import type { AiUsageKind, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { ApiError } from "../../utils/apiError";
import type { Usage } from "../../services/ai";

/**
 * Consumo de IA por cliente (tabla ai_usage) y tope diario.
 *
 * Defensa contra "agotar los créditos de IA": el rate limit por sesión corta
 * ráfagas, pero un cliente paciente (o muchas sesiones del mismo cliente, o en
 * la Fase 5 una llamada de voz abierta horas) podría consumir sin límite. El
 * tope se mide en TOKENS reales de las últimas 24 h, sumando todas las
 * operaciones (clasificar, buscar, responder).
 */

export class AiBudgetExceededError extends ApiError {
  constructor() {
    super(429, "Alcanzaste el límite diario de consultas al asistente. Un asesor puede ayudarte: escribe 'asesor'.");
  }
}

export async function tokensUsedLast24h(customerId: string): Promise<number> {
  const [row] = await prisma.$queryRaw<{ total: bigint | null }[]>`
    SELECT SUM(input_units + output_units) AS total
    FROM ai_usage
    WHERE customer_id = ${customerId}::uuid AND unit = 'tokens' AND created_at > now() - interval '24 hours'`;
  return Number(row?.total ?? 0);
}

export async function assertWithinBudget(customerId: string): Promise<void> {
  if ((await tokensUsedLast24h(customerId)) >= env.ai.dailyTokenBudgetPerCustomer) throw new AiBudgetExceededError();
}

export interface UsageRecord {
  kind: AiUsageKind;
  model: string;
  usage: Usage;
}

export function usageRows(
  records: UsageRecord[],
  ids: { customerId: string; conversationId: string; callId?: string | null }
): Prisma.AiUsageCreateManyInput[] {
  return records.map((record) => ({
    kind: record.kind,
    provider: env.ai.provider,
    model: record.model,
    customerId: ids.customerId,
    conversationId: ids.conversationId,
    callId: ids.callId ?? null,
    unit: "tokens",
    inputUnits: record.usage.inputTokens,
    outputUnits: record.usage.outputTokens,
    // Costo estimado: se calcula en el reporte con el precio vigente (0 en mock).
    estimatedCostUsd: 0,
  }));
}
