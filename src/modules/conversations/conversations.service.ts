import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { afterCursor, toPage } from "../../utils/pagination";
import { dbNow } from "../../utils/dbTime";
import type { AuthUser } from "../../middlewares/auth.middleware";
import { canClose, canReply, conversationScope } from "./conversations.access";
import type {
  CloseConversationInput,
  ListConversationsQuery,
  MessagesQuery,
  SendMessageInput,
} from "./conversations.schema";

const NOT_FOUND = "Conversación no encontrada";
const PREVIEW_CHARS = 140;
const OPEN_ESCALATION = { status: { in: ["open", "assigned"] } } satisfies Prisma.EscalationWhereInput;

const LIST_FIELDS = {
  id: true,
  status: true,
  subject: true,
  priority: true,
  originChannel: true,
  lastMessageAt: true,
  createdAt: true,
  customer: { select: { id: true, displayName: true } },
  assignedAgent: { select: { id: true, name: true } },
  escalations: {
    where: OPEN_ESCALATION,
    select: { reason: true, triggerSource: true, priority: true, createdAt: true },
    take: 1,
  },
  messages: {
    select: { senderType: true, channel: true, content: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1,
  },
} satisfies Prisma.ConversationSelect;

type ListRow = Prisma.ConversationGetPayload<{ select: typeof LIST_FIELDS }>;

function toListItem({ escalations, messages, ...row }: ListRow) {
  const last = messages[0];
  return {
    ...row,
    openEscalation: escalations[0] ?? null,
    lastMessage: last
      ? {
          senderType: last.senderType,
          channel: last.channel,
          preview: last.content.length > PREVIEW_CHARS ? `${last.content.slice(0, PREVIEW_CHARS)}…` : last.content,
          createdAt: last.createdAt,
        }
      : null,
  };
}

const MESSAGE_FIELDS = {
  id: true,
  senderType: true,
  channel: true,
  callId: true,
  content: true,
  intent: true,
  sentiment: true,
  analysisConfidence: true,
  clientMsgId: true,
  createdAt: true,
  senderAgent: { select: { id: true, name: true } },
  citations: {
    select: {
      rank: true,
      score: true,
      articleVersion: true,
      article: { select: { id: true, slug: true, title: true } },
    },
    orderBy: { rank: "asc" },
  },
} satisfies Prisma.MessageSelect;

/** Carga la conversación SOLO si el usuario puede verla; si no, 404 (no revela que existe). */
async function findVisible(user: AuthUser, id: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id, ...conversationScope(user) },
    select: { id: true, status: true, assignedAgentId: true },
  });
  if (!conversation) throw new ApiError(404, NOT_FOUND);
  return conversation;
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? name;
}

