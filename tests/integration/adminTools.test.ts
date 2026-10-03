import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app, authHeader, createConversation, staffSession, unique } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { analyticsService } from "../../src/modules/analytics/analytics.service";
import { simulatedCsatScore } from "../../src/modules/analytics/csat";

describe("respuestas predefinidas", () => {
  it("un admin las crea, edita, desactiva y borra; el asesor solo lee las ACTIVAS", async () => {
    const admin = await staffSession("admin");
    const agent = await staffSession("agent");
    const title = `Saludo ${unique()}`;
    const created = await request(app)
      .post("/api/canned-responses")
      .set(authHeader(admin.token))
      .send({
        title,
        body: "Hola {cliente}, soy {asesor}. ¿En qué te ayudo?",
        shortcut: `saludo-${unique().replace(/\D/g, "")}`,
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const seen = await request(app).get("/api/canned-responses").set(authHeader(agent.token));
    expect(seen.body.items.map((i: { id: string }) => i.id)).toContain(id);

    const off = await request(app)
      .patch(`/api/canned-responses/${id}`)
      .set(authHeader(admin.token))
      .send({ isActive: false });
    expect(off.body.isActive).toBe(false);
    const hidden = await request(app).get("/api/canned-responses").set(authHeader(agent.token));
    expect(hidden.body.items.map((i: { id: string }) => i.id)).not.toContain(id);
    const all = await request(app).get("/api/canned-responses?includeInactive=true").set(authHeader(admin.token));
    expect(all.body.items.map((i: { id: string }) => i.id)).toContain(id);

    expect((await request(app).delete(`/api/canned-responses/${id}`).set(authHeader(admin.token))).status).toBe(204);
    expect((await request(app).delete(`/api/canned-responses/${id}`).set(authHeader(admin.token))).status).toBe(404);
  });

  it("un asesor NO puede crear, editar, borrar ni ver las desactivadas", async () => {
    const admin = await staffSession("admin");
    const agent = await staffSession("agent");
    const created = await request(app)
      .post("/api/canned-responses")
      .set(authHeader(admin.token))
      .send({ title: `Cierre ${unique()}`, body: "Gracias por escribirnos." });
    const id = created.body.id as string;
    const attempts = [
      request(app).post("/api/canned-responses").set(authHeader(agent.token)).send({ title: "Mía", body: "texto" }),
      request(app).patch(`/api/canned-responses/${id}`).set(authHeader(agent.token)).send({ body: "cambiado" }),
      request(app).delete(`/api/canned-responses/${id}`).set(authHeader(agent.token)),
      request(app).get("/api/canned-responses?includeInactive=true").set(authHeader(agent.token)),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403);
    expect((await prisma.cannedResponse.findUniqueOrThrow({ where: { id } })).body).toBe("Gracias por escribirnos.");
  });

  it("título repetido (sin distinguir mayúsculas) → 409; atajo inválido o campo extra → 400", async () => {
    const admin = await staffSession("admin");
    const title = `Espera ${unique()}`;
    await request(app)
      .post("/api/canned-responses")
      .set(authHeader(admin.token))
      .send({ title, body: "Un momento, por favor." });
    const dup = await request(app)
      .post("/api/canned-responses")
      .set(authHeader(admin.token))
      .send({ title: `  ${title.toUpperCase()} `, body: "Otro" });
    expect(dup.status).toBe(409);
    for (const body of [
      { title: "Uno", body: "x", shortcut: "con espacios" },
      { title: "Dos", body: "x", createdBy: admin.staff.id },
      { title: "Tres", body: "" },
    ]) {
      expect((await request(app).post("/api/canned-responses").set(authHeader(admin.token)).send(body)).status).toBe(
        400
      );
    }
  });
});

describe("analítica (solo admin)", () => {
  it("un asesor recibe 403; un admin recibe el resumen con el CSAT marcado como simulado", async () => {
    const admin = await staffSession("admin");
    const agent = await staffSession("agent");
    expect((await request(app).get("/api/admin/analytics").set(authHeader(agent.token))).status).toBe(403);
    const res = await request(app).get("/api/admin/analytics?days=30").set(authHeader(admin.token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ days: 30, csat: { simulated: true }, window: { timezone: "America/Bogota" } });
    expect(res.body.volumeByHour).toHaveLength(24);
    expect((await request(app).get("/api/admin/analytics?days=365").set(authHeader(admin.token))).status).toBe(400);
  });

  // Ventana en 2020: ningún otro test crea datos ahí, así que los números son exactos.
  const WINDOW = { from: new Date("2020-03-01T00:00:00Z"), to: new Date("2020-03-08T00:00:00Z") };
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const customer = await prisma.customer.create({ data: { displayName: "Analítica" } });
    const closed = async (key: string, createdAt: string, minutes: number, closeReason: string) => {
      const created = new Date(createdAt);
      const row = await prisma.conversation.create({
        data: {
          customerId: customer.id,
          status: "closed",
          originChannel: "text",
          createdAt: created,
          lastMessageAt: created,
          closedAt: new Date(created.getTime() + minutes * 60_000),
          closeReason: closeReason as never,
        },
      });
      ids[key] = row.id;
      return row;
    };
    const escalate = async (key: string, reason: string) => {
      const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: ids[key]! } });
      await prisma.escalation.create({
        data: {
          conversationId: conversation.id,
          triggerSource: "rule",
          reason: reason as never,
          status: "resolved",
          createdAt: conversation.createdAt,
          resolvedAt: conversation.closedAt,
        },
      });
    };
    // 09:10 Bogotá, la IA resuelve en 10 min.
    await closed("c1", "2020-03-02T14:10:00Z", 10, "resolved_by_ai");
    // 10:00, escala y un asesor resuelve en 50 min.
    await closed("c2", "2020-03-02T15:00:00Z", 50, "resolved_by_agent");
    await escalate("c2", "human_requested");
    // 10:30, posible fraude, asesor en 20 min.
    await closed("c3", "2020-03-03T15:30:00Z", 20, "resolved_by_agent");
    await escalate("c3", "possible_fraud");
    // 22:00 del día anterior en Bogotá (03:00 UTC): el cliente abandona.
    await closed("c4", "2020-03-04T03:00:00Z", 5, "customer_abandoned");
    // 15:00, sigue abierta con la IA.
    const open = await prisma.conversation.create({
      data: {
        customerId: customer.id,
        status: "ai_active",
        originChannel: "text",
        createdAt: new Date("2020-03-05T20:00:00Z"),
        lastMessageAt: new Date("2020-03-05T20:00:00Z"),
      },
    });
    ids.c5 = open.id;
    // Creada ANTES de la ventana y cerrada dentro: cuenta para la resolución, no para volumen ni escalamiento.
    await closed("c6", "2020-02-29T12:00:00Z", 1440, "resolved_by_ai");
    // 08:00, spam: no es una resolución ni entra al CSAT, pero sí es volumen.
    await closed("c7", "2020-03-06T13:00:00Z", 1, "spam");
  });

  it("tiempo de resolución: solo lo resuelto y cerrado en la ventana (promedio 380 min, mediana 35)", async () => {
    const { resolution } = await analyticsService.summary(WINDOW);
    expect(resolution).toEqual({
      resolved: 4,
      averageMinutes: 380, // (10 + 50 + 20 + 1440) / 4
      medianMinutes: 35, // (20 + 50) / 2
      byCloser: {
        resolved_by_ai: { resolved: 2, averageMinutes: 725 },
        resolved_by_agent: { resolved: 2, averageMinutes: 35 },
      },
    });
  });

  it("tasa de escalamiento: 2 de las 6 creadas en la ventana, por motivo", async () => {
    const { escalation } = await analyticsService.summary(WINDOW);
    expect(escalation).toEqual({
      conversations: 6,
      escalated: 2,
      ratePercent: 33.3,
      byReason: [
        { reason: "human_requested", conversations: 1 },
        { reason: "possible_fraud", conversations: 1 },
      ],
    });
  });

  it("volumen por hora en hora de Bogotá (UTC−5), 24 franjas", async () => {
    const { volumeByHour } = await analyticsService.summary(WINDOW);
    const expected = Array.from({ length: 24 }, () => 0);
    expected[8] = 1; // c7
    expected[9] = 1; // c1
    expected[10] = 2; // c2, c3
    expected[15] = 1; // c5
    expected[22] = 1; // c4
    expect(volumeByHour).toEqual(expected);
  });

  it("CSAT simulado: 5 notas (sin el spam), las mismas que da la regla documentada", async () => {
    const { csat } = await analyticsService.summary(WINDOW);
    const minutes: Record<string, [number, string]> = {
      c1: [10, "resolved_by_ai"],
      c2: [50, "resolved_by_agent"],
      c3: [20, "resolved_by_agent"],
      c4: [5, "customer_abandoned"],
      c6: [1440, "resolved_by_ai"],
    };
    const scores = Object.entries(minutes).map(([key, [resolutionMinutes, closeReason]]) =>
      simulatedCsatScore({ id: ids[key]!, closeReason, resolutionMinutes })
    ) as number[];
    expect(csat.simulated).toBe(true);
    expect(csat.responses).toBe(5);
    expect(csat.distribution).toEqual([1, 2, 3, 4, 5].map((n) => scores.filter((s) => s === n).length));
    expect(csat.satisfiedPercent).toBe(Math.round((scores.filter((s) => s >= 4).length / 5) * 1000) / 10);
    // Determinista: repetir da exactamente lo mismo.
    expect((await analyticsService.summary(WINDOW)).csat).toEqual(csat);
  });

  it("no devuelve datos personales (ni ids de conversación ni nombres)", async () => {
    const summary = await analyticsService.summary(WINDOW);
    const text = JSON.stringify(summary);
    for (const id of Object.values(ids)) expect(text).not.toContain(id);
    expect(text).not.toContain("Analítica");
  });
});

