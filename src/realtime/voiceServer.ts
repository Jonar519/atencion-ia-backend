import type { IncomingMessage, Server } from "http";
import type { Duplex } from "stream";
import { randomUUID } from "crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { prisma } from "../config/prisma";
import { verifyAccessToken } from "../modules/auth/tokens";
import { resolveWidgetToken, WIDGET_COOKIE } from "../modules/widget/widgetAuth.middleware";
import { ApiError } from "../utils/apiError";
import { readCookie } from "../utils/cookies";
import { voiceAudioSeconds, voiceSockets } from "../observability/metrics";
import { getVoice, SAMPLE_RATE, type SttStream, type TranscriptEvent } from "../services/voice";
import { ACTIVE_CALL, AUDIO_FORMAT, callsService } from "../modules/voice/calls.service";
import { voiceClientMessageSchema } from "../modules/voice/voice.schema";
import { processAgentSegment, processCustomerSegment, type VoiceOutput } from "../modules/voice/voicePipeline";
import { assertWithinVoiceBudget, recordSttUsage } from "../modules/voice/voiceBudget";
import { publishTranscriptPartial } from "./publish";
import { publishVoice, subscribeRealtime, subscribeVoice } from "./bus";
import type { RealtimeEvent } from "./events";
import type { VoiceBusMessage, VoiceRole } from "./voiceMessages";
import { VOICE_WS_PATH } from "./paths";

/**
 * WebSocket de VOZ (ruta /ws/voice, mismo puerto que la API). A diferencia de
 * /ws (solo recepción, ADR 0008), este socket recibe audio y señalización, por
 * eso vive aparte, con sus propios límites (ADR 0010).
 *
 * Protocolo:
 *   1. { "type": "auth", "callId", "accessToken" }  → agente (debe haberse unido: POST /api/calls/:id/join)
 *      { "type": "auth", "callId" }                  → cliente (cookie httpOnly del widget)
 *      { "type": "auth", "callId", "widgetToken" }   → cliente de API/demo
 *      ← { "type": "ready", role, call, audio, iceServers }
 *   2. Audio: tramas BINARIAS PCM16 mono 16 kHz (≈100 ms c/u) → STT del proveedor.
 *      ← { "type": "transcript.partial" | "transcript.final", speaker, text }
 *      ← (cliente) { "type": "tts.start", … } + tramas binarias de audio + { "type": "tts.end" }
 *   3. WebRTC (audio cliente ⇄ agente, de navegador a navegador):
 *      { "type": "signal", "signal": { offer | answer | candidate } } → se RELEVA al otro participante.
 *      ← { "type": "peer", role, present }: el agente crea la oferta cuando el cliente está.
 *   4. { "type": "hangup" } → termina la llamada. ← { "type": "call.ended", reason } y cierre 1000.
 *
 * Seguridad (lo que prueban tests/integration/voice.test.ts y las mutaciones):
 *  - Origin permitido; credencial en el primer mensaje (nunca en la URL).
 *  - Cliente: solo SUS llamadas activas. Agente: solo si es participante presente
 *    y el caso está asignado a él. Cualquier otra cosa: 4403, sin revelar si existe.
 *  - La señalización se relea SOLO al otro participante de ESA llamada, validada con zod.
 *  - Audio con tope de caudal (≈1,25× tiempo real): un script no puede quemar créditos
 *    de STT enviando horas de audio en segundos (4429). Topes diarios de voz y de IA.
 *  - Una sola conexión por rol y llamada ("el más nuevo gana", entre instancias).
 */

export { VOICE_WS_PATH };
export const VOICE_CLOSE = {
  invalid: 4400,
  unauthorized: 4401,
  forbidden: 4403,
  authTimeout: 4408,
  tokenExpired: 4409,
  replaced: 4410,
  tooMuch: 4429,
} as const;

