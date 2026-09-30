import { describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { app, authHeader, createConversation, staffSession } from "../helpers";
import { prisma } from "../../src/config/prisma";

const post = (token: string, path: string, body: object = {}) =>
  request(app).post(path).set(authHeader(token)).send(body);

describe("tomar una conversación de la cola", () => {
  it("la asigna, pasa el escalamiento a 'assigned' y deja un mensaje de sistema", async () => {
    const { staff, token } = await staffSession("agent");
    const { conversation } = await createConversation("waiting_agent");

    const res = await post(token, `/api/conversations/${conversation.id}/take`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "agent_active", assignedAgent: { id: staff.id } });

    const escalation = await prisma.escalation.findFirstOrThrow({ where: { conversationId: conversation.id } });
    expect(escalation).toMatchObject({ status: "assigned", assignedAgentId: staff.id });
    const system = await prisma.message.findFirst({ where: { conversationId: conversation.id, senderType: "system" } });
    expect(system?.content).toMatch(/se unió a la conversación/);
  });

  it("CARRERA: dos agentes la toman a la vez → uno gana (200) y el otro recibe 409", async () => {
    const [a, b] = await Promise.all([staffSession("agent"), staffSession("agent")]);
    const { conversation } = await createConversation("waiting_agent");

    const results = await Promise.all([
      post(a.token, `/api/conversations/${conversation.id}/take`),
      post(b.token, `/api/conversations/${conversation.id}/take`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

    const final = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    const winner = results[0]!.status === 200 ? a : b;
    expect(final.assignedAgentId).toBe(winner.staff.id);
    expect(await prisma.message.count({ where: { conversationId: conversation.id, senderType: "system" } })).toBe(1);
  });

  it("respeta el máximo de conversaciones simultáneas del agente, también en ráfaga", async () => {
    const { token } = await staffSession("agent", { maxConcurrent: 2 });
    const queue = await Promise.all([1, 2, 3, 4].map(() => createConversation("waiting_agent")));
    const results = await Promise.all(
      queue.map(({ conversation }) => post(token, `/api/conversations/${conversation.id}/take`))
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
  });

  it("un agente desactivado (con su access token aún vigente) no puede tomar conversaciones", async () => {
    const { staff, token } = await staffSession("agent");
    await prisma.staffUser.update({ where: { id: staff.id }, data: { isActive: false } });
    const { conversation } = await createConversation("waiting_agent");
    expect((await post(token, `/api/conversations/${conversation.id}/take`)).status).toBe(403);
  });
});

describe("mensajes del agente", () => {
  it("son idempotentes por clientMsgId: el reenvío devuelve el mismo mensaje (200) y no lo duplica", async () => {
    const { staff, token } = await staffSession("agent");
    const { conversation } = await createConversation("agent_active", staff.id);
    const body = { content: "Ya revisé tu caso.", clientMsgId: randomUUID() };

    const first = await post(token, `/api/conversations/${conversation.id}/messages`, body);
    const retry = await post(token, `/api/conversations/${conversation.id}/messages`, body);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(
      await prisma.message.count({ where: { conversationId: conversation.id, clientMsgId: body.clientMsgId } })
    ).toBe(1);
  });

  it("dos reenvíos SIMULTÁNEOS del mismo clientMsgId tampoco duplican", async () => {
    const { staff, token } = await staffSession("agent");
    const { conversation } = await createConversation("agent_active", staff.id);
    const body = { content: "Doble clic", clientMsgId: randomUUID() };
    const results = await Promise.all(
      [1, 2, 3].map(() => post(token, `/api/conversations/${conversation.id}/messages`, body))
    );
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await prisma.message.count({ where: { clientMsgId: body.clientMsgId } })).toBe(1);
  });

  it("actualiza last_message_at y valida el contenido", async () => {
    const { staff, token } = await staffSession("agent");
    const { conversation } = await createConversation("agent_active", staff.id);
    const res = await post(token, `/api/conversations/${conversation.id}/messages`, { content: "Hola" });
    const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(after.lastMessageAt.toISOString()).toBe(res.body.createdAt);

    for (const content of ["", "   ", "x".repeat(4001), "con \u0000 nulo"]) {
      expect((await post(token, `/api/conversations/${conversation.id}/messages`, { content })).status).toBe(400);
    }
  });
});

describe("cerrar una conversación", () => {
  it("la cierra, resuelve el escalamiento y ya no admite respuestas", async () => {
    const { staff, token } = await staffSession("agent");
    const { conversation } = await createConversation("agent_active", staff.id);

    const res = await post(token, `/api/conversations/${conversation.id}/close`, { note: "Resuelto por teléfono" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("closed");
    const escalation = await prisma.escalation.findFirstOrThrow({ where: { conversationId: conversation.id } });
    expect(escalation).toMatchObject({ status: "resolved", resolutionNote: "Resuelto por teléfono" });

    expect(
      (await post(token, `/api/conversations/${conversation.id}/messages`, { content: "¿Sigues ahí?" })).status
    ).toBe(409);
    expect((await post(token, `/api/conversations/${conversation.id}/close`)).status).toBe(409);
    // Cerrada, sigue siendo visible para el agente que la atendió (historial).
    expect((await request(app).get(`/api/conversations/${conversation.id}`).set(authHeader(token))).status).toBe(200);
  });

  it("un admin puede cerrar como spam una conversación en cola sin tomarla", async () => {
    const { token } = await staffSession("admin");
    const { conversation } = await createConversation("waiting_agent");
    const res = await post(token, `/api/conversations/${conversation.id}/close`, { reason: "spam" });
    expect(res.status).toBe(200);
    const row = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(row.closeReason).toBe("spam");
  });
});

describe("historial de mensajes", () => {
  it("pagina hacia atrás con cursor, cada página en orden cronológico y sin duplicar ni saltar", async () => {
    const { staff, token } = await staffSession("agent");
    const { conversation } = await createConversation("agent_active", staff.id);
    for (let i = 1; i <= 6; i++)
      await post(token, `/api/conversations/${conversation.id}/messages`, { content: `m${i}` });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/api/conversations/${conversation.id}/messages?limit=3${cursor ? `&cursor=${cursor}` : ""}`;
      const page = await request(app).get(url).set(authHeader(token));
      expect(page.status).toBe(200);
      const contents = page.body.items.map((m: { content: string }) => m.content);
      seen.unshift(...contents);
      cursor = page.body.nextCursor;
    } while (cursor);

    // 1 mensaje del cliente (helper) + 6 del agente, en orden y sin repetir.
    expect(seen).toEqual(["Hola, necesito ayuda con mi tarjeta", "m1", "m2", "m3", "m4", "m5", "m6"]);
  });

  it("un cursor manipulado es 400", async () => {
    const { staff, token } = await staffSession("agent");
    const { conversation } = await createConversation("agent_active", staff.id);
    const res = await request(app)
      .get(`/api/conversations/${conversation.id}/messages?cursor=basura`)
      .set(authHeader(token));
    expect(res.status).toBe(400);
  });
});

describe("auditoría de las acciones del agente", () => {
  it("ver, tomar, responder y cerrar quedan registrados con su autor, SIN el texto del mensaje", async () => {
    const { flushAudit } = await import("../../src/services/audit/audit.service");
    const { staff, token } = await staffSession("agent");
    const { conversation } = await createConversation("waiting_agent");
    await request(app).get(`/api/conversations/${conversation.id}`).set(authHeader(token)).expect(200);
    await post(token, `/api/conversations/${conversation.id}/take`).expect(200);
    await post(token, `/api/conversations/${conversation.id}/messages`, {
      content: "Tu clave NUNCA te la pediremos",
    }).expect(201);
    await post(token, `/api/conversations/${conversation.id}/close`, { reason: "resolved_by_agent" }).expect(200);
    await flushAudit();
    const rows = await prisma.auditLog.findMany({
      where: { entityType: "conversation", entityId: conversation.id },
      orderBy: { id: "asc" },
    });
    expect(rows.map((r) => [r.action, r.actorId])).toEqual([
      ["conversation.view", staff.id],
      ["conversation.take", staff.id],
      ["conversation.message", staff.id],
      ["conversation.close", staff.id],
    ]);
    expect(JSON.stringify(rows.map((r) => r.metadata))).not.toContain("NUNCA");
  });
});
