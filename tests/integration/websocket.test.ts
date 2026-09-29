import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import request from "supertest";
import jwt from "jsonwebtoken";
import { WebSocket } from "ws";
import {
  app,
  authHeader,
  csrfHeader,
  freshIp,
  kbArticle,
  staffSession,
  widgetConversation,
  widgetSession,
} from "../helpers";
import { attachRealtime, WS_CLOSE, type RealtimeServer } from "../../src/realtime/wsServer";

/**
 * WebSocket con servidor HTTP real, clientes `ws` reales y el motor real.
 * El bus de Redis se reemplaza por uno en memoria (tests/support/memoryBus.ts).
 */

const ORIGIN = "http://localhost:5174";
let server: http.Server;
let realtime: RealtimeServer;
let wsUrl: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  realtime = await attachRealtime(server, { authTimeoutMs: 300 });
  wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  await kbArticle(
    "Horarios de atención",
    "Las oficinas atienden de lunes a viernes de 8:00 a 4:00. Los sábados de 9:00 a 12:00."
  );
});

afterAll(async () => {
  await realtime.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface TestSocket {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  closed: Promise<{ code: number; reason: string }>;
  waitFor(predicate: (m: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
}

function open(headers: Record<string, string> = {}): Promise<TestSocket> {
  const ws = new WebSocket(wsUrl, { headers: { Origin: ORIGIN, ...headers } });
  const messages: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
  }[] = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }))
  );
  const socket: TestSocket = {
    ws,
    messages,
    closed,
    waitFor(predicate, timeoutMs = 2_000) {
      const already = messages.find(predicate);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout esperando un mensaje del WebSocket")), timeoutMs);
        waiters.push({ predicate, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
  };
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(socket));
    ws.once("error", reject);
  });
}

async function staffSocket(token: string) {
  const socket = await open();
  socket.ws.send(JSON.stringify({ type: "auth", accessToken: token }));
  await socket.waitFor((m) => m.type === "ready");
  return socket;
}

async function customerSocket(token: string) {
  const socket = await open();
  socket.ws.send(JSON.stringify({ type: "auth", widgetToken: token }));
  await socket.waitFor((m) => m.type === "ready");
  return socket;
}

const sendAsCustomer = (token: string, conversationId: string, content: string) =>
  request(app).post(`/api/widget/conversations/${conversationId}/messages`).set(authHeader(token)).send({ content });