export const conversationsService = {
  async list(user: AuthUser, query: ListConversationsQuery) {
    const scope = query.scope ?? (user.role === "admin" ? "all" : "mine");
    if (scope === "all" && user.role !== "admin") {
      throw new ApiError(403, "Solo un administrador puede ver todas las conversaciones");
    }

    if (scope === "queue") {
      // La cola es corta por naturaleza: se ordena por urgencia, no por fecha,
      // y no se pagina con cursor (idx_conversations_queue).
      const rows = await prisma.conversation.findMany({
        where: { status: "waiting_agent", assignedAgentId: null },
        select: LIST_FIELDS,
        orderBy: [{ priority: "desc" }, { lastMessageAt: "asc" }, { id: "asc" }],
        take: query.limit,
      });
      return { items: rows.map(toListItem), nextCursor: null };
    }

    const where: Prisma.ConversationWhereInput = {
      ...(scope === "mine" ? { assignedAgentId: user.staffId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...afterCursor("lastMessageAt", query.cursor),
    };
    const rows = await prisma.conversation.findMany({
      where,
      select: LIST_FIELDS,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit, (row) => row.lastMessageAt);
    return { items: page.items.map(toListItem), nextCursor: page.nextCursor };
  },

  async get(user: AuthUser, id: string) {
    const conversation = await prisma.conversation.findFirst({
      where: { id, ...conversationScope(user) },
      select: {
        id: true,
        status: true,
        subject: true,
        priority: true,
        originChannel: true,
        lastMessageAt: true,
        closedAt: true,
        closeReason: true,
        createdAt: true,
        customer: { select: { id: true, displayName: true, email: true, phone: true, externalRef: true } },
        assignedAgent: { select: { id: true, name: true } },
        escalations: {
          select: {
            id: true,
            triggerSource: true,
            reason: true,
            signal: true,
            priority: true,
            status: true,
            triggeringMessageId: true,
            createdAt: true,
            assignedAt: true,
            resolvedAt: true,
            resolutionNote: true,
            assignedAgent: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: "desc" },
        },
        calls: {
          select: {
            id: true,
            status: true,
            startedAt: true,
            endedAt: true,
            durationSeconds: true,
            endReason: true,
            handledByAgent: { select: { id: true, name: true } },
          },
          orderBy: { startedAt: "desc" },
        },
        _count: { select: { messages: true } },
      },
    });
    if (!conversation) throw new ApiError(404, NOT_FOUND);
    const { _count, ...rest } = conversation;
    return { ...rest, messageCount: _count.messages };
  },

  /**
   * Historial de mensajes, del más reciente hacia atrás (el chat carga lo
   * último y pide más al subir). Cada página se devuelve en orden
   * cronológico; nextCursor apunta a mensajes más antiguos.
   */
  async messages(user: AuthUser, id: string, query: MessagesQuery) {
    await findVisible(user, id);
    const rows = await prisma.message.findMany({
      where: { conversationId: id, ...afterCursor("createdAt", query.cursor) },
      select: MESSAGE_FIELDS,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
    });
    const page = toPage(rows, query.limit, (row) => row.createdAt);
    return { items: page.items.reverse(), nextCursor: page.nextCursor };
  },

  /**
   * Tomar una conversación de la cola. Atómico y seguro ante carreras:
   *  1. Se bloquea la fila del agente (FOR UPDATE): dos "tomar" simultáneos
   *     del MISMO agente no pueden saltarse su máximo de conversaciones.
   *  2. El UPDATE solo afecta si la conversación SIGUE en cola y sin agente:
   *     si dos agentes la toman a la vez, Postgres serializa la fila y el
   *     segundo ve 0 filas afectadas → 409.
   *  3. El escalamiento abierto pasa a "assigned" y se deja un mensaje de
   *     sistema para el cliente, todo en la misma transacción.
   */
  async take(user: AuthUser, id: string) {
    return prisma.$transaction(async (tx) => {
      const [agent] = await tx.$queryRaw<{ name: string; is_active: boolean; max_concurrent: number }[]>`
        SELECT name, is_active, max_concurrent FROM staff_users WHERE id = ${user.staffId}::uuid FOR UPDATE`;
      if (!agent?.is_active) throw new ApiError(403, "Tu cuenta está desactivada");

      const active = await tx.conversation.count({ where: { assignedAgentId: user.staffId, status: "agent_active" } });
      if (active >= agent.max_concurrent) {
        throw new ApiError(409, `Ya atiendes ${active} conversaciones, tu máximo. Cierra una antes de tomar otra.`);
      }

      const now = await dbNow(tx);
      const { count } = await tx.conversation.updateMany({
        where: { id, status: "waiting_agent", assignedAgentId: null },
        data: { status: "agent_active", assignedAgentId: user.staffId, lastMessageAt: now },
      });
      if (count === 0) {
        const current = await tx.conversation.findUnique({
          where: { id },
          select: { status: true, assignedAgentId: true },
        });
        if (!current) throw new ApiError(404, NOT_FOUND);
        if (current.assignedAgentId === user.staffId) throw new ApiError(409, "Ya estás atendiendo esta conversación");
        // Tomada por otro agente mientras la mirabas: el agente la vio en la
        // cola, así que decirle que ya no está no revela nada nuevo. Si nunca
        // estuvo en su alcance, 404.
        if (current.status === "agent_active" || user.role === "admin") {
          throw new ApiError(409, "Otro agente ya tomó esta conversación");
        }
        throw new ApiError(404, NOT_FOUND);
      }

      await tx.escalation.updateMany({
        where: { conversationId: id, status: "open" },
        data: { status: "assigned", assignedAgentId: user.staffId, assignedAt: now },
      });
      await tx.message.create({
        data: {
          conversationId: id,
          senderType: "system",
          content: `${firstName(agent.name)} se unió a la conversación.`,
        },
      });
      return tx.conversation.findUniqueOrThrow({ where: { id }, select: LIST_FIELDS }).then(toListItem);
    });
  },

  async close(user: AuthUser, id: string, input: CloseConversationInput) {
    const conversation = await findVisible(user, id);
    if (!canClose(user, conversation)) {
      throw new ApiError(
        409,
        conversation.status === "closed"
          ? "La conversación ya está cerrada"
          : "Solo el agente asignado o un administrador pueden cerrarla"
      );
    }

    return prisma.$transaction(async (tx) => {
      const now = await dbNow(tx);
      // Condicionado al estado leído: si cambió entre la lectura y la escritura, 409.
      const { count } = await tx.conversation.updateMany({
        where: { id, status: conversation.status, assignedAgentId: conversation.assignedAgentId },
        data: { status: "closed", closedAt: now, closeReason: input.reason },
      });
      if (count === 0) throw new ApiError(409, "La conversación cambió mientras la cerrabas. Recárgala.");
      await tx.escalation.updateMany({
        where: { conversationId: id, ...OPEN_ESCALATION },
        data: { status: "resolved", resolvedAt: now, resolutionNote: input.note ?? null },
      });
      await tx.message.create({
        data: { conversationId: id, senderType: "system", content: "La conversación fue cerrada." },
      });
      return tx.conversation.findUniqueOrThrow({ where: { id }, select: LIST_FIELDS }).then(toListItem);
    });
  },

  /**
   * Respuesta de un agente al cliente. Idempotente por clientMsgId: si el
   * mismo mensaje llega dos veces (reconexión, doble clic), se devuelve el
   * que ya existe con `created: false` en vez de duplicarlo.
   */
  async sendAgentMessage(user: AuthUser, id: string, input: SendMessageInput) {
    const conversation = await findVisible(user, id);
    if (!canReply(user, conversation)) {
      throw new ApiError(409, "Solo el agente que atiende la conversación puede responder. Tómala primero.");
    }
    const agent = await prisma.staffUser.findUnique({ where: { id: user.staffId }, select: { isActive: true } });
    if (!agent?.isActive) throw new ApiError(403, "Tu cuenta está desactivada");

    if (input.clientMsgId) {
      const existing = await prisma.message.findUnique({
        where: { conversationId_clientMsgId: { conversationId: id, clientMsgId: input.clientMsgId } },
        select: MESSAGE_FIELDS,
      });
      if (existing) return { message: existing, created: false };
    }

    try {
      const message = await prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            conversationId: id,
            senderType: "agent",
            senderAgentId: user.staffId,
            content: input.content,
            clientMsgId: input.clientMsgId ?? null,
          },
          select: MESSAGE_FIELDS,
        });
        await tx.conversation.update({ where: { id }, data: { lastMessageAt: created.createdAt } });
        return created;
      });
      return { message, created: true };
    } catch (err) {
      // Carrera entre dos reenvíos simultáneos del mismo clientMsgId: gana uno.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && input.clientMsgId) {
        const existing = await prisma.message.findUniqueOrThrow({
          where: { conversationId_clientMsgId: { conversationId: id, clientMsgId: input.clientMsgId } },
          select: MESSAGE_FIELDS,
        });
        return { message: existing, created: false };
      }
      throw err;
    }
  },
};
