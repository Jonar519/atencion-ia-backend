import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import request from "supertest";
import { WebSocket } from "ws";
import {
  app,
  authHeader,
  createConversation,
  kbArticle,
  staffSession,
  widgetConversation,
  widgetSession,
} from "../helpers";
import { prisma } from "../../src/config/prisma";
import { attachRealtime, type RealtimeServer } from "../../src/realtime/wsServer";
import { attachVoice, VOICE_CLOSE, type VoiceServer } from "../../src/realtime/voiceServer";
import { encodeMockSpeech, createMockVoice } from "../../src/services/voice/mock.provider";
import { setVoiceForTests } from "../../src/services/voice";
import { setAiForTests } from "../../src/services/ai";
import { createMockProvider } from "../../src/services/ai/mock.provider";
import { callsService, PURGED_PLACEHOLDER } from "../../src/modules/voice/calls.service";
import { CONSENT_VERSION } from "../../src/modules/voice/consent";
import { tone } from "../../src/services/voice/pcm";
import { flushAudit } from "../../src/services/audit/audit.service";

/**
 * Voz de punta a punta: servidor HTTP real, WebSockets reales (/ws y /ws/voice),
 * el motor conversacional real y el proveedor de voz mock. Cada regla crítica
 * se intenta ROMPER desde afuera (otro cliente, otro agente, sin consentimiento,
 * audio a destajo, señalización a otra llamada…).
 */

const ORIGIN = "http://localhost:5174";
let server: http.Server;
let realtime: RealtimeServer;
let voice: VoiceServer;
let base: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  realtime = await attachRealtime(server, { authTimeoutMs: 300 });
  voice = await attachVoice(server, { authTimeoutMs: 300, reconnectGraceMs: 300, audioRealtimeFactor: 1_000 });
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await kbArticle(
    "Horarios de atención",
    "Las oficinas atienden de lunes a viernes de 8:00 a 4:00. Los sábados de 9:00 a 12:00."
  );
});

afterAll(async () => {
  await voice.close();
  await realtime.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  setVoiceForTests(null);
  setAiForTests(null);
});

type Message = Record<string, unknown>;
interface TestSocket {
  ws: WebSocket;
  messages: Message[];
  audioFrames: Buffer[];
  closed: Promise<{ code: number; reason: string }>;
  waitFor(predicate: (m: Message) => boolean, timeoutMs?: number): Promise<Message>;
}

function open(path: string, headers: Record<string, string> = {}): Promise<TestSocket> {
  const ws = new WebSocket(`${base}${path}`, { headers: { Origin: ORIGIN, ...headers } });
  const messages: Message[] = [];
  const audioFrames: Buffer[] = [];
  const waiters: { predicate: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      audioFrames.push(raw as Buffer);
      return;
    }
    const message = JSON.parse(raw.toString()) as Message;
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
    audioFrames,
    closed,
    waitFor(predicate, timeoutMs = 3_000) {
      const already = messages.find(predicate);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(`timeout esperando un mensaje. Recibidos: ${JSON.stringify(messages.map((m) => m.type))}`)
            ),
          timeoutMs
        );
        waiters.push({ predicate, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
  };
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(socket));
    ws.once("error", reject);
  });
}

const is = (type: string) => (m: Message) => m.type === type;
const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));

