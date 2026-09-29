import { prisma } from "../config/prisma";
import { publishStaffEvent, type StaffEvent } from "../realtime/staffEvents";

/**
 * Aviso de un escalamiento nuevo a los agentes ("notificar a un agente
 * disponible"). Elige candidatos: activos, en estado "available" y con cupo
 * (conversaciones en curso < max_concurrent); sugiere el de menor carga
 * (desempate: el que lleva más tiempo sin recibir una). Publica el evento en
 * Redis; el panel (Fase 4) lo muestra a todos los candidatos y resalta al
 * sugerido. No asigna: tomar la conversación sigue siendo una acción explícita
 * del agente (POST /take), que es atómica.
 *
 * Devuelve el evento publicado (o null si el escalamiento ya no está abierto).
 */
export async function notifyEscalation(escalationId: string): Promise<StaffEvent | null> {
  const escalation = await prisma.escalation.findUnique({
    where: { id: escalationId },
    select: { id: true, conversationId: true, reason: true, priority: true, status: true, createdAt: true },
  });
  // Ya la tomaron o se resolvió mientras el trabajo esperaba en la cola: nada que avisar.
  if (!escalation || escalation.status !== "open") return null;

  const candidates = await prisma.$queryRaw<{ id: string; load: number }[]>`
    SELECT s.id, COUNT(c.id)::int AS load
    FROM staff_users s
    LEFT JOIN conversations c ON c.assigned_agent_id = s.id AND c.status = 'agent_active'
    WHERE s.is_active AND s.availability = 'available'
    GROUP BY s.id, s.max_concurrent
    HAVING COUNT(c.id) < s.max_concurrent
    ORDER BY COUNT(c.id) ASC, MAX(c.updated_at) ASC NULLS FIRST, s.id`;

  const event: StaffEvent = {
    type: "escalation.created",
    escalationId: escalation.id,
    conversationId: escalation.conversationId,
    reason: escalation.reason,
    priority: escalation.priority,
    suggestedAgentId: candidates[0]?.id ?? null,
    candidateAgentIds: candidates.map((candidate) => candidate.id),
    createdAt: escalation.createdAt.toISOString(),
  };
  await publishStaffEvent(event);
  return event;
}
