import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import {
  app,
  authHeader,
  kbArticle,
  sendCustomerMessage,
  staffSession,
  widgetConversation,
  widgetSession,
} from "../helpers";
import { prisma } from "../../src/config/prisma";
import { createMockProvider } from "../../src/services/ai/mock.provider";
import { AiUnavailableError, setAiForTests } from "../../src/services/ai";
import { enqueueEscalationNotify } from "../../src/queues/queues";
import { handleCustomerTurn } from "../../src/modules/engine/conversationEngine";

beforeAll(async () => {
  await kbArticle(
    "¿Cómo bloqueo mi tarjeta?",
    "Si perdiste tu tarjeta, bloquéala en la app en Tarjetas y luego Bloquear. El bloqueo es inmediato y definitivo."
  );
  await kbArticle(
    "Horarios de atención",
    "Las oficinas atienden de lunes a viernes de 8:00 a 4:00. Los sábados de 9:00 a 12:00."
  );
});

afterEach(() => {
  setAiForTests(null);
  vi.mocked(enqueueEscalationNotify).mockClear();
});

async function newChat() {
  const session = await widgetSession();
  return { ...session, conversationId: await widgetConversation(session.token) };
}

describe("turno normal: RAG + respuesta", () => {
  it("responde con información de la KB y guarda cita, intención y consumo", async () => {
    const chat = await newChat();
    const res = await sendCustomerMessage(chat.token, chat.conversationId, "¿A qué hora abren las oficinas el sábado?");
    expect(res.status).toBe(201);
    expect(res.body.reply).toMatchObject({ sender: "ai" });
    expect(res.body.reply.content).toMatch(/sábados de 9:00 a 12:00/);
    expect(res.body.handedOffToAgent).toBe(false);

    const customer = await prisma.message.findUniqueOrThrow({ where: { id: res.body.message.id } });
    expect(customer).toMatchObject({ intent: "general_inquiry", sentiment: "neutral" });
    const ai = await prisma.message.findUniqueOrThrow({
      where: { id: res.body.reply.id },
      include: { citations: { include: { article: true } } },
    });
    expect(ai.aiModel).toBe("mock-chat-v1");
    // La cita apunta a un artículo que de verdad contiene lo que se respondió. (No se fija CUÁL artículo:
    // otros archivos de tests comparten la base y pueden haber creado otro de horarios igual de válido.)
    expect(ai.citations[0]?.article?.body).toContain("sábados de 9:00 a 12:00");

    const usage = await prisma.aiUsage.findMany({ where: { conversationId: chat.conversationId } });
    expect(usage.map((u) => u.kind).sort()).toEqual(["chat", "classification", "embedding"]);
    expect(usage.every((u) => u.customerId === chat.customerId)).toBe(true);
  });

  it("sin información en la KB lo dice, sin inventar; la segunda vez seguida escala a un humano", async () => {
    const chat = await newChat();
    const first = await sendCustomerMessage(
      chat.token,
      chat.conversationId,
      "¿Qué rentabilidad tiene el fondo de inversión Alfa?"
    );
    expect(first.body.reply.content).toMatch(/No encontré información/);
    expect(first.body.handedOffToAgent).toBe(false);

    const second = await sendCustomerMessage(
      chat.token,
      chat.conversationId,
      "¿Y la del fondo Omega de renta variable?"
    );
    expect(second.body.handedOffToAgent).toBe(true);
    expect(second.body.reply.sender).toBe("system");
    const escalation = await prisma.escalation.findFirstOrThrow({ where: { conversationId: chat.conversationId } });
    expect(escalation).toMatchObject({ reason: "low_confidence", triggerSource: "rule" });
  });
});

