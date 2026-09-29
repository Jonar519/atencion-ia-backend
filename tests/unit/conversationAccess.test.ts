import { describe, expect, it } from "vitest";
import type { ConversationStatus } from "@prisma/client";
import { canClose, canReply, canViewConversation } from "../../src/modules/conversations/conversations.access";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const agent = { staffId: ME, role: "agent" as const };
const admin = { staffId: ME, role: "admin" as const };

describe("política de acceso a conversaciones", () => {
  it("un agente ve la cola general (en espera y sin asignar)", () => {
    expect(canViewConversation(agent, { status: "waiting_agent", assignedAgentId: null })).toBe(true);
  });

  it("un agente ve las suyas, en curso y ya cerradas", () => {
    expect(canViewConversation(agent, { status: "agent_active", assignedAgentId: ME })).toBe(true);
    expect(canViewConversation(agent, { status: "closed", assignedAgentId: ME })).toBe(true);
  });

  it("un agente NO ve las de otro agente, ni las que atiende la IA", () => {
    expect(canViewConversation(agent, { status: "agent_active", assignedAgentId: OTHER })).toBe(false);
    expect(canViewConversation(agent, { status: "closed", assignedAgentId: OTHER })).toBe(false);
    expect(canViewConversation(agent, { status: "ai_active", assignedAgentId: null })).toBe(false);
    expect(canViewConversation(agent, { status: "closed", assignedAgentId: null })).toBe(false);
  });

  it("un admin ve todas", () => {
    const statuses: ConversationStatus[] = ["ai_active", "waiting_agent", "agent_active", "closed"];
    for (const status of statuses) {
      expect(canViewConversation(admin, { status, assignedAgentId: OTHER })).toBe(true);
    }
  });

  it("un rol desconocido no ve nada (defensa en profundidad)", () => {
    const intruder = { staffId: ME, role: "customer" as never };
    expect(canViewConversation(intruder, { status: "waiting_agent", assignedAgentId: null })).toBe(false);
  });

  it("solo responde el agente asignado mientras la atiende; el admin también debe tomarla primero", () => {
    expect(canReply(agent, { status: "agent_active", assignedAgentId: ME })).toBe(true);
    expect(canReply(agent, { status: "waiting_agent", assignedAgentId: null })).toBe(false);
    expect(canReply(agent, { status: "closed", assignedAgentId: ME })).toBe(false);
    expect(canReply(admin, { status: "agent_active", assignedAgentId: OTHER })).toBe(false);
  });

  it("cierra el agente asignado o un admin; nadie cierra una ya cerrada", () => {
    expect(canClose(agent, { status: "agent_active", assignedAgentId: ME })).toBe(true);
    expect(canClose(agent, { status: "waiting_agent", assignedAgentId: null })).toBe(false);
    expect(canClose(admin, { status: "waiting_agent", assignedAgentId: null })).toBe(true);
    expect(canClose(admin, { status: "closed", assignedAgentId: null })).toBe(false);
  });
});