const HEARTBEAT_MS = 30_000;
const MAX_JSON_MESSAGES_PER_WINDOW = 60;
const MESSAGE_WINDOW_MS = 10_000;
/** Caudal máximo de audio: 1,25× tiempo real, con ráfagas de hasta 2 s. */
const AUDIO_REALTIME_FACTOR = 1.25;
const REALTIME_BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
const AUDIO_BURST_MS = 2_000;
const MAX_AUDIO_FRAME_BYTES = 16_384;
const PARTIAL_MIN_INTERVAL_MS = 250;
const USAGE_FLUSH_MS = 30_000;

interface Connection {
  id: string;
  ws: WebSocket;
  role: VoiceRole;
  callId: string;
  conversationId: string;
  customerId: string | null;
  staffId: string | null;
  stt: SttStream;
  /** ms entre el inicio de la llamada y la apertura de este stream (tiempos de la transcripción). */
  offsetMs: number;
  pipeline: Promise<unknown>;
  recordedAudioMs: number;
  lastPartialAt: number;
  lastPartialText: string;
  /** Cerrada por fin de llamada o reemplazo: no hay período de gracia. */
  noGrace: boolean;
  timers: NodeJS.Timeout[];
}

interface PendingSocket {
  alive: boolean;
  windowStart: number;
  messagesInWindow: number;
  bucket: number;
  bucketAt: number;
  connection: Connection | null;
}

export interface VoiceServer {
  close(): Promise<void>;
  connected(): { customer: number; agent: number };
}

export interface VoiceServerOptions {
  authTimeoutMs?: number;
  heartbeatMs?: number;
  /** Solo tests: acortar la espera de reconexión. */
  reconnectGraceMs?: number;
  /** Solo tests: enviar audio más rápido que el tiempo real sin disparar el límite. */
  audioRealtimeFactor?: number;
  /** Solo tests: duración máxima de la llamada. */
  maxCallSeconds?: number;
}

