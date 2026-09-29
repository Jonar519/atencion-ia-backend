import { publishRealtime } from "./bus";

/**
 * Evento de escalamiento para el panel de agentes (lo publica el worker,
 * notifyEscalation.ts). Viaja por el mismo bus que los demás eventos de
 * tiempo real y el servidor WebSocket lo entrega a todo el staff conectado.
 *
 * Nunca lleva contenido de mensajes ni datos personales: solo ids y metadatos.
 */
export type StaffEvent = {
  type: "escalation.created";
  escalationId: string;
  conversationId: string;
  reason: string;
  priority: number;
  /** Agente disponible con menos carga en el momento del aviso (null si no hay ninguno). */
  suggestedAgentId: string | null;
  /** Agentes activos y disponibles que pueden tomarla. */
  candidateAgentIds: string[];
  createdAt: string;
};

export async function publishStaffEvent(event: StaffEvent): Promise<void> {
  await publishRealtime(event);
}
