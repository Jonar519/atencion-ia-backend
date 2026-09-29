import type { AuthUser } from "../middlewares/auth.middleware";
import { canViewConversation } from "../modules/conversations/conversations.access";
import type { RealtimeEvent } from "./events";

/**
 * QUIÉN RECIBE QUÉ por WebSocket. Función PURA: recibe un evento y la
 * identidad de un socket, y devuelve lo que ese socket puede ver (ya
 * recortado) o null si no debe recibir nada.
 *
 * Es la misma regla de autorización que la API REST, aplicada evento por
 * evento con el estado de la conversación DEL MOMENTO:
 *  - Cliente: solo eventos de SUS conversaciones, y sin el análisis de la IA
 *    sobre sus mensajes ni ids internos del staff (del agente, solo el nombre de pila).
 *  - Staff: solo lo que canViewConversation() le deja ver (su caso o la cola;
 *    un admin, todo). Cuando un caso sale de su alcance (otro agente lo tomó),
 *    recibe UNA vez el aviso de cambio de estado, sin contenido, para que su
 *    cola se actualice; los mensajes siguientes ya no le llegan.
 *  - Avisos de escalamiento: a todo el staff (la cola general es visible para todos).
 */

export type SocketIdentity = { kind: "staff"; user: AuthUser } | { kind: "customer"; customerId: string };

export function audienceFor(event: RealtimeEvent, identity: SocketIdentity): Record<string, unknown> | null {
  if (identity.kind === "customer") return forCustomer(event, identity.customerId);
  return forStaff(event, identity.user);
}

function forCustomer(event: RealtimeEvent, customerId: string): Record<string, unknown> | null {
  switch (event.type) {
    case "message.created": {
      if (event.conversation.customerId !== customerId) return null;
      const { intent: _intent, sentiment: _sentiment, agent, ...message } = event.message;
      return {
        type: event.type,
        conversation: { id: event.conversation.id, status: event.conversation.status },
        message: { ...message, agent: agent ? { name: firstName(agent.name) } : null },
      };
    }
    case "conversation.updated":
      if (event.conversation.customerId !== customerId) return null;
      return { type: event.type, conversation: { id: event.conversation.id, status: event.conversation.status } };
    default:
      // Escalamientos y demás eventos internos: nunca al cliente.
      return null;
  }
}

function forStaff(event: RealtimeEvent, user: AuthUser): Record<string, unknown> | null {
  switch (event.type) {
    case "message.created":
      return canViewConversation(user, event.conversation) ? { ...event } : null;
    case "conversation.updated": {
      const visibleNow = canViewConversation(user, event.conversation);
      const visibleBefore = event.previous !== null && canViewConversation(user, event.previous);
      if (!visibleNow && !visibleBefore) return null;
      return { type: event.type, conversation: event.conversation, visible: visibleNow };
    }
    case "escalation.created":
      return user.role === "admin" || user.role === "agent" ? { ...event } : null;
    default:
      return null;
  }
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? name;
}