describe("escalamiento", () => {
  it("posible fraude: escala con prioridad 90, pasa a la cola, avisa a los agentes y NO gasta una respuesta del modelo", async () => {
    const chat = await newChat();
    const res = await sendCustomerMessage(
      chat.token,
      chat.conversationId,
      "Me aparece un cobro de 900.000 que yo NO hice!!"
    );
    expect(res.status).toBe(201);
    expect(res.body.conversationStatus).toBe("waiting_agent");
    expect(res.body.reply.sender).toBe("system");
    expect(res.body.reply.content).toMatch(/bloquea tu tarjeta/);

    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: chat.conversationId } });
    expect(conversation).toMatchObject({ status: "waiting_agent", priority: 90 });
    const escalation = await prisma.escalation.findFirstOrThrow({ where: { conversationId: chat.conversationId } });
    expect(escalation).toMatchObject({
      reason: "possible_fraud",
      triggerSource: "ai_signal",
      status: "open",
      triggeringMessageId: res.body.message.id,
    });
    expect(escalation.signal).toMatchObject({ rule: "fraud_signal", intent: "possible_fraud", provider: "mock" });
    expect(JSON.stringify(escalation.signal)).not.toContain("900.000"); // la evidencia no copia el texto del cliente
    expect(enqueueEscalationNotify).toHaveBeenCalledWith(escalation.id);

    const kinds = (await prisma.aiUsage.findMany({ where: { conversationId: chat.conversationId } })).map(
      (u) => u.kind
    );
    // Sin respuesta del modelo ("chat"): lo caro no se gasta. La búsqueda en la KB
    // (un embedding, barato) corre EN PARALELO con la clasificación para bajar la
    // latencia de cada turno, así que también se cuenta (docs/load-test-report.md).
    expect(kinds.sort()).toEqual(["classification", "embedding"]);
    expect(kinds).not.toContain("chat");
  });

  it("aparece en la cola del panel de agentes, ordenada por prioridad", async () => {
    const chat = await newChat();
    await sendCustomerMessage(chat.token, chat.conversationId, "Me robaron la tarjeta y hay compras que no reconozco");
    const { token } = await staffSession("agent");
    const queue = await request(app).get("/api/conversations?scope=queue").set(authHeader(token));
    const item = queue.body.items.find((c: { id: string }) => c.id === chat.conversationId);
    expect(item).toMatchObject({ status: "waiting_agent", priority: 90, openEscalation: { reason: "possible_fraud" } });
  });

  it("NO se duplica: 5 turnos de fraude simultáneos → 1 solo escalamiento abierto y 1 solo aviso", async () => {
    const chat = await newChat();
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        sendCustomerMessage(chat.token, chat.conversationId, `Cargo ${n} que no reconozco, es fraude`)
      )
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await prisma.escalation.count({ where: { conversationId: chat.conversationId } })).toBe(1);
    expect(enqueueEscalationNotify).toHaveBeenCalledTimes(1);
    // Un solo mensaje de traspaso, no cinco.
    expect(await prisma.message.count({ where: { conversationId: chat.conversationId, senderType: "system" } })).toBe(
      1
    );
  });

  it("una señal más grave sobre una conversación ya escalada sube su prioridad sin crear otro escalamiento", async () => {
    const chat = await newChat();
    await sendCustomerMessage(chat.token, chat.conversationId, "Quiero hablar con un asesor");
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: chat.conversationId } })).priority).toBe(60);
    await sendCustomerMessage(chat.token, chat.conversationId, "Además hay una compra que no hice");
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: chat.conversationId } });
    expect(conversation.priority).toBe(90);
    const escalations = await prisma.escalation.findMany({ where: { conversationId: chat.conversationId } });
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.priority).toBe(90);
  });

  it("con un agente atendiendo, la IA no interviene: el mensaje se guarda clasificado para el agente", async () => {
    const chat = await newChat();
    await sendCustomerMessage(chat.token, chat.conversationId, "Quiero hablar con una persona");
    const agent = await staffSession("agent");
    expect(
      (await request(app).post(`/api/conversations/${chat.conversationId}/take`).set(authHeader(agent.token))).status
    ).toBe(200);

    const res = await sendCustomerMessage(chat.token, chat.conversationId, "¿A qué hora abren el sábado?");
    expect(res.status).toBe(201);
    expect(res.body.reply).toBeNull();
    expect(res.body.conversationStatus).toBe("agent_active");
    expect(await prisma.message.count({ where: { conversationId: chat.conversationId, senderType: "ai" } })).toBe(0);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: res.body.message.id } })).intent).toBe(
      "general_inquiry"
    );
  });

  it("si el proveedor de IA se cae, el cliente no queda sin respuesta: se escala", async () => {
    const mock = createMockProvider();
    setAiForTests({
      provider: "mock",
      classifier: mock.classifier,
      embedder: mock.embedder,
      chat: { reply: async () => Promise.reject(new AiUnavailableError("simulado")) },
    });
    const chat = await newChat();
    const res = await sendCustomerMessage(chat.token, chat.conversationId, "¿Horario de los sábados?");
    expect(res.status).toBe(201);
    expect(res.body.handedOffToAgent).toBe(true);
    const escalation = await prisma.escalation.findFirstOrThrow({ where: { conversationId: chat.conversationId } });
    expect(escalation.signal).toMatchObject({ rule: "ai_unavailable" });
  });

  it("si falla el CLASIFICADOR, el mensaje se guarda igual (sin análisis) y la IA responde", async () => {
    const mock = createMockProvider();
    setAiForTests({
      provider: "mock",
      chat: mock.chat,
      embedder: mock.embedder,
      classifier: { classify: async () => Promise.reject(new AiUnavailableError("simulado")) },
    });
    const chat = await newChat();
    const res = await sendCustomerMessage(chat.token, chat.conversationId, "¿Horario de los sábados?");
    expect(res.status).toBe(201);
    expect(res.body.reply.sender).toBe("ai");
    expect((await prisma.message.findUniqueOrThrow({ where: { id: res.body.message.id } })).intent).toBeNull();
  });
});