/** Da tiempo a que lleguen eventos que NO deberían llegar. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe("conexión y autenticación del WebSocket", () => {
  it("rechaza un Origin que no está en CORS_ORIGIN (cross-site WebSocket hijacking)", async () => {
    const ws = new WebSocket(wsUrl, { headers: { Origin: "https://sitio-malicioso.example" } });
    const status = await new Promise<number>((resolve) =>
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0))
    );
    expect(status).toBe(403);
  });

  it("sin autenticarse a tiempo, se cierra (4408)", async () => {
    const socket = await open();
    expect((await socket.closed).code).toBe(WS_CLOSE.authTimeout);
  });

  it("con un token inválido o de widget inexistente, se cierra (4401)", async () => {
    const a = await open();
    a.ws.send(JSON.stringify({ type: "auth", accessToken: "no.es.jwt" }));
    expect((await a.closed).code).toBe(WS_CLOSE.unauthorized);
    const b = await open();
    b.ws.send(JSON.stringify({ type: "auth", widgetToken: "wgt_inventado" }));
    expect((await b.closed).code).toBe(WS_CLOSE.unauthorized);
  });

  it("el staff se autentica con su access token; el cliente con la cookie httpOnly del upgrade", async () => {
    const { token } = await staffSession("agent");
    const staff = await open();
    staff.ws.send(JSON.stringify({ type: "auth", accessToken: token }));
    expect(await staff.waitFor((m) => m.type === "ready")).toMatchObject({ kind: "staff" });

    const created = await request(app)
      .post("/api/widget/sessions")
      .set("X-Forwarded-For", freshIp())
      .set(csrfHeader)
      .send({});
    const cookie = [created.headers["set-cookie"]]
      .flat()
      .find((c) => c?.startsWith("atencion_ia_widget="))!
      .split(";")[0]!;
    const customer = await open({ Cookie: cookie });
    customer.ws.send(JSON.stringify({ type: "auth" }));
    expect(await customer.waitFor((m) => m.type === "ready")).toMatchObject({ kind: "customer" });
    staff.ws.close();
    customer.ws.close();
  });

  it("se cierra cuando vence el token del staff (4409), para que el panel renueve y reconecte", async () => {
    const { staff } = await staffSession("agent");
    const shortLived = jwt.sign({ role: "agent" }, process.env.JWT_SECRET!, {
      subject: staff.id,
      issuer: "atencion-ia",
      audience: "atencion-ia-staff",
      expiresIn: 1,
    });
    const socket = await staffSocket(shortLived);
    expect((await socket.closed).code).toBe(WS_CLOSE.tokenExpired);
  });

  it("un cliente que inunda el socket de mensajes es desconectado (4429)", async () => {
    const { token } = await staffSession("agent");
    const socket = await staffSocket(token);
    for (let i = 0; i < 30; i++) socket.ws.send(JSON.stringify({ type: "ping" }));
    expect((await socket.closed).code).toBe(WS_CLOSE.tooManyMessages);
  });
});

describe("reparto en tiempo real con el motor y las acciones reales", () => {
  it("flujo completo: cada quien recibe SOLO lo que le corresponde", async () => {
    const [laura, diego] = await Promise.all([staffSession("agent"), staffSession("agent")]);
    const clienteA = await widgetSession("Cliente A");
    const clienteB = await widgetSession("Cliente B");
    const conv = await widgetConversation(clienteA.token);

    const sockets = {
      laura: await staffSocket(laura.token),
      diego: await staffSocket(diego.token),
      clienteA: await customerSocket(clienteA.token),
      clienteB: await customerSocket(clienteB.token),
    };
    const eventsFor = (s: TestSocket) => s.messages.filter((m) => m.type !== "ready");

    // 1. Consulta simple: la atiende la IA → llega al cliente A; a los agentes NO (no está en su alcance).
    await sendAsCustomer(clienteA.token, conv, "¿A qué hora abren el sábado?");
    const reply = await sockets.clienteA.waitFor(
      (m) => m.type === "message.created" && (m.message as { senderType: string }).senderType === "ai"
    );
    expect((reply.message as { content: string }).content).toMatch(/sábados de 9:00 a 12:00/);
    await settle();
    expect(eventsFor(sockets.laura)).toHaveLength(0);
    expect(eventsFor(sockets.diego)).toHaveLength(0);
    expect(eventsFor(sockets.clienteB)).toHaveLength(0);

    // 2. Fraude → escala: la conversación entra a la cola → ambos agentes la ven llegar.
    await sendAsCustomer(clienteA.token, conv, "Hay un cargo que no reconozco, es fraude");
    for (const agent of [sockets.laura, sockets.diego]) {
      await agent.waitFor(
        (m) => m.type === "conversation.updated" && (m.conversation as { status: string }).status === "waiting_agent"
      );
      const fraud = await agent.waitFor(
        (m) => m.type === "message.created" && (m.message as { intent: string }).intent === "possible_fraud"
      );
      expect(fraud).toBeDefined(); // el staff SÍ ve el análisis de la IA
    }
    const toCustomer = sockets.clienteA.messages.filter((m) => m.type === "message.created");
    expect(JSON.stringify(toCustomer)).not.toContain("possible_fraud"); // el cliente NO

    // 3. Laura la toma → Diego recibe el aviso de que salió de su alcance (visible:false)…
    expect((await request(app).post(`/api/conversations/${conv}/take`).set(authHeader(laura.token))).status).toBe(200);
    expect(await sockets.diego.waitFor((m) => m.type === "conversation.updated" && m.visible === false)).toBeDefined();
    const beforeDiego = eventsFor(sockets.diego).length;

    // 4. …y desde ahí la conversación es solo de Laura y del cliente.
    await request(app)
      .post(`/api/conversations/${conv}/messages`)
      .set(authHeader(laura.token))
      .send({ content: "Hola, soy Laura" });
    await sendAsCustomer(clienteA.token, conv, "Gracias Laura");
    await sockets.laura.waitFor(
      (m) => m.type === "message.created" && (m.message as { content: string }).content === "Gracias Laura"
    );
    const agentMsg = await sockets.clienteA.waitFor(
      (m) => m.type === "message.created" && (m.message as { content: string }).content === "Hola, soy Laura"
    );
    expect((agentMsg.message as { agent: unknown }).agent).toEqual({ name: "Agente" }); // solo el nombre de pila
    await settle();
    expect(eventsFor(sockets.diego).length).toBe(beforeDiego);
    expect(JSON.stringify(sockets.diego.messages)).not.toContain("Gracias Laura");
    expect(eventsFor(sockets.clienteB)).toHaveLength(0);

    for (const s of Object.values(sockets)) s.ws.close();
  });

  it("los avisos de escalamiento del worker llegan al staff y nunca al cliente", async () => {
    const { token } = await staffSession("agent");
    const cliente = await widgetSession();
    const staff = await staffSocket(token);
    const customer = await customerSocket(cliente.token);
    realtime.dispatch({
      type: "escalation.created",
      escalationId: "e0000000-0000-4000-8000-0000000000ff",
      conversationId: "c0000000-0000-4000-8000-0000000000ff",
      reason: "possible_fraud",
      priority: 90,
      suggestedAgentId: null,
      candidateAgentIds: [],
      createdAt: new Date().toISOString(),
    });
    expect(await staff.waitFor((m) => m.type === "escalation.created")).toMatchObject({ priority: 90 });
    await settle();
    expect(customer.messages.some((m) => m.type === "escalation.created")).toBe(false);
    staff.ws.close();
    customer.ws.close();
  });
});