describe("equipo: datos para reasignar", () => {
  it("la lista del equipo trae cuántos casos atiende cada uno", async () => {
    const admin = await staffSession("admin");
    const busy = await staffSession("agent");
    await createConversation("agent_active", busy.staff.id);
    await createConversation("agent_active", busy.staff.id);
    await createConversation("closed", busy.staff.id);
    const res = await request(app).get("/api/staff").set(authHeader(admin.token));
    const row = res.body.items.find((s: { id: string }) => s.id === busy.staff.id);
    expect(row.activeConversations).toBe(2);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|mfaSecret/);
  });

  it("un admin lista los casos de UN agente; el filtro no sirve fuera de scope=all ni para un asesor", async () => {
    const admin = await staffSession("admin");
    const owner = await staffSession("agent");
    const other = await staffSession("agent");
    const { conversation } = await createConversation("agent_active", owner.staff.id);
    await createConversation("agent_active", other.staff.id);
    const res = await request(app)
      .get(`/api/conversations?scope=all&status=agent_active&agentId=${owner.staff.id}`)
      .set(authHeader(admin.token));
    expect(res.body.items.map((c: { id: string }) => c.id)).toEqual([conversation.id]);
    expect(
      (await request(app).get(`/api/conversations?agentId=${owner.staff.id}`).set(authHeader(other.token))).status
    ).toBe(400);
    expect(
      (await request(app).get(`/api/conversations?scope=all&agentId=${owner.staff.id}`).set(authHeader(other.token)))
        .status
    ).toBe(403);
  });
});
