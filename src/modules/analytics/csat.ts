import { createHash } from "crypto";

/**
 * CSAT SIMULADO (Fase 7). El sistema todavía no pregunta al cliente cómo le
 * fue, así que NO hay satisfacción real que medir. Para que el tablero tenga
 * la forma que tendrá con encuestas reales, se estima una nota 1–5 por
 * conversación cerrada con una regla FIJA y documentada (docs/analytics.md):
 *
 *   base según cómo terminó  +  -1 si tardó más de 30 min  +  variación del id
 *
 * La variación sale del hash del id (−1, 0 o +1 con la misma probabilidad):
 * es DETERMINISTA, así que con los mismos datos el número es siempre el mismo
 * (se puede verificar a mano) y no cambia al recargar. Nunca se presenta como
 * opinión de clientes: la API y la pantalla lo marcan como simulado.
 */
export const CSAT_BASE: Record<string, number | null> = {
  resolved_by_ai: 4,
  resolved_by_agent: 4,
  inactivity: 3,
  customer_abandoned: 2,
  // Spam no es un cliente al que atender: no entra en el CSAT.
  spam: null,
};

export const SLOW_RESOLUTION_MINUTES = 30;

/** −1, 0 o +1 a partir del id (determinista). */
export function idVariation(id: string): -1 | 0 | 1 {
  const byte = createHash("sha256").update(id).digest()[0]!;
  return ((byte % 3) - 1) as -1 | 0 | 1;
}

/** Nota simulada 1–5, o null si la conversación no entra en el CSAT. */
export function simulatedCsatScore(conversation: {
  id: string;
  closeReason: string | null;
  resolutionMinutes: number;
}): number | null {
  const base = conversation.closeReason ? CSAT_BASE[conversation.closeReason] : null;
  if (base === null || base === undefined) return null;
  const slow = conversation.resolutionMinutes > SLOW_RESOLUTION_MINUTES ? -1 : 0;
  return Math.min(5, Math.max(1, base + slow + idVariation(conversation.id)));
}

/** Resumen estándar: % de notas 4 o 5 ("satisfechos") y la distribución 1–5. */
export function summarizeCsat(scores: number[]) {
  const distribution = [1, 2, 3, 4, 5].map((n) => scores.filter((s) => s === n).length);
  const satisfied = scores.filter((s) => s >= 4).length;
  return {
    simulated: true as const,
    responses: scores.length,
    satisfiedPercent: scores.length ? Math.round((satisfied / scores.length) * 1000) / 10 : null,
    average: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null,
    distribution,
  };
}