async function startCall(token: string, conversationId: string) {
  const res = await request(app)
    .post(`/api/widget/conversations/${conversationId}/calls`)
    .set(authHeader(token))
    .send({ consentVersion: CONSENT_VERSION, accepted: true });
  if (res.status !== 201) throw new Error(`startCall falló (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.call.id as string;
}

async function voiceSocket(auth: Record<string, unknown>) {
  const socket = await open("/ws/voice");
  socket.ws.send(JSON.stringify({ type: "auth", ...auth }));
  return socket;
}

async function customerVoice(token: string, callId: string) {
  const socket = await voiceSocket({ callId, widgetToken: token });
  await socket.waitFor(is("ready"));
  return socket;
}

async function agentVoice(accessToken: string, callId: string) {
  const socket = await voiceSocket({ callId, accessToken });
  await socket.waitFor(is("ready"));
  return socket;
}

async function staffEvents(accessToken: string) {
  const socket = await open("/ws");
  socket.ws.send(JSON.stringify({ type: "auth", accessToken }));
  await socket.waitFor(is("ready"));
  return socket;
}

function say(socket: TestSocket, text: string) {
  for (const frame of encodeMockSpeech(text)) socket.ws.send(frame);
}

/** Cliente con conversación y llamada en curso (audio conectado). */
async function customerInCall() {
  const session = await widgetSession();
  const conversationId = await widgetConversation(session.token);
  const callId = await startCall(session.token, conversationId);
  const socket = await customerVoice(session.token, callId);
  return { ...session, conversationId, callId, socket };
}

/** Lleva la llamada a "en espera de agente" diciendo algo que escala. */
async function escalate(socket: TestSocket) {
  say(socket, "No reconozco un cargo de 450.000 pesos en mi tarjeta");
  await socket.waitFor((m) => m.type === "call.status" && m.status === "waiting_agent");
}

describe("consentimiento e inicio de la llamada (REST)", () => {
  it("el aviso vigente se puede leer antes de llamar", async () => {
    const { token } = await widgetSession();
    const res = await request(app).get("/api/widget/voice/consent").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(CONSENT_VERSION);
    expect(res.body.points.join(" ")).toMatch(/no se graba/i);
    expect(res.body.retentionDays).toBe(90);
  });

  it("sin aceptar el aviso, o con una versión vieja, NO hay llamada", async () => {
    const { token } = await widgetSession();
    const conversationId = await widgetConversation(token);
    const url = `/api/widget/conversations/${conversationId}/calls`;
    expect((await request(app).post(url).set(authHeader(token)).send({ consentVersion: CONSENT_VERSION })).status).toBe(
      400
    );
    expect(
      (await request(app).post(url).set(authHeader(token)).send({ consentVersion: CONSENT_VERSION, accepted: false }))
        .status
    ).toBe(400);
    const old = await request(app).post(url).set(authHeader(token)).send({ consentVersion: "voz-v0", accepted: true });
    expect(old.status).toBe(409);
    expect(await prisma.call.count({ where: { conversationId } })).toBe(0);
  });

  it("registra consentimiento, retención y proveedores; y solo UNA llamada activa por conversación", async () => {
    const { token } = await widgetSession();
    const conversationId = await widgetConversation(token);
    const callId = await startCall(token, conversationId);
    const call = await prisma.call.findUniqueOrThrow({ where: { id: callId } });
    expect(call.status).toBe("connecting");
    expect(call.consentVersion).toBe(CONSENT_VERSION);
    expect(call.consentGivenAt.getTime()).toBeLessThanOrEqual(call.startedAt.getTime());
    const days = (call.retainUntil.getTime() - call.startedAt.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(90, 5);
    expect([call.sttProvider, call.ttsProvider, call.audioStorageKey]).toEqual(["mock", "mock", null]);

    const second = await request(app)
      .post(`/api/widget/conversations/${conversationId}/calls`)
      .set(authHeader(token))
      .send({ consentVersion: CONSENT_VERSION, accepted: true });
    expect(second.status).toBe(409);
  });

  it("un cliente no puede llamar en la conversación de OTRO (404) ni en una cerrada (409)", async () => {
    const owner = await widgetSession();
    const intruder = await widgetSession();
    const conversationId = await widgetConversation(owner.token);
    const res = await request(app)
      .post(`/api/widget/conversations/${conversationId}/calls`)
      .set(authHeader(intruder.token))
      .send({ consentVersion: CONSENT_VERSION, accepted: true });
    expect(res.status).toBe(404);

    // Conversación cerrada creada directo en la base: se prueba con el servicio.
    const { conversation, customer } = await createConversation("closed");
    await expect(
      callsService.start(
        { sessionId: "x", customerId: customer.id, expiresAt: new Date(Date.now() + 60_000) },
        conversation.id,
        { consentVersion: CONSENT_VERSION, accepted: true }
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("con el tope diario de voz agotado, no se puede llamar (429)", async () => {
    const { token, customerId } = await widgetSession();
    const conversationId = await widgetConversation(token);
    await prisma.aiUsage.create({
      data: { kind: "stt", provider: "mock", customerId, unit: "seconds", inputUnits: 1_800 },
    });
    const res = await request(app)
      .post(`/api/widget/conversations/${conversationId}/calls`)
      .set(authHeader(token))
      .send({ consentVersion: CONSENT_VERSION, accepted: true });
    expect(res.status).toBe(429);
  });

  it("el cliente consulta y cuelga SOLO sus llamadas", async () => {
    const owner = await widgetSession();
    const intruder = await widgetSession();
    const callId = await startCall(owner.token, await widgetConversation(owner.token));
    expect((await request(app).get(`/api/widget/calls/${callId}`).set(authHeader(intruder.token))).status).toBe(404);
    expect((await request(app).post(`/api/widget/calls/${callId}/end`).set(authHeader(intruder.token))).status).toBe(
      404
    );
    expect((await prisma.call.findUniqueOrThrow({ where: { id: callId } })).status).toBe("connecting");
    expect((await request(app).post(`/api/widget/calls/${callId}/end`).set(authHeader(owner.token))).status).toBe(204);
    const ended = await prisma.call.findUniqueOrThrow({ where: { id: callId } });
    // Nunca conectó el audio, pero la cortó el cliente: terminada, sin duración.
    expect([ended.status, ended.endReason, ended.durationSeconds]).toEqual(["ended", "customer_hangup", null]);
  });
});

describe("autenticación del WebSocket de voz", () => {
  it("rechaza un Origin ajeno (403)", async () => {
    const ws = new WebSocket(`${base}/ws/voice`, { headers: { Origin: "https://sitio-malicioso.example" } });
    const status = await new Promise<number>((resolve) =>
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0))
    );
    expect(status).toBe(403);
  });

  it("sin autenticarse a tiempo se cierra (4408); audio antes de autenticarse, 4401", async () => {
    const idle = await open("/ws/voice");
    expect((await idle.closed).code).toBe(VOICE_CLOSE.authTimeout);
    const eager = await open("/ws/voice");
    eager.ws.send(tone(100, 300));
    expect((await eager.closed).code).toBe(VOICE_CLOSE.unauthorized);
  });

  it("un cliente NO puede conectarse a la llamada de otro cliente (4403)", async () => {
    const victim = await widgetSession();
    const intruder = await widgetSession();
    const callId = await startCall(victim.token, await widgetConversation(victim.token));
    const socket = await voiceSocket({ callId, widgetToken: intruder.token });
    expect((await socket.closed).code).toBe(VOICE_CLOSE.forbidden);
    // La llamada sigue esperando a SU cliente.
    expect((await prisma.call.findUniqueOrThrow({ where: { id: callId } })).status).toBe("connecting");
  });

  it("un agente que NO se unió (ni un admin) no puede escuchar la llamada (4403)", async () => {
    const { callId } = await customerInCall();
    const agent = await staffSession("agent");
    const admin = await staffSession("admin");
    for (const accessToken of [agent.token, admin.token]) {
      const socket = await voiceSocket({ callId, accessToken });
      expect((await socket.closed).code).toBe(VOICE_CLOSE.forbidden);
    }
  });

  it("el agente asignado solo escucha si SE UNIÓ (queda registrado); tras salir, ya no", async () => {
    const { callId, conversationId, socket } = await customerInCall();
    await escalate(socket);
    const agent = await staffSession("agent");
    // Toma el caso por el panel de texto, sin unirse a la llamada.
    await request(app).post(`/api/conversations/${conversationId}/take`).set(authHeader(agent.token)).expect(200);
    const sneaky = await voiceSocket({ callId, accessToken: agent.token });
    expect((await sneaky.closed).code).toBe(VOICE_CLOSE.forbidden);
    // Unirse deja registro (call_participants) y entonces sí puede conectarse.
    await request(app).post(`/api/calls/${callId}/join`).set(authHeader(agent.token)).expect(200);
    const joined = await agentVoice(agent.token, callId);
    joined.ws.close();
    await request(app).post(`/api/calls/${callId}/leave`).set(authHeader(agent.token)).expect(204);
    const afterLeaving = await voiceSocket({ callId, accessToken: agent.token });
    expect((await afterLeaving.closed).code).toBe(VOICE_CLOSE.forbidden);
  });

  it("credenciales inválidas → 4401; llamada inexistente o terminada → 4403", async () => {
    const { token, callId, socket } = await customerInCall();
    const bad = await voiceSocket({ callId, widgetToken: "wgt_inventado" });
    expect((await bad.closed).code).toBe(VOICE_CLOSE.unauthorized);
    const missing = await voiceSocket({ callId: "00000000-0000-4000-8000-000000000000", widgetToken: token });
    expect((await missing.closed).code).toBe(VOICE_CLOSE.forbidden);
    socket.ws.send(JSON.stringify({ type: "hangup" }));
    await socket.closed;
    const late = await voiceSocket({ callId, widgetToken: token });
    expect((await late.closed).code).toBe(VOICE_CLOSE.forbidden);
  });

  it("mensajes que no cumplen el protocolo cierran la conexión (4400)", async () => {
    const { socket } = await customerInCall();
    socket.ws.send(JSON.stringify({ type: "signal", signal: { type: "offer", sdp: "x" }, to: "otro" }));
    expect((await socket.closed).code).toBe(VOICE_CLOSE.invalid);
  });
});

describe("llamada completa: voz → MISMO motor conversacional → voz", () => {
  it("cliente pregunta, la IA responde con audio, escala por fraude, el agente se une con la transcripción y hablan", async () => {
    const admin = await staffSession("admin");
    const panel = await staffEvents(admin.token);
    const { token, conversationId, callId, socket } = await customerInCall();
    const customerEvents = await open("/ws");
    customerEvents.ws.send(JSON.stringify({ type: "auth", widgetToken: token }));
    await customerEvents.waitFor(is("ready"));

    // Contestar: connecting → in_progress.
    const answered = await prisma.call.findUniqueOrThrow({ where: { id: callId } });
    expect(answered.status).toBe("in_progress");
    expect(answered.answeredAt).not.toBeNull();

    // 1. Pregunta con respuesta en la KB.
    say(socket, "¿Cuál es el horario de atención de las oficinas?");
    const partial = await socket.waitFor(is("transcript.partial"));
    expect(partial.speaker).toBe("customer");
    const final = await socket.waitFor(is("transcript.final"));
    expect(final.text).toBe("¿Cuál es el horario de atención de las oficinas?");
    const ttsStart = await socket.waitFor(is("tts.start"));
    expect(String(ttsStart.text)).toMatch(/lunes a viernes/);
    await socket.waitFor(is("tts.end"));
    expect(socket.audioFrames.length).toBeGreaterThan(0);

    // Quedó como turnos de VOZ de la conversación, con su transcripción enlazada.
    const turns = await prisma.message.findMany({ where: { conversationId, callId }, orderBy: { createdAt: "asc" } });
    expect(turns.map((m) => [m.senderType, m.channel])).toEqual([
      ["customer", "voice"],
      ["ai", "voice"],
    ]);
    expect(turns[0]!.intent).not.toBeNull(); // clasificado por el MISMO motor
    const segments = await callsService.segments(callId);
    expect(segments.map((s) => [s.seq, s.speaker, s.messageId])).toEqual([
      [0, "customer", turns[0]!.id],
      [1, "ai", turns[1]!.id],
    ]);

    // El panel ve la transcripción parcial en vivo y el turno; el widget ve el turno pero NO la parcial.
    await panel.waitFor((m) => m.type === "call.transcript.partial" && m.callId === callId);
    await panel.waitFor((m) => m.type === "message.created" && (m.message as Message).channel === "voice");
    await customerEvents.waitFor((m) => m.type === "message.created");
    expect(customerEvents.messages.some((m) => m.type === "call.transcript.partial")).toBe(false);
    const toCustomer = customerEvents.messages.find((m) => m.type === "message.created")!;
    expect((toCustomer.message as Message).intent).toBeUndefined();

    // 2. Fraude: el mismo motor de escalamiento decide pasar a un humano.
    await escalate(socket);
    const handoff = await socket.waitFor((m) => m.type === "tts.start" && /asesor/i.test(String(m.text)));
    expect(handoff).toBeTruthy();
    await panel.waitFor((m) => m.type === "call.updated" && (m.call as Message).status === "waiting_agent");
    const escalation = await prisma.escalation.findFirstOrThrow({ where: { conversationId } });
    expect([escalation.reason, escalation.callId]).toEqual(["possible_fraud", callId]);

    // 3. Un agente se une: TOMA el caso y recibe la transcripción acumulada.
    const agent = await staffSession("agent");
    const join = await request(app).post(`/api/calls/${callId}/join`).set(authHeader(agent.token));
    expect(join.status).toBe(200);
    expect(join.body.transcript.map((s: Message) => s.speaker)).toEqual(["customer", "ai", "customer", "ai"]);
    expect(join.body.transcript[2].text).toMatch(/No reconozco un cargo/);
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect([conversation.status, conversation.assignedAgentId]).toEqual(["agent_active", agent.staff.id]);
    const joined = await prisma.call.findUniqueOrThrow({ where: { id: callId } });
    expect([joined.status, joined.handledByAgentId]).toEqual(["in_progress", agent.staff.id]);

    // 4. WebRTC: se avisan presencia y la señalización se relea entre ESTOS dos.
    const agentSocket = await agentVoice(agent.token, callId);
    await agentSocket.waitFor((m) => m.type === "peer" && m.role === "customer" && m.present === true);
    await socket.waitFor((m) => m.type === "peer" && m.role === "agent" && m.present === true);
    agentSocket.ws.send(JSON.stringify({ type: "signal", signal: { type: "offer", sdp: "v=0 oferta-del-agente" } }));
    const offer = await socket.waitFor(is("signal"));
    expect(offer.signal).toEqual({ type: "offer", sdp: "v=0 oferta-del-agente" });
    socket.ws.send(JSON.stringify({ type: "signal", signal: { type: "answer", sdp: "v=0 respuesta" } }));
    expect((await agentSocket.waitFor(is("signal"))).signal).toEqual({ type: "answer", sdp: "v=0 respuesta" });
    const candidate = {
      type: "candidate",
      candidate: { candidate: "candidate:1 1 udp 1 10.0.0.1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 },
    };
    socket.ws.send(JSON.stringify({ type: "signal", signal: candidate }));
    await agentSocket.waitFor((m) => m.type === "signal" && (m.signal as Message).type === "candidate");

    // 5. Con el agente a cargo, la IA ya NO responde; lo que dice el agente queda como turno suyo.
    const ttsBefore = socket.messages.filter(is("tts.start")).length;
    say(agentSocket, "Hola, soy tu asesora. Ya bloqueé la tarjeta.");
    await agentSocket.waitFor((m) => m.type === "transcript.final" && m.speaker === "agent");
    say(socket, "Muchas gracias");
    await socket.waitFor((m) => m.type === "transcript.final" && m.text === "Muchas gracias");
    await settle();
    expect(socket.messages.filter(is("tts.start")).length).toBe(ttsBefore);
    const agentTurn = await prisma.message.findFirstOrThrow({ where: { callId, senderType: "agent" } });
    expect([agentTurn.channel, agentTurn.senderAgentId]).toEqual(["voice", agent.staff.id]);

    // 6. El cliente cuelga: ambos sockets se cierran y todo queda registrado.
    socket.ws.send(JSON.stringify({ type: "hangup" }));
    expect((await socket.waitFor(is("call.ended"))).reason).toBe("customer_hangup");
    expect((await agentSocket.closed).code).toBe(1000);
    const ended = await prisma.call.findUniqueOrThrow({ where: { id: callId }, include: { participants: true } });
    expect([ended.status, ended.endReason]).toEqual(["ended", "customer_hangup"]);
    expect(ended.durationSeconds).not.toBeNull();
    expect(ended.participants.every((p) => p.leftAt !== null)).toBe(true);
    expect(ended.participants.map((p) => p.participantType).sort()).toEqual(["agent", "ai", "customer"]);

    // Consumo medido: segundos de STT del cliente (cuentan en su tope), del agente (no cuentan) y caracteres de TTS.
    await settle(300);
    const usage = await prisma.aiUsage.findMany({ where: { callId } });
    const customerStt = usage.filter((u) => u.kind === "stt" && u.customerId !== null);
    const agentStt = usage.filter((u) => u.kind === "stt" && u.customerId === null);
    expect(customerStt.reduce((sum, u) => sum + u.inputUnits, 0)).toBeGreaterThan(0);
    expect(agentStt.reduce((sum, u) => sum + u.inputUnits, 0)).toBeGreaterThan(0);
    expect(usage.some((u) => u.kind === "tts" && u.unit === "characters" && u.outputUnits > 0)).toBe(true);

    for (const s of [panel, customerEvents]) s.ws.close();
  });
});

describe("aislamiento entre llamadas y participantes", () => {
  it("iniciar, unirse y colgar quedan auditados, SIN nada de lo dicho", async () => {
    const { callId, customerId, socket } = await customerInCall();
    await escalate(socket);
    const agent = await staffSession("agent");
    await request(app).post(`/api/calls/${callId}/join`).set(authHeader(agent.token)).expect(200);
    await request(app).post(`/api/calls/${callId}/end`).set(authHeader(agent.token)).expect(204);
    await flushAudit();
    const rows = await prisma.auditLog.findMany({
      where: { entityType: "call", entityId: callId },
      orderBy: { id: "asc" },
    });
    expect(rows.map((r) => [r.action, r.actorType, r.actorId])).toEqual([
      ["call.start", "customer", customerId],
      ["call.join", "staff", agent.staff.id],
      ["call.end", "staff", agent.staff.id],
    ]);
    expect(JSON.stringify(rows.map((r) => r.metadata))).not.toMatch(/reconozco|450.000/);
  });

  it("la señalización de una llamada NUNCA llega a otra llamada", async () => {
    const callA = await customerInCall();
    const callB = await customerInCall();
    for (const call of [callA, callB]) await escalate(call.socket);
    const agentA = await staffSession("agent");
    const agentB = await staffSession("agent");
    expect((await request(app).post(`/api/calls/${callA.callId}/join`).set(authHeader(agentA.token))).status).toBe(200);
    expect((await request(app).post(`/api/calls/${callB.callId}/join`).set(authHeader(agentB.token))).status).toBe(200);
    const socketA = await agentVoice(agentA.token, callA.callId);
    const socketB = await agentVoice(agentB.token, callB.callId);

    socketA.ws.send(JSON.stringify({ type: "signal", signal: { type: "offer", sdp: "v=0 SOLO-PARA-A" } }));
    await callA.socket.waitFor(is("signal"));
    await settle();
    for (const other of [callB.socket, socketB]) {
      expect(other.messages.some((m) => m.type === "signal")).toBe(false);
    }
    // Y el agente A tampoco puede entrar a la llamada B.
    const intrusion = await voiceSocket({ callId: callB.callId, accessToken: agentA.token });
    expect((await intrusion.closed).code).toBe(VOICE_CLOSE.forbidden);
  });

  it("otro agente no puede unirse a una llamada ya atendida; un admin tampoco sin tomar el caso", async () => {
    const { callId, socket } = await customerInCall();
    await escalate(socket);
    const first = await staffSession("agent");
    const second = await staffSession("agent");
    const admin = await staffSession("admin");
    expect((await request(app).post(`/api/calls/${callId}/join`).set(authHeader(first.token))).status).toBe(200);
    // Para el segundo agente el caso ya no está en su alcance: 404, sin revelar nada.
    expect((await request(app).post(`/api/calls/${callId}/join`).set(authHeader(second.token))).status).toBe(404);
    expect((await request(app).get(`/api/calls/${callId}/transcript`).set(authHeader(second.token))).status).toBe(404);
    expect((await request(app).post(`/api/calls/${callId}/join`).set(authHeader(admin.token))).status).toBe(409);
    // Unirse de nuevo (recargó el panel) es idempotente: una sola participación abierta.
    expect((await request(app).post(`/api/calls/${callId}/join`).set(authHeader(first.token))).status).toBe(200);
    expect(await prisma.callParticipant.count({ where: { callId, agentId: first.staff.id, leftAt: null } })).toBe(1);
  });

  it("dos agentes se unen A LA VEZ a la misma llamada en cola: gana exactamente uno", async () => {
    const { callId, socket } = await customerInCall();
    await escalate(socket);
    const agents = await Promise.all([staffSession("agent"), staffSession("agent"), staffSession("agent")]);
    const results = await Promise.all(
      agents.map((a) => request(app).post(`/api/calls/${callId}/join`).set(authHeader(a.token)))
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await prisma.callParticipant.count({ where: { callId, participantType: "agent" } })).toBe(1);
  });

  it("unirse respeta el máximo de conversaciones del agente", async () => {
    const { callId, socket } = await customerInCall();
    await escalate(socket);
    const busy = await staffSession("agent", { maxConcurrent: 1 });
    await createConversation("agent_active", busy.staff.id);
    const res = await request(app).post(`/api/calls/${callId}/join`).set(authHeader(busy.token));
    expect(res.status).toBe(409);
    expect((await prisma.call.findUniqueOrThrow({ where: { id: callId } })).handledByAgentId).toBeNull();
  });

  it("la transcripción parcial en vivo solo llega al staff que puede ver el caso", async () => {
    const { callId, socket } = await customerInCall();
    const outsider = await staffSession("agent");
    const outsiderEvents = await staffEvents(outsider.token);
    const admin = await staffSession("admin");
    const adminEvents = await staffEvents(admin.token);
    say(socket, "Quiero consultar el horario");
    await adminEvents.waitFor((m) => m.type === "call.transcript.partial" && m.callId === callId);
    await settle();
    // El caso está con la IA (no en cola): un agente cualquiera no lo ve.
    expect(outsiderEvents.messages.some((m) => m.callId === callId)).toBe(false);
    for (const s of [outsiderEvents, adminEvents]) s.ws.close();
  });

  it("el más nuevo gana: una segunda conexión del cliente reemplaza a la primera (no se transcribe dos veces)", async () => {
    const { token, callId, conversationId, socket } = await customerInCall();
    const second = await customerVoice(token, callId);
    expect((await socket.closed).code).toBe(VOICE_CLOSE.replaced);
    say(second, "Hola, una consulta");
    await second.waitFor(is("transcript.final"));
    await settle();
    expect(await prisma.message.count({ where: { conversationId, senderType: "customer", callId } })).toBe(1);
    expect((await prisma.call.findUniqueOrThrow({ where: { id: callId } })).status).toBe("in_progress");
    expect(voice.connected().customer).toBeGreaterThanOrEqual(1);
  });
});

describe("varias instancias de la API (señalización por el bus, como Redis pub/sub)", () => {
  it("cliente en una instancia y agente en OTRA: la señalización y el fin de la llamada cruzan; el más nuevo gana entre instancias", async () => {
    const other = http.createServer(app);
    await new Promise<void>((resolve) => other.listen(0, resolve));
    const otherVoice = await attachVoice(other, {
      authTimeoutMs: 300,
      reconnectGraceMs: 300,
      audioRealtimeFactor: 1_000,
    });
    const otherBase = `ws://127.0.0.1:${(other.address() as AddressInfo).port}`;
    const openOn = async (url: string, auth: Record<string, unknown>) => {
      const ws = new WebSocket(`${url}/ws/voice`, { headers: { Origin: ORIGIN } });
      const messages: Message[] = [];
      ws.on("message", (raw, isBinary) => !isBinary && messages.push(JSON.parse(raw.toString())));
      const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
      await new Promise((resolve) => ws.once("open", resolve));
      ws.send(JSON.stringify({ type: "auth", ...auth }));
      const until = async (predicate: (m: Message) => boolean) => {
        for (let i = 0; i < 60 && !messages.some(predicate); i += 1) await settle(50);
        const found = messages.find(predicate);
        if (!found) throw new Error(`no llegó; recibidos: ${JSON.stringify(messages.map((m) => m.type))}`);
        return found;
      };
      await until(is("ready"));
      return { ws, messages, closed, until };
    };
    try {
      const { token, callId, socket } = await customerInCall(); // instancia principal
      await escalate(socket);
      const agent = await staffSession("agent");
      await request(app).post(`/api/calls/${callId}/join`).set(authHeader(agent.token)).expect(200);
      const agentOnOther = await openOn(otherBase, { callId, accessToken: agent.token });

      await socket.waitFor((m) => m.type === "peer" && m.role === "agent" && m.present === true);
      await agentOnOther.until((m) => m.type === "peer" && m.role === "customer" && m.present === true);
      agentOnOther.ws.send(JSON.stringify({ type: "signal", signal: { type: "offer", sdp: "v=0 entre-instancias" } }));
      expect((await socket.waitFor(is("signal"))).signal).toEqual({ type: "offer", sdp: "v=0 entre-instancias" });

      // El cliente se reconecta en la OTRA instancia: la conexión vieja se cierra (4410).
      const customerOnOther = await openOn(otherBase, { callId, widgetToken: token });
      expect((await socket.closed).code).toBe(VOICE_CLOSE.replaced);

      // Colgar en una instancia cierra los sockets de la otra.
      customerOnOther.ws.send(JSON.stringify({ type: "hangup" }));
      expect(await agentOnOther.closed).toBe(1000);
      expect((await prisma.call.findUniqueOrThrow({ where: { id: callId } })).endReason).toBe("customer_hangup");
    } finally {
      await otherVoice.close();
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });
});

