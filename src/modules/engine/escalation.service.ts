import { Prisma, type EscalationReason, type EscalationTrigger } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { escalationsCreated } from "../../observability/metrics";
import { enqueueEscalationNotify } from "../../queues/queues";

export interface EscalationRequest {
  conversationId: string;
  triggeringMessageId: string | null;
  callId: string | null;
  reason: EscalationReason;
  trigger: EscalationTrigger;
  priority: number;
  signal: Record<string, string | number | boolean | null>;
}

export type EscalationOutcome =
  { created: true; escalationId: string } | { created: false; escalationId: string | null };

/**
 * Registra un escalamiento SIN DUPLICAR: como máximo uno abierto por
 * conversación. La garantía la da la base (índice único parcial
 * uq_escalations_one_open_per_conversation) y aquí se usa con
 * INSERT … ON CONFLICT DO NOTHING: si dos turnos simultáneos deciden
 * escalar, uno inserta y el otro recibe "ya estaba escalada", sin error.
 * (Prisma no sabe apuntar a un índice parcial, por eso es SQL crudo.)
 *
 * En la misma transacción:
 *  - la conversación pasa de ai_active a waiting_agent (si seguía con la IA);
 *  - su prioridad sube a la del escalamiento (nunca baja).
 * Después de confirmar, se encola el aviso a los agentes (worker).
 */
export async function escalate(request: EscalationRequest): Promise<EscalationOutcome> {
  const outcome = await prisma.$transaction(async (tx) => {
    const inserted = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      INSERT INTO escalations (conversation_id, call_id, triggering_message_id, trigger_source, reason, signal, priority)
      VALUES (${request.conversationId}::uuid, ${request.callId}::uuid, ${request.triggeringMessageId}::uuid,
              ${request.trigger}::escalation_trigger, ${request.reason}::escalation_reason,
              ${JSON.stringify(request.signal)}::jsonb, ${request.priority})
      ON CONFLICT (conversation_id) WHERE status IN ('open', 'assigned') DO NOTHING
      RETURNING id`);

    // Con o sin escalamiento nuevo, una señal más grave sube la prioridad de la conversación.
    await tx.$executeRaw`
      UPDATE conversations
      SET priority = GREATEST(priority, ${request.priority}),
          status = CASE WHEN status = 'ai_active' THEN 'waiting_agent'::conversation_status ELSE status END
      WHERE id = ${request.conversationId}::uuid AND status <> 'closed'`;

    if (inserted[0]) return { created: true as const, escalationId: inserted[0].id };

    // Ya había uno abierto: también sube SU prioridad, para que la bandeja la ordene bien.
    const existing = await tx.$queryRaw<{ id: string }[]>`
      UPDATE escalations SET priority = GREATEST(priority, ${request.priority})
      WHERE conversation_id = ${request.conversationId}::uuid AND status IN ('open', 'assigned')
      RETURNING id`;
    return { created: false as const, escalationId: existing[0]?.id ?? null };
  });

  escalationsCreated.inc({
    reason: request.reason,
    trigger: request.trigger,
    result: outcome.created ? "created" : "deduplicated",
  });
  if (outcome.created) await enqueueEscalationNotify(outcome.escalationId);
  return outcome;
}
