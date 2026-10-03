import { prisma } from "../../config/prisma";
import { simulatedCsatScore, summarizeCsat } from "./csat";

/**
 * Métricas del tablero /admin/analytics (definiciones en docs/analytics.md).
 * Todo se calcula en la base sobre una VENTANA [from, to):
 *  - Resolución: conversaciones CERRADAS en la ventana como resueltas (por la
 *    IA o por un asesor); tiempo = closed_at − created_at. Promedio y mediana.
 *  - Tasa de escalamiento: de las conversaciones CREADAS en la ventana, cuántas
 *    tuvieron al menos un escalamiento.
 *  - CSAT: SIMULADO (./csat.ts) sobre las cerradas en la ventana.
 *  - Volumen por hora: conversaciones CREADAS en la ventana por hora del día,
 *    en la zona horaria del banco.
 * No devuelve datos personales: solo conteos y promedios.
 */
export const ANALYTICS_TIMEZONE = "America/Bogota";

export interface AnalyticsWindow {
  from: Date;
  to: Date;
}

const round1 = (value: number | null) => (value === null ? null : Math.round(value * 10) / 10);

export const analyticsService = {
  /** Ventana de los últimos N días hasta ahora (reloj de la base). */
  async lastDays(days: number): Promise<AnalyticsWindow> {
    const [row] = await prisma.$queryRaw<{ to: Date }[]>`SELECT now() AS "to"`;
    const to = row!.to;
    return { from: new Date(to.getTime() - days * 86_400_000), to };
  },

  async summary({ from, to }: AnalyticsWindow) {
    const [resolution, byReason, escalation, escalationReasons, hours, closed] = await Promise.all([
      prisma.$queryRaw<{ count: bigint; avg_min: number | null; median_min: number | null }[]>`
        SELECT count(*) AS count,
               avg(extract(epoch FROM closed_at - created_at) / 60)::float8 AS avg_min,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at - created_at) / 60)::float8 AS median_min
        FROM conversations
        WHERE closed_at >= ${from} AND closed_at < ${to}
          AND close_reason IN ('resolved_by_ai', 'resolved_by_agent')`,
      prisma.$queryRaw<{ reason: string; count: bigint; avg_min: number }[]>`
        SELECT close_reason::text AS reason, count(*) AS count,
               avg(extract(epoch FROM closed_at - created_at) / 60)::float8 AS avg_min
        FROM conversations
        WHERE closed_at >= ${from} AND closed_at < ${to}
          AND close_reason IN ('resolved_by_ai', 'resolved_by_agent')
        GROUP BY close_reason`,
      prisma.$queryRaw<{ total: bigint; escalated: bigint }[]>`
        SELECT count(*) AS total,
               count(*) FILTER (WHERE EXISTS (SELECT 1 FROM escalations e WHERE e.conversation_id = c.id)) AS escalated
        FROM conversations c
        WHERE c.created_at >= ${from} AND c.created_at < ${to}`,
      prisma.$queryRaw<{ reason: string; count: bigint }[]>`
        SELECT e.reason::text AS reason, count(DISTINCT e.conversation_id) AS count
        FROM escalations e JOIN conversations c ON c.id = e.conversation_id
        WHERE c.created_at >= ${from} AND c.created_at < ${to}
        GROUP BY e.reason
        ORDER BY count DESC, reason`,
      prisma.$queryRaw<{ hour: number; count: bigint }[]>`
        SELECT extract(hour FROM created_at AT TIME ZONE ${ANALYTICS_TIMEZONE})::int AS hour, count(*) AS count
        FROM conversations
        WHERE created_at >= ${from} AND created_at < ${to}
        GROUP BY 1`,
      prisma.$queryRaw<{ id: string; close_reason: string | null; minutes: number }[]>`
        SELECT id::text, close_reason::text, (extract(epoch FROM closed_at - created_at) / 60)::float8 AS minutes
        FROM conversations
        WHERE closed_at >= ${from} AND closed_at < ${to}`,
    ]);

    const total = Number(escalation[0]!.total);
    const escalated = Number(escalation[0]!.escalated);
    const volumeByHour = Array.from({ length: 24 }, () => 0);
    for (const row of hours) volumeByHour[row.hour] = Number(row.count);

    const scores = closed
      .map((row) => simulatedCsatScore({ id: row.id, closeReason: row.close_reason, resolutionMinutes: row.minutes }))
      .filter((score): score is number => score !== null);

    return {
      window: { from: from.toISOString(), to: to.toISOString(), timezone: ANALYTICS_TIMEZONE },
      resolution: {
        resolved: Number(resolution[0]!.count),
        averageMinutes: round1(resolution[0]!.avg_min),
        medianMinutes: round1(resolution[0]!.median_min),
        byCloser: Object.fromEntries(
          byReason.map((row) => [row.reason, { resolved: Number(row.count), averageMinutes: round1(row.avg_min) }])
        ),
      },
      escalation: {
        conversations: total,
        escalated,
        ratePercent: total ? Math.round((escalated / total) * 1000) / 10 : null,
        byReason: escalationReasons.map((row) => ({ reason: row.reason, conversations: Number(row.count) })),
      },
      csat: summarizeCsat(scores),
      volumeByHour,
    };
  },
};
