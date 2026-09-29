import type { ConversationStatus, Prisma } from "@prisma/client";
import type { AuthUser } from "../../middlewares/auth.middleware";

/**
 * ÚNICO lugar donde se decide qué conversaciones puede VER un miembro del staff:
 *
 *  - admin: todas.
 *  - agent: las que tiene asignadas (en curso o ya cerradas por él) y las de
 *    la COLA GENERAL (en espera de agente y sin asignar), para poder leer el
 *    historial completo ANTES de tomar un caso.
 *    No ve las que atiende la IA sin escalar, ni las de otros agentes.
 *
 * Si no puede verla, la API responde 404 (no 403): no se revela que existe.
 *
 * Existen dos formas de la misma regla y deben coincidir siempre:
 *  - conversationScope(): filtro Prisma, para consultar solo lo permitido.
 *  - canViewConversation(): predicado sobre una fila ya cargada.
 * tests/integration/authorization.test.ts compara ambas contra la base en
 * todas las combinaciones de estado × asignación.
 */
export function conversationScope(user: AuthUser): Prisma.ConversationWhereInput {
  switch (user.role) {
    case "admin":
      return {};
    case "agent":
      return { OR: [{ assignedAgentId: user.staffId }, { status: "waiting_agent", assignedAgentId: null }] };
    default:
      // Rol desconocido: no ve nada (defensa en profundidad).
      return { id: { in: [] } };
  }
}

export function canViewConversation(
  user: AuthUser,
  conversation: { status: ConversationStatus; assignedAgentId: string | null }
): boolean {
  if (user.role === "admin") return true;
  if (user.role !== "agent") return false;
  return (
    conversation.assignedAgentId === user.staffId ||
    (conversation.status === "waiting_agent" && conversation.assignedAgentId === null)
  );
}

/**
 * Quién puede ESCRIBIR en una conversación (responder al cliente): solo el
 * agente asignado mientras la atiende. Un admin también atiende, pero debe
 * tomarla primero, igual que un agente: así siempre hay UN responsable.
 */
export function canReply(
  user: AuthUser,
  conversation: { status: ConversationStatus; assignedAgentId: string | null }
): boolean {
  return conversation.status === "agent_active" && conversation.assignedAgentId === user.staffId;
}

/** Quién puede CERRAR: el agente asignado, o un admin (p. ej. spam en cola). */
export function canClose(
  user: AuthUser,
  conversation: { status: ConversationStatus; assignedAgentId: string | null }
): boolean {
  if (conversation.status === "closed") return false;
  return user.role === "admin" || conversation.assignedAgentId === user.staffId;
}