describe("abuso del canal de voz y límites", () => {
  it("audio más rápido que el tiempo real se corta (4429): no se pueden quemar créditos de STT", async () => {
    // Servidor propio con el límite REAL (el compartido lo relaja para que los tests sean rápidos).
    const own = http.createServer(app);
    await new Promise<void>((resolve) => own.listen(0, resolve));
    const ownVoice = await attachVoice(own, { authTimeoutMs: 300 });
    try {
      const { token } = await widgetSession();
      const callId = await startCall(token, await widgetConversation(token));
      const ws = new WebSocket(`ws://127.0.0.1:${(own.address() as AddressInfo).port}/ws/voice`, {
        headers: { Origin: ORIGIN },
      });
      const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
      const ready = new Promise<void>((resolve) =>
        ws.on("message", (raw, isBinary) => !isBinary && JSON.parse(raw.toString()).type === "ready" && resolve())
      );
      await new Promise((resolve) => ws.once("open", resolve));
      ws.send(JSON.stringify({ type: "auth", callId, widgetToken: token }));
      await ready;
      // 10 s de audio de golpe (tope: ráfaga de 2 s a 1,25×).
      for (let i = 0; i < 100; i += 1) ws.send(tone(100, 300));
      expect(await closed).toBe(VOICE_CLOSE.tooMuch);
    } finally {
      await ownVoice.close();
      await new Promise<void>((resolve) => own.close(() => resolve()));
    }
  });

  it("audio con formato inválido (largo impar) se rechaza (4400)", async () => {
    const { socket } = await customerInCall();
    socket.ws.send(Buffer.alloc(33));
    expect((await socket.closed).code).toBe(VOICE_CLOSE.invalid);
  });

  it("al agotar el tope diario de voz DURANTE la llamada, se avisa y se corta", async () => {
    const { customerId, callId, socket } = await customerInCall();
    await prisma.aiUsage.create({
      data: { kind: "stt", provider: "mock", customerId, unit: "seconds", inputUnits: 1_799 },
    });
    say(socket, "Hola, tengo una pregunta sobre mi cuenta de ahorros");
    await socket.waitFor(is("notice"));
    expect((await socket.waitFor(is("call.ended"))).reason).toBe("timeout");
    expect((await prisma.call.findUniqueOrThrow({ where: { id: callId } })).endReason).toBe("timeout");
  });

  it("la llamada se corta al llegar a la duración máxima", async () => {
    const own = http.createServer(app);
    await new Promise<void>((resolve) => own.listen(0, resolve));
    const ownVoice = await attachVoice(own, { authTimeoutMs: 300, maxCallSeconds: 1 });
    try {
      const { token } = await widgetSession();
      const callId = await startCall(token, await widgetConversation(token));
      const ws = new WebSocket(`ws://127.0.0.1:${(own.address() as AddressInfo).port}/ws/voice`, {
        headers: { Origin: ORIGIN },
      });
      const messages: Message[] = [];
      ws.on("message", (raw, isBinary) => !isBinary && messages.push(JSON.parse(raw.toString())));
      const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
      await new Promise((resolve) => ws.once("open", resolve));
      ws.send(JSON.stringify({ type: "auth", callId, widgetToken: token }));
      expect(await closed).toBe(1000);
      expect(messages.some((m) => m.type === "notice")).toBe(true);
      const call = await prisma.call.findUniqueOrThrow({ where: { id: callId } });
      expect([call.status, call.endReason]).toEqual(["ended", "timeout"]);
    } finally {
      await ownVoice.close();
      await new Promise<void>((resolve) => own.close(() => resolve()));
    }
  });
});

