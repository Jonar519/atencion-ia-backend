import type { ChannelType, ConversationStatus, MessageIntent, MessageSentiment, SenderType } from "@prisma/client";
import type { StaffEvent } from "./staffEvents";

/**
 * Eventos de tiempo real. Viajan por Redis pub/sub (bus.ts) para cruzar
 * procesos (API, worker) e instancias; cada instancia de la API los reparte a
 * sus WebSockets filtrando POR DESTINATARIO (audience.ts).
 *
 * Los eventos llevan el estado de la conversación que hace falta para decidir
 * quién puede recibirlos (dueño, agente asignado, estado): la decisión se toma
 * con los datos del momento del evento, no con una suscripción vieja.
 */

export interface ConversationRef {
  id: string;
  customerId: string;
  status: ConversationStatus;
  assignedAgentId: string | null;
  priority: number;
}

export interface RealtimeMessage {
  id: string;
  conversationId: string;
  senderType: SenderType;
  channel: ChannelType;
  content: string;
  createdAt: string;
  clientMsgId: string | null;
  agent: { id: string; name: string } | null;
  /** Análisis de IA del turno del cliente: SOLO para el staff (audience.ts lo quita al cliente). */
  intent: MessageIntent | null;
  sentiment: MessageSentiment | null;
}

export type RealtimeEvent =
  | { type: "message.created"; conversation: ConversationRef; message: RealtimeMessage }
  | {
      type: "conversation.updated";
      conversation: ConversationRef;
      /** Estado anterior: quien la veía antes (p. ej. en la cola) debe enterarse de que ya no está. */
      previous: Pick<ConversationRef, "status" | "assignedAgentId"> | null;
    }
  | StaffEvent;