export async function attachVoice(server: Server, options: VoiceServerOptions = {}): Promise<VoiceServer> {
  const authTimeoutMs = options.authTimeoutMs ?? 5_000;
  const graceMs = options.reconnectGraceMs ?? env.voice.reconnectGraceMs;
  const maxCallSeconds = options.maxCallSeconds ?? env.voice.maxCallSeconds;
  const audioBytesPerMs = REALTIME_BYTES_PER_MS * (options.audioRealtimeFactor ?? AUDIO_REALTIME_FACTOR);
  const audioBurstBytes = audioBytesPerMs * AUDIO_BURST_MS;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  const sockets = new Map<WebSocket, PendingSocket>();
  const upgradeCookies = new WeakMap<WebSocket, string | undefined>();
  /** Esperas de reconexión por llamada y rol (clave `${callId}:${role}`). */
  const graceTimers = new Map<string, NodeJS.Timeout>();
  /** Tope de duración por llamada (en la instancia que tiene al cliente). */
  const maxDurationTimers = new Map<string, NodeJS.Timeout>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== VOICE_WS_PATH) return;
    const origin = req.headers.origin;
    if (!origin || !env.corsOrigins.includes(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      upgradeCookies.set(ws, readCookie(req.headers.cookie, WIDGET_COOKIE));
      wss.emit("connection", ws, req);
    });
  };
  server.on("upgrade", onUpgrade);

  const connections = () => [...sockets.values()].flatMap((s) => (s.connection ? [s.connection] : []));
  const send = (ws: WebSocket, message: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const outputFor = (ws: WebSocket): VoiceOutput => ({
    json: (message) => send(ws, message),
    audio: (chunk) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
    },
  });

  /** Autentica y verifica que ESTA identidad puede estar en ESTA llamada. null = rechazar (4403/4401). */
  async function authorize(
    ws: WebSocket,
    message: { callId: string; accessToken?: string; widgetToken?: string }
  ): Promise<
    | {
        role: VoiceRole;
        conversationId: string;
        customerId: string | null;
        staffId: string | null;
        startedAt: Date;
        expiresAtMs: number | null;
      }
    | "unauthorized"
    | "forbidden"
  > {
    if (message.accessToken) {
      const payload = verifyAccessToken(message.accessToken);
      if (!payload) return "unauthorized";
      const call = await prisma.call.findUnique({
        where: { id: message.callId },
        select: {
          status: true,
          startedAt: true,
          conversationId: true,
          conversation: { select: { status: true, assignedAgentId: true } },
          participants: { where: { agentId: payload.staffId, leftAt: null }, select: { id: true } },
        },
      });
      const allowed =
        call &&
        ACTIVE_CALL.includes(call.status) &&
        call.participants.length > 0 &&
        call.conversation.status === "agent_active" &&
        call.conversation.assignedAgentId === payload.staffId;
      if (!allowed) return "forbidden";
      return {
        role: "agent",
        conversationId: call.conversationId,
        customerId: null,
        staffId: payload.staffId,
        startedAt: call.startedAt,
        expiresAtMs: payload.exp ? payload.exp * 1000 : null,
      };
    }
    const identity = await resolveWidgetToken(message.widgetToken ?? upgradeCookies.get(ws));
    if (!identity) return "unauthorized";
    const call = await prisma.call.findFirst({
      where: { id: message.callId, conversation: { customerId: identity.customerId } },
      select: { status: true, startedAt: true, conversationId: true },
    });
    if (!call || !ACTIVE_CALL.includes(call.status)) return "forbidden";
    return {
      role: "customer",
      conversationId: call.conversationId,
      customerId: identity.customerId,
      staffId: null,
      startedAt: call.startedAt,
      expiresAtMs: identity.expiresAt.getTime(),
    };
  }

  async function flushUsage(conn: Connection) {
    const pendingMs = conn.stt.audioMs - conn.recordedAudioMs;
    if (pendingMs < 1_000) return;
    conn.recordedAudioMs = conn.stt.audioMs;
    const voice = getVoice();
    voiceAudioSeconds.inc({ provider: voice.stt.provider, role: conn.role }, pendingMs / 1000);
    await recordSttUsage({
      seconds: pendingMs / 1000,
      provider: voice.stt.provider,
      model: voice.stt.model,
      // El audio del agente no cuenta en el tope del cliente.
      customerId: conn.role === "customer" ? conn.customerId : null,
      conversationId: conn.conversationId,
      callId: conn.callId,
    });
  }

  /** Tope diario de voz del cliente: si se agotó, se avisa y se corta. */
  async function enforceVoiceBudget(conn: Connection) {
    if (conn.role !== "customer" || !conn.customerId) return;
    try {
      await assertWithinVoiceBudget(conn.customerId);
    } catch (err) {
      if (err instanceof ApiError) {
        send(conn.ws, { type: "notice", text: err.message });
        await callsService.end(conn.callId, "timeout");
      }
    }
  }

  function onTranscript(conn: Connection, event: TranscriptEvent) {
    if (!event.isFinal) {
      const now = Date.now();
      if (event.text === conn.lastPartialText || now - conn.lastPartialAt < PARTIAL_MIN_INTERVAL_MS) return;
      conn.lastPartialAt = now;
      conn.lastPartialText = event.text;
      send(conn.ws, { type: "transcript.partial", speaker: conn.role, text: event.text });
      void publishTranscriptPartial(conn.conversationId, conn.callId, conn.role, event.text);
      return;
    }
    conn.lastPartialText = "";
    const segment = { text: event.text, startMs: event.startMs, endMs: event.endMs, confidence: event.confidence };
    const out = outputFor(conn.ws);
    // Un turno a la vez por conexión: las respuestas salen en el orden en que se habló.
    conn.pipeline = conn.pipeline
      .then(async () => {
        if (conn.role === "customer") {
          await processCustomerSegment(
            {
              callId: conn.callId,
              conversationId: conn.conversationId,
              customerId: conn.customerId!,
              offsetMs: conn.offsetMs,
            },
            segment,
            out
          );
        } else {
          await processAgentSegment(
            { callId: conn.callId, staffId: conn.staffId!, offsetMs: conn.offsetMs },
            segment,
            out
          );
        }
        await flushUsage(conn);
        await enforceVoiceBudget(conn);
      })
      .catch(async (err: unknown) => {
        if (err instanceof ApiError) {
          // Tope de IA (429) o conversación cerrada (409): se avisa y se corta la llamada.
          send(conn.ws, { type: "notice", text: err.message });
          await callsService.end(conn.callId, err.statusCode === 429 ? "timeout" : "error").catch(() => undefined);
          return;
        }
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Error procesando un turno de voz");
        send(conn.ws, { type: "error", message: "No pudimos procesar lo último que dijiste. Intenta de nuevo." });
      });
  }

  function graceKey(callId: string, role: VoiceRole) {
    return `${callId}:${role}`;
  }

  async function startConnection(
    ws: WebSocket,
    state: PendingSocket,
    auth: Exclude<Awaited<ReturnType<typeof authorize>>, string>,
    callId: string
  ) {
    const voice = getVoice();
    const conn: Connection = {
      id: randomUUID(),
      ws,
      role: auth.role,
      callId,
      conversationId: auth.conversationId,
      customerId: auth.customerId,
      staffId: auth.staffId,
      offsetMs: Math.max(0, Date.now() - auth.startedAt.getTime()),
      stt: null as unknown as SttStream,
      pipeline: Promise.resolve(),
      recordedAudioMs: 0,
      lastPartialAt: 0,
      lastPartialText: "",
      noGrace: false,
      timers: [],
    };
    conn.stt = voice.stt.open({
      sampleRate: SAMPLE_RATE,
      language: env.voice.language,
      onTranscript: (event) => onTranscript(conn, event),
      onError: (err) => {
        logger.warn({ err: err.message }, "Falla del STT");
        send(ws, { type: "error", message: "La transcripción no está disponible en este momento." });
      },
    });
    state.connection = conn;

    // Volvió a tiempo: se cancela la espera de reconexión.
    const pendingGrace = graceTimers.get(graceKey(callId, conn.role));
    if (pendingGrace) {
      clearTimeout(pendingGrace);
      graceTimers.delete(graceKey(callId, conn.role));
    }
    // "El más nuevo gana" en esta instancia (en otras, por el mensaje de presencia).
    for (const other of connections()) {
      if (other !== conn && other.callId === callId && other.role === conn.role) {
        other.noGrace = true;
        other.ws.close(VOICE_CLOSE.replaced, "Reemplazada por una conexión nueva");
      }
    }
    if (auth.expiresAtMs) {
      const ms = Math.min(Math.max(auth.expiresAtMs - Date.now(), 0), 2 ** 31 - 1);
      conn.timers.push(setTimeout(() => ws.close(VOICE_CLOSE.tokenExpired, "Sesión expirada"), ms));
    }
    if (conn.role === "customer") {
      await callsService.markAnswered(callId);
      if (!maxDurationTimers.has(callId)) {
        const msLeft = auth.startedAt.getTime() + maxCallSeconds * 1000 - Date.now();
        maxDurationTimers.set(
          callId,
          setTimeout(
            () => {
              maxDurationTimers.delete(callId);
              send(ws, { type: "notice", text: "Se alcanzó la duración máxima de la llamada." });
              void callsService.end(callId, "timeout");
            },
            Math.max(msLeft, 0)
          )
        );
      }
      conn.timers.push(
        setInterval(() => {
          void flushUsage(conn).then(() => enforceVoiceBudget(conn));
        }, USAGE_FLUSH_MS)
      );
    }
    voiceSockets.inc({ role: conn.role });

    const call = await prisma.call.findUniqueOrThrow({ where: { id: callId }, select: { id: true, status: true } });
    send(ws, { type: "ready", role: conn.role, call, audio: AUDIO_FORMAT, iceServers: env.voice.iceServers });
    await publishVoice({ kind: "presence", callId, role: conn.role, present: true, connectionId: conn.id });
  }

  async function endConnection(state: PendingSocket) {
    const conn = state.connection;
    if (!conn) return;
    state.connection = null;
    for (const timer of conn.timers) clearTimeout(timer);
    voiceSockets.dec({ role: conn.role });
    await conn.stt.finish().catch(() => undefined);
    await conn.pipeline.catch(() => undefined);
    await flushUsage(conn).catch(() => undefined);
    // Reemplazada o llamada terminada: no se avisa "se fue" (la conexión nueva ya está, o ya no hay llamada).
    if (conn.noGrace) return;
    await publishVoice({
      kind: "presence",
      callId: conn.callId,
      role: conn.role,
      present: false,
      connectionId: conn.id,
    });
    // Se cortó la red: se espera un rato a que vuelva antes de colgar (cliente) o de
    // dar por ido al agente. Si otra conexión del mismo rol aparece, se cancela.
    const key = graceKey(conn.callId, conn.role);
    clearTimeout(graceTimers.get(key));
    graceTimers.set(
      key,
      setTimeout(() => {
        graceTimers.delete(key);
        if (conn.role === "customer") {
          void callsService.end(conn.callId, "timeout").catch(() => undefined);
        } else {
          void prisma.callParticipant
            .updateMany({
              where: { callId: conn.callId, agentId: conn.staffId, leftAt: null },
              data: { leftAt: new Date() },
            })
            .catch(() => undefined);
        }
      }, graceMs)
    );
  }

  function onJson(
    ws: WebSocket,
    state: PendingSocket,
    raw: RawData,
    authState: { authenticating: boolean; timer: NodeJS.Timeout }
  ) {
    const now = Date.now();
    if (now - state.windowStart > MESSAGE_WINDOW_MS) {
      state.windowStart = now;
      state.messagesInWindow = 0;
    }
    if (++state.messagesInWindow > MAX_JSON_MESSAGES_PER_WINDOW) {
      ws.close(VOICE_CLOSE.tooMuch, "Demasiados mensajes");
      return;
    }
    let parsed;
    try {
      parsed = voiceClientMessageSchema.safeParse(JSON.parse(raw.toString()));
    } catch {
      parsed = null;
    }
    if (!parsed?.success) {
      ws.close(VOICE_CLOSE.invalid, "Mensaje inválido");
      return;
    }
    const message = parsed.data;
    const conn = state.connection;
    if (message.type === "ping") {
      if (conn) send(ws, { type: "pong" });
      return;
    }
    if (message.type === "auth") {
      if (conn || authState.authenticating) return;
      authState.authenticating = true;
      authorize(ws, message)
        .then(async (result) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (result === "unauthorized") return ws.close(VOICE_CLOSE.unauthorized, "Credenciales inválidas");
          if (result === "forbidden") return ws.close(VOICE_CLOSE.forbidden, "No puedes unirte a esta llamada");
          clearTimeout(authState.timer);
          await startConnection(ws, state, result, message.callId);
        })
        .catch((err: unknown) => {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "Error autenticando un WebSocket de voz"
          );
          ws.close(VOICE_CLOSE.unauthorized, "Error de autenticación");
        })
        .finally(() => {
          authState.authenticating = false;
        });
      return;
    }
    if (!conn) {
      ws.close(VOICE_CLOSE.unauthorized, "Autenticación requerida");
      return;
    }
    if (message.type === "signal") {
      // Siempre al OTRO participante de ESTA llamada: el cliente no elige destinatario.
      void publishVoice({
        kind: "signal",
        callId: conn.callId,
        to: conn.role === "customer" ? "agent" : "customer",
        signal: message.signal,
      });
      return;
    }
    if (message.type === "hangup") {
      conn.noGrace = true;
      void callsService.end(conn.callId, conn.role === "customer" ? "customer_hangup" : "agent_hangup");
    }
  }

  function onAudio(ws: WebSocket, state: PendingSocket, data: Buffer) {
    const conn = state.connection;
    if (!conn) {
      ws.close(VOICE_CLOSE.unauthorized, "Autenticación requerida");
      return;
    }
    if (data.length === 0 || data.length % 2 !== 0 || data.length > MAX_AUDIO_FRAME_BYTES) {
      ws.close(VOICE_CLOSE.invalid, "Audio inválido: se espera PCM16 mono");
      return;
    }
    // Cubeta de tokens: se llena a 1,25× tiempo real; enviar más rápido que eso es abuso.
    const now = Date.now();
    state.bucket = Math.min(audioBurstBytes, state.bucket + (now - state.bucketAt) * audioBytesPerMs);
    state.bucketAt = now;
    state.bucket -= data.length;
    if (state.bucket < 0) {
      ws.close(VOICE_CLOSE.tooMuch, "Audio más rápido que el tiempo real");
      return;
    }
    conn.stt.write(data);
  }

  wss.on("connection", (ws: WebSocket) => {
    const state: PendingSocket = {
      alive: true,
      windowStart: Date.now(),
      messagesInWindow: 0,
      bucket: audioBurstBytes,
      bucketAt: Date.now(),
      connection: null,
    };
    sockets.set(ws, state);
    const authState = {
      authenticating: false,
      timer: setTimeout(() => ws.close(VOICE_CLOSE.authTimeout, "Autenticación requerida"), authTimeoutMs),
    };
    ws.on("pong", () => {
      state.alive = true;
    });
    ws.on("message", (raw, isBinary) => {
      if (isBinary) onAudio(ws, state, raw as Buffer);
      else onJson(ws, state, raw, authState);
    });
    ws.on("close", () => {
      clearTimeout(authState.timer);
      sockets.delete(ws);
      void endConnection(state);
    });
  });

  const heartbeat = setInterval(() => {
    for (const [ws, state] of sockets) {
      if (!state.alive) {
        ws.terminate();
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();

  function onVoiceBus(message: VoiceBusMessage) {
    const inCall = connections().filter((conn) => conn.callId === message.callId);
    if (message.kind === "signal") {
      for (const conn of inCall)
        if (conn.role === message.to) send(conn.ws, { type: "signal", signal: message.signal });
      return;
    }
    if (message.kind === "ended") {
      clearTimeout(maxDurationTimers.get(message.callId));
      maxDurationTimers.delete(message.callId);
      for (const role of ["customer", "agent"] as const) {
        clearTimeout(graceTimers.get(graceKey(message.callId, role)));
        graceTimers.delete(graceKey(message.callId, role));
      }
      for (const conn of inCall) {
        conn.noGrace = true;
        send(conn.ws, { type: "call.ended", reason: message.reason });
        conn.ws.close(1000, "Llamada finalizada");
      }
      return;
    }
    // presence
    for (const conn of inCall) {
      if (conn.id === message.connectionId) continue;
      if (conn.role === message.role) {
        // Otra conexión del mismo rol (otra pestaña u otra instancia) es más nueva: esta sobra.
        if (message.present && !message.reply) {
          conn.noGrace = true;
          conn.ws.close(VOICE_CLOSE.replaced, "Reemplazada por una conexión nueva");
        }
        continue;
      }
      send(conn.ws, { type: "peer", role: message.role, present: message.present });
      // Contestar al recién llegado para que sepa que este participante ya estaba.
      if (message.present && !message.reply) {
        void publishVoice({
          kind: "presence",
          callId: conn.callId,
          role: conn.role,
          present: true,
          connectionId: conn.id,
          reply: true,
        });
      }
    }
    if (message.present && !message.reply) {
      // Llegó (aquí o en otra instancia): cancelar la espera de reconexión de ese rol.
      const key = graceKey(message.callId, message.role);
      clearTimeout(graceTimers.get(key));
      graceTimers.delete(key);
    }
  }

  function onRealtime(event: RealtimeEvent) {
    if (event.type !== "call.updated") return;
    for (const conn of connections()) {
      if (conn.callId === event.call.id) send(conn.ws, { type: "call.status", status: event.call.status });
    }
  }

  const unsubscribeVoice = await subscribeVoice(onVoiceBus);
  const unsubscribeRealtime = await subscribeRealtime(onRealtime);
  logger.info(`WebSocket de voz en ${VOICE_WS_PATH} (proveedor: ${getVoice().provider})`);

  return {
    connected() {
      const counts = { customer: 0, agent: 0 };
      for (const conn of connections()) counts[conn.role] += 1;
      return counts;
    },
    async close() {
      clearInterval(heartbeat);
      server.off("upgrade", onUpgrade);
      for (const timer of [...graceTimers.values(), ...maxDurationTimers.values()]) clearTimeout(timer);
      await unsubscribeVoice();
      await unsubscribeRealtime();
      for (const [ws, state] of sockets) {
        if (state.connection) state.connection.noGrace = true;
        ws.close(1001, "Servidor apagándose");
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