describe("desconexiones, cierre del caso y fallas del proveedor", () => {
  it("si el cliente se corta y vuelve a tiempo, la llamada sigue; si no vuelve, se termina", async () => {
    const { token, callId, socket } = await customerInCall();
    socket.ws.terminate();
    await settle(100);
    const again = await customerVoice(token, callId);
    await settle(500); // más que la gracia (300 ms): no debe cortarse
    expect((await prisma.call.findUniqueOrThrow({ where: { id: callId } })).status).toBe("in_progress");
    again.ws.terminate();
    await settle(700);
    const call = await prisma.call.findUniqueOrThrow({ where: { id: callId } });
    expect([call.status, call.endReason]).toEqual(["ended", "timeout"]);
  });

  it("cerrar la conversación desde el panel cuelga la llamada y cierra los sockets de voz", async () => {
    const { callId, conversationId, socket } = await customerInCall();
    await escalate(socket);
    const agent = await staffSession("agent");
    await request(app).post(`/api/calls/${callId}/join`).set(authHeader(agent.token)).expect(200);
    const agentSocket = await agentVoice(agent.token, callId);
    const close = await request(app)
      .post(`/api/conversations/${conversationId}/close`)
      .set(authHeader(agent.token))
      .send({ reason: "resolved_by_agent" });
    expect(close.status).toBe(200);
    expect((await socket.waitFor(is("call.ended"))).reason).toBe("agent_hangup");
    expect((await agentSocket.closed).code).toBe(1000);
    expect((await prisma.call.findUniqueOrThrow({ where: { id: callId } })).status).toBe("ended");
  });

  it("si el TTS falla, la respuesta igual queda (como texto) y la llamada sigue", async () => {
    const mock = createMockVoice();
    setVoiceForTests({
      provider: "mock",
      stt: mock.stt,
      tts: { provider: "mock", model: "roto", synthesize: async () => Promise.reject(new Error("TTS caído")) },
    });
    const { callId, socket } = await customerInCall();
    say(socket, "¿Cuál es el horario de atención de las oficinas?");
    const unavailable = await socket.waitFor(is("tts.unavailable"));
    expect(String(unavailable.text)).toMatch(/lunes a viernes/);
    const segments = await callsService.segments(callId);
    expect(segments.map((s) => s.speaker)).toEqual(["customer", "ai"]);
    expect((await prisma.call.findUniqueOrThrow({ where: { id: callId } })).status).toBe("in_progress");
  });

  it("si la IA falla en un turno de voz, se escala a un humano (misma regla que el texto)", async () => {
    const mock = createMockProvider({ latencyMs: 0 });
    setAiForTests({
      provider: "mock",
      classifier: mock.classifier,
      embedder: mock.embedder,
      chat: { reply: async () => Promise.reject(new Error("proveedor caído")) },
    });
    const { conversationId, socket } = await customerInCall();
    say(socket, "¿Cuál es el horario de atención de las oficinas?");
    await socket.waitFor((m) => m.type === "call.status" && m.status === "waiting_agent");
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } })).status).toBe(
      "waiting_agent"
    );
  });
});

