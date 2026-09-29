import { describe, expect, it } from "vitest";
import { audienceFor, type SocketIdentity } from "../../src/realtime/audience";
import type { ConversationRef, RealtimeEvent, RealtimeMessage } from "../../src/realtime/events";

const LAURA = "a0000000-0000-4000-8000-000000000002";
const DIEGO = "a0000000-0000-4000-8000-000000000003";
const CLIENTE_A = "b0000000-0000-4000-8000-00000000000a";
const CLIENTE_B = "b0000000-0000-4000-8000-00000000000b";

const laura: SocketIdentity = { kind: "staff", user: { staffId: LAURA, role: "agent" } };
const diego: SocketIdentity = { kind: "staff", user: { staffId: DIEGO, role: "agent" } };
const admin: SocketIdentity = {
  kind: "staff",
  user: { staffId: "a0000000-0000-4000-8000-000000000001", role: "admin" },
};
const clienteA: SocketIdentity = { kind: "customer", customerId: CLIENTE_A };
const clienteB: SocketIdentity = { kind: "customer", customerId: CLIENTE_B };

const conv = (overrides: Partial<ConversationRef> = {}): ConversationRef => ({
  id: "c0000000-0000-4000-8000-0000000000aa",
  customerId: CLIENTE_A,
  status: "agent_active",
  assignedAgentId: LAURA,
  priority: 90,
  ...overrides,
});

const message: RealtimeMessage = {
  id: "10000000-0000-4000-8000-0000000000aa",
  conversationId: "c0000000-0000-4000-8000-0000000000aa",
  senderType: "customer",
  channel: "text",
  content: "Mi número de cuenta es 4412",
  createdAt: "2026-09-29T10:00:00.000Z",
  clientMsgId: null,
  agent: null,
  intent: "possible_fraud",
  sentiment: "angry",
};

const created = (c: ConversationRef, m = message): RealtimeEvent => ({
  type: "message.created",
  conversation: c,
  message: m,
});

describe("reparto de eventos por WebSocket: clientes", () => {
  it("el cliente recibe los mensajes de SU conversación, sin el análisis de la IA", () => {
    const payload = audienceFor(created(conv()), clienteA) as { message: Record<string, unknown> };
    expect(payload.message.content).toBe("Mi número de cuenta es 4412");
    expect(payload.message).not.toHaveProperty("intent");
    expect(payload.message).not.toHaveProperty("sentiment");
  });

  it("OTRO cliente no recibe nada de esa conversación (ni el mensaje ni el cambio de estado)", () => {
    expect(audienceFor(created(conv()), clienteB)).toBeNull();
    const updated: RealtimeEvent = { type: "conversation.updated", conversation: conv(), previous: null };
    expect(audienceFor(updated, clienteB)).toBeNull();
  });

  it("del agente, el cliente solo ve el nombre de pila (no su id)", () => {
    const fromAgent = {
      ...message,
      senderType: "agent" as const,
      agent: { id: LAURA, name: "Laura Méndez" },
      intent: null,
      sentiment: null,
    };
    const payload = audienceFor(created(conv(), fromAgent), clienteA) as {
      message: { agent: Record<string, unknown> };
    };
    expect(payload.message.agent).toEqual({ name: "Laura" });
  });

  it("del cambio de estado, el cliente ve solo id y estado (no el agente ni la prioridad)", () => {
    const payload = audienceFor({ type: "conversation.updated", conversation: conv(), previous: null }, clienteA);
    expect(payload).toEqual({ type: "conversation.updated", conversation: { id: conv().id, status: "agent_active" } });
  });

  it("los avisos de escalamiento nunca llegan a un cliente", () => {
    const event: RealtimeEvent = {
      type: "escalation.created",
      escalationId: "e",
      conversationId: conv().id,
      reason: "possible_fraud",
      priority: 90,
      suggestedAgentId: LAURA,
      candidateAgentIds: [LAURA],
      createdAt: message.createdAt,
    };
    expect(audienceFor(event, clienteA)).toBeNull();
  });
});

describe("reparto de eventos por WebSocket: staff", () => {
  it("el agente asignado recibe los mensajes (con el análisis); otro agente NO", () => {
    expect(audienceFor(created(conv()), laura)).toMatchObject({ message: { intent: "possible_fraud" } });
    expect(audienceFor(created(conv()), diego)).toBeNull();
  });

  it("los mensajes de una conversación en la cola llegan a todos los agentes", () => {
    const enCola = conv({ status: "waiting_agent", assignedAgentId: null });
    expect(audienceFor(created(enCola), laura)).not.toBeNull();
    expect(audienceFor(created(enCola), diego)).not.toBeNull();
  });

  it("una conversación que atiende la IA no llega a los agentes; al admin sí", () => {
    const conIa = conv({ status: "ai_active", assignedAgentId: null });
    expect(audienceFor(created(conIa), laura)).toBeNull();
    expect(audienceFor(created(conIa), admin)).not.toBeNull();
  });

  it("cuando Laura toma un caso de la cola, Diego recibe UNA vez el aviso (visible:false), sin contenido", () => {
    const tomada: RealtimeEvent = {
      type: "conversation.updated",
      conversation: conv({ status: "agent_active", assignedAgentId: LAURA }),
      previous: { status: "waiting_agent", assignedAgentId: null },
    };
    expect(audienceFor(tomada, diego)).toMatchObject({ visible: false });
    expect(audienceFor(tomada, laura)).toMatchObject({ visible: true });
    expect(JSON.stringify(audienceFor(tomada, diego))).not.toContain("4412");
  });

  it("…y los mensajes que siguen ya no le llegan a Diego", () => {
    expect(audienceFor(created(conv({ status: "agent_active", assignedAgentId: LAURA })), diego)).toBeNull();
  });

  it("un cambio de estado de una conversación que nunca vio no le llega", () => {
    const ajena: RealtimeEvent = {
      type: "conversation.updated",
      conversation: conv({ status: "closed", assignedAgentId: LAURA }),
      previous: { status: "agent_active", assignedAgentId: LAURA },
    };
    expect(audienceFor(ajena, diego)).toBeNull();
    expect(audienceFor(ajena, laura)).not.toBeNull();
  });

  it("un rol desconocido no recibe nada (defensa en profundidad)", () => {
    const intruso: SocketIdentity = { kind: "staff", user: { staffId: DIEGO, role: "customer" as never } };
    expect(audienceFor(created(conv({ status: "waiting_agent", assignedAgentId: null })), intruso)).toBeNull();
  });
});