describe("robustez del turno", () => {
  it("clasificar y buscar en la KB corren EN PARALELO (el cliente espera una llamada menos)", async () => {
    const mock = createMockProvider();
    const delay = <T>(ms: number, value: () => Promise<T>) =>
      new Promise<T>((resolve, reject) => setTimeout(() => value().then(resolve, reject), ms));
    const calls: string[] = [];
    setAiForTests({
      provider: "mock",
      chat: mock.chat,
      classifier: {
        classify: (text) => {
          calls.push("classify:start");
          return delay(200, () => mock.classifier.classify(text));
        },
      },
      embedder: {
        model: mock.embedder.model,
        embed: (texts, kind) => {
          calls.push(`embed:${kind}:start`);
          return delay(200, () => mock.embedder.embed(texts, kind));
        },
      },
    });
    const chat = await newChat();
    const started = Date.now();
    const res = await sendCustomerMessage(chat.token, chat.conversationId, "¿Cuál es el horario de atención?");
    const elapsed = Date.now() - started;
    expect(res.status).toBe(201);
    expect(res.body.reply).not.toBeNull();
    // Ambas empiezan antes de que termine cualquiera de las dos.
    expect(calls.slice(0, 2).sort()).toEqual(["classify:start", "embed:query:start"]);
    // En serie serían ≥ 400 ms; en paralelo, ~200 ms más la base.
    expect(elapsed).toBeLessThan(380);
  });

  it("idempotente: el mismo clientMsgId dos veces no duplica el mensaje ni la respuesta ni el consumo", async () => {
    const chat = await newChat();
    const clientMsgId = randomUUID();
    const first = await sendCustomerMessage(chat.token, chat.conversationId, "¿Horario del sábado?", clientMsgId);
    const retry = await sendCustomerMessage(chat.token, chat.conversationId, "¿Horario del sábado?", clientMsgId);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ duplicate: true, reply: null });
    expect(retry.body.message.id).toBe(first.body.message.id);
    expect(await prisma.message.count({ where: { conversationId: chat.conversationId } })).toBe(2);
    expect(await prisma.aiUsage.count({ where: { conversationId: chat.conversationId } })).toBe(3);
  });

  it("una conversación cerrada no acepta más mensajes", async () => {
    const chat = await newChat();
    await prisma.conversation.update({
      where: { id: chat.conversationId },
      data: { status: "closed", closedAt: new Date(Date.now() + 1_000), closeReason: "resolved_by_ai" },
    });
    expect((await sendCustomerMessage(chat.token, chat.conversationId, "hola")).status).toBe(409);
  });

  it("el motor es independiente del canal: un turno de VOZ pasa por la misma función y queda con su llamada", async () => {
    const chat = await newChat();
    const call = await prisma.call.create({
      data: {
        conversationId: chat.conversationId,
        consentGivenAt: new Date(Date.now() - 1_000),
        consentVersion: "v1",
        sttProvider: "mock",
        ttsProvider: "mock",
        retainUntil: new Date(Date.now() + 86_400_000),
      },
    });
    const result = await handleCustomerTurn({
      conversationId: chat.conversationId,
      customerId: chat.customerId,
      content: "a qué hora abren el sábado",
      channel: "voice",
      callId: call.id,
    });
    expect(result.customerMessage.channel).toBe("voice");
    expect(result.reply?.channel).toBe("voice");
    expect(result.reply?.content).toMatch(/sábados de 9:00 a 12:00/);
    const stored = await prisma.message.findMany({ where: { callId: call.id } });
    expect(stored).toHaveLength(2);
  });

  it("un turno de voz exige la llamada (y la base exige que sea de ESA conversación)", async () => {
    const chat = await newChat();
    await expect(
      handleCustomerTurn({
        conversationId: chat.conversationId,
        customerId: chat.customerId,
        content: "hola",
        channel: "voice",
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("costo: límites y tope diario por cliente", () => {
  it("con el tope diario agotado responde 429 sin llamar a la IA", async () => {
    const chat = await newChat();
    await prisma.aiUsage.create({
      data: {
        kind: "chat",
        provider: "mock",
        customerId: chat.customerId,
        unit: "tokens",
        inputUnits: 100_000,
        outputUnits: 0,
      },
    });
    const res = await sendCustomerMessage(chat.token, chat.conversationId, "¿Horario?");
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/límite diario/);
    expect(await prisma.message.count({ where: { conversationId: chat.conversationId } })).toBe(0);
  });

  it("rate limit por sesión del widget: el mensaje 13 en un minuto es 429", async () => {
    const chat = await newChat();
    const statuses: number[] = [];
    for (let i = 0; i < 13; i++)
      statuses.push((await sendCustomerMessage(chat.token, chat.conversationId, `hola ${i}`)).status);
    expect(statuses.slice(0, 12).every((s) => s !== 429)).toBe(true);
    expect(statuses[12]).toBe(429);
  });
});