describe("mantenimiento: llamadas abandonadas y retención", () => {
  it("el barrido termina llamadas que nunca conectaron (failed) y las que pasaron la duración máxima", async () => {
    const neverA = await widgetSession();
    const neverId = await startCall(neverA.token, await widgetConversation(neverA.token));
    const stuck = await customerInCall();
    // Simula que la instancia que las atendía murió hace rato.
    await prisma.$executeRaw`UPDATE calls SET consent_given_at = now() - interval '2 hours', started_at = now() - interval '2 hours' WHERE id = ${neverId}::uuid`;
    await prisma.$executeRaw`UPDATE calls SET consent_given_at = now() - interval '2 hours', started_at = now() - interval '2 hours', answered_at = now() - interval '2 hours' WHERE id = ${stuck.callId}::uuid`;
    const fresh = await customerInCall();

    expect(await callsService.sweepStale()).toBeGreaterThanOrEqual(2);
    const never = await prisma.call.findUniqueOrThrow({ where: { id: neverId } });
    expect([never.status, never.endReason]).toEqual(["failed", "timeout"]);
    const old = await prisma.call.findUniqueOrThrow({ where: { id: stuck.callId } });
    expect([old.status, old.endReason]).toEqual(["ended", "timeout"]);
    expect((await prisma.call.findUniqueOrThrow({ where: { id: fresh.callId } })).status).toBe("in_progress");
  });

  it("la purga borra la transcripción y el texto de los turnos de voz VENCIDOS, y nada más", async () => {
    const expired = await customerInCall();
    say(expired.socket, "Mi número de cuenta es 123456, ¿cuál es mi saldo?");
    await expired.socket.waitFor(is("tts.end"));
    expired.socket.ws.send(JSON.stringify({ type: "hangup" }));
    await expired.socket.closed;
    const keep = await customerInCall();
    say(keep.socket, "Hola, consulta sobre horarios");
    await keep.socket.waitFor(is("tts.end"));
    keep.socket.ws.send(JSON.stringify({ type: "hangup" }));
    await keep.socket.closed;
    const active = await customerInCall();
    say(active.socket, "Hola");
    await active.socket.waitFor(is("transcript.final"));

    // La primera "venció": se corre todo en el tiempo (el CHECK exige retain_until > started_at).
    await prisma.$executeRaw`
      UPDATE calls SET consent_given_at = consent_given_at - interval '100 days', started_at = started_at - interval '100 days',
             answered_at = answered_at - interval '100 days', ended_at = ended_at - interval '100 days',
             retain_until = retain_until - interval '100 days'
      WHERE id = ${expired.callId}::uuid`;

    let purged = 0;
    for (
      let batch = await callsService.purgeExpiredTranscripts();
      batch > 0;
      batch = await callsService.purgeExpiredTranscripts()
    )
      purged += batch;
    expect(purged).toBeGreaterThanOrEqual(1);

    const gone = await prisma.call.findUniqueOrThrow({ where: { id: expired.callId } });
    expect(gone.transcriptPurgedAt).not.toBeNull();
    expect(await callsService.segments(expired.callId)).toEqual([]);
    const purgedTurns = await prisma.message.findMany({ where: { callId: expired.callId } });
    expect(purgedTurns.length).toBeGreaterThan(0);
    expect(purgedTurns.every((m) => m.content === PURGED_PLACEHOLDER)).toBe(true);
    expect(
      JSON.stringify(await prisma.callTranscriptSegment.findMany({ where: { callId: expired.callId } }))
    ).not.toContain("123456");
    // Los metadatos sobreviven: duración, motivo, participantes.
    expect(gone.endReason).toBe("customer_hangup");
    expect(await prisma.callParticipant.count({ where: { callId: expired.callId } })).toBeGreaterThan(0);

    // Lo no vencido y lo activo quedan intactos.
    expect((await callsService.segments(keep.callId)).length).toBeGreaterThan(0);
    expect((await callsService.segments(active.callId)).length).toBeGreaterThan(0);
    expect(await callsService.purgeExpiredTranscripts()).toBe(0);
  });

  it("GET /api/calls/active solo lista las llamadas que el usuario puede ver", async () => {
    const withAi = await customerInCall();
    const queued = await customerInCall();
    await escalate(queued.socket);
    const agent = await staffSession("agent");
    const res = await request(app).get("/api/calls/active").set(authHeader(agent.token));
    const ids = res.body.items.map((c: Message) => c.id);
    expect(ids).toContain(queued.callId);
    expect(ids).not.toContain(withAi.callId);
  });
});
