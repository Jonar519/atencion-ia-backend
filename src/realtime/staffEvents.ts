import { redisConnection } from "../config/redis";

/**
 * Eventos para el panel de agentes, publicados en Redis pub/sub. Así cruzan
 * procesos (el worker publica, la API los recibe) y, más adelante, varias
 * instancias de la API. En la Fase 4 el servidor WebSocket se suscribe a este
 * canal y los reenvía a los agentes conectados.
 *
 * Nunca llevan contenido de mensajes ni datos personales: solo ids y metadatos.
 */
export const STAFF_EVENTS_CHANNEL = "atencion-ia:staff-events";

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
  await redisConnection.publish(STAFF_EVENTS_CHANNEL, JSON.stringify(event));
}
