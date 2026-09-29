import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { ConversationStatus } from "@prisma/client";
import { app, authHeader, createConversation, staffSession } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { canViewConversation, conversationScope } from "../../src/modules/conversations/conversations.access";

/**
 * El requisito central de la fase: un agente NO puede ver conversaciones que
 * no le pertenecen. Laura y Diego (como en el seed) tienen casos distintos.
 */
describe("autorización por dueño en conversaciones", () => {
  let laura: Awaited<ReturnType<typeof staffSession>>;
  let diego: Awaited<ReturnType<typeof staffSession>>;
  let admin: Awaited<ReturnType<typeof staffSession>>;
  let deDiego: string;
  let deLaura: string;
  let enCola: string;
  let conLaIa: string;

  beforeAll(async () => {
    [laura, diego, admin] = await Promise.all([staffSession("agent"), staffSession("agent"), staffSession("admin")]);
    deDiego = (await createConversation("agent_active", diego.staff.id)).conversation.id;
    deLaura = (await createConversation("agent_active", laura.staff.id)).conversation.id;
    enCola = (await createConversation("waiting_agent")).conversation.id;
    conLaIa = (await createConversation("ai_active")).conversation.id;
  });

  const get = (token: string, path: string) => request(app).get(path).set(authHeader(token));

  it("Laura NO puede ver la conversación de Diego: 404 (no 403, no revela que existe)", async () => {
    const res = await get(laura.token, `/api/conversations/${deDiego}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Conversación no encontrada");
  });

  it("…ni su historial de mensajes, ni responder, ni cerrarla, ni tomarla", async () => {
    expect((await get(laura.token, `/api/conversations/${deDiego}/messages`)).status).toBe(404);
    const reply = await request(app)
      .post(`/api/conversations/${deDiego}/messages`)
      .set(authHeader(laura.token))
      .send({ content: "Hola, soy Laura" });
    expect(reply.status).toBe(404);
    const close = await request(app).post(`/api/conversations/${deDiego}/close`).set(authHeader(laura.token)).send({});
    expect(close.status).toBe(404);
    const take = await request(app).post(`/api/conversations/${deDiego}/take`).set(authHeader(laura.token));
    expect(take.status).toBe(409); // ya atendida por otro agente: "Otro agente ya tomó esta conversación"
    const messages = await prisma.message.count({ where: { conversationId: deDiego, senderAgentId: laura.staff.id } });
    expect(messages).toBe(0);
  });

  it("una conversación que atiende la IA (sin escalar) es invisible para los agentes, incluso para tomarla", async () => {
    expect((await get(laura.token, `/api/conversations/${conLaIa}`)).status).toBe(404);
    expect((await request(app).post(`/api/conversations/${conLaIa}/take`).set(authHeader(laura.token))).status).toBe(
      404
    );
  });

  it("ambos agentes ven la cola general ANTES de tomar un caso, con su historial", async () => {
    for (const agent of [laura, diego]) {
      expect((await get(agent.token, `/api/conversations/${enCola}`)).status).toBe(200);
      expect((await get(agent.token, `/api/conversations/${enCola}/messages`)).status).toBe(200);
      const queue = await get(agent.token, "/api/conversations?scope=queue");
      expect(queue.body.items.map((c: { id: string }) => c.id)).toContain(enCola);
    }
  });

  it('"mine" solo devuelve lo asignado a quien pregunta', async () => {
    const mine = await get(laura.token, "/api/conversations?scope=mine");
    const ids = mine.body.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(deLaura);
    expect(ids).not.toContain(deDiego);
    for (const item of mine.body.items) expect(item.assignedAgent.id).toBe(laura.staff.id);
  });

  it("un agente no puede pedir scope=all (403); un admin sí, y ve la de Diego", async () => {
    expect((await get(laura.token, "/api/conversations?scope=all")).status).toBe(403);
    const all = await get(admin.token, "/api/conversations?scope=all&limit=100");
    expect(all.status).toBe(200);
    expect((await get(admin.token, `/api/conversations/${deDiego}`)).status).toBe(200);
  });

  it("el admin tampoco puede responder una conversación que no tomó (un solo responsable)", async () => {
    const res = await request(app)
      .post(`/api/conversations/${deDiego}/messages`)
      .set(authHeader(admin.token))
      .send({ content: "Hola" });
    expect(res.status).toBe(409);
  });

  it("filtro Prisma y predicado coinciden en TODAS las combinaciones estado × asignación", async () => {
    const statuses: ConversationStatus[] = ["ai_active", "waiting_agent", "agent_active", "closed"];
    const owners = [null, laura.staff.id, diego.staff.id];
    const ids: string[] = [];
    for (const status of statuses) {
      for (const owner of owners) {
        // Combinaciones que el esquema prohíbe (agent_active sin agente) se saltan: la base las rechaza.
        if (status === "agent_active" && owner === null) continue;
        ids.push((await createConversation(status, owner)).conversation.id);
      }
    }
    const user = { staffId: laura.staff.id, role: "agent" as const };
    const visible = await prisma.conversation.findMany({
      where: { id: { in: ids }, ...conversationScope(user) },
      select: { id: true },
    });
    const rows = await prisma.conversation.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, assignedAgentId: true },
    });
    const expected = rows.filter((row) => canViewConversation(user, row)).map((row) => row.id);
    expect(visible.map((row) => row.id).sort()).toEqual(expected.sort());
  });
});

describe("autorización por rol", () => {
  it("un agente puede LEER la base de conocimiento pero no crear, editar ni borrar artículos", async () => {
    const { token } = await staffSession("agent");
    expect((await request(app).get("/api/kb/articles").set(authHeader(token))).status).toBe(200);
    const create = await request(app)
      .post("/api/kb/articles")
      .set(authHeader(token))
      .send({ slug: "intento", title: "Intento", body: "Un agente no debería poder crear esto", category: "x" });
    expect(create.status).toBe(403);
    const article = await prisma.kbArticle.create({
      data: { slug: `art-${Date.now()}`, title: "T", body: "Cuerpo del artículo", category: "c" },
    });
    expect(
      (await request(app).patch(`/api/kb/articles/${article.id}`).set(authHeader(token)).send({ title: "Hackeado" }))
        .status
    ).toBe(403);
    expect((await request(app).delete(`/api/kb/articles/${article.id}`).set(authHeader(token))).status).toBe(403);
  });

  it("un agente no puede listar ni crear staff", async () => {
    const { token } = await staffSession("agent");
    expect((await request(app).get("/api/staff").set(authHeader(token))).status).toBe(403);
    const res = await request(app)
      .post("/api/staff")
      .set(authHeader(token))
      .send({ name: "Otro Admin", email: "otro@test.example", password: "Una-Clave-Larga-2026", role: "admin" });
    expect(res.status).toBe(403);
  });

  it("sin token, todo /api (salvo login) es 401", async () => {
    for (const path of ["/api/conversations", "/api/kb/articles", "/api/staff", "/api/auth/me"]) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });
});
