import type { IncomingMessage, Server } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { verifyAccessToken } from "../modules/auth/tokens";
import { resolveWidgetToken, WIDGET_COOKIE } from "../modules/widget/widgetAuth.middleware";
import { readCookie } from "../utils/cookies";
import { websocketConnections } from "../observability/metrics";
import { audienceFor, type SocketIdentity } from "./audience";
import { subscribeRealtime } from "./bus";
import type { RealtimeEvent } from "./events";

/**
 * WebSocket de tiempo real (ruta /ws, mismo puerto que la API). SOLO RECIBE:
 * enviar mensajes sigue siendo por REST, que ya tiene validación, idempotencia,
 * rate limit y tope de IA. Así el socket no abre una segunda puerta de entrada.
 *
 * Protocolo (JSON):
 *   cliente → { "type": "auth", "accessToken": "<jwt>" }   staff (token en memoria del panel)
 *   cliente → { "type": "auth" }                            cliente del widget (cookie httpOnly del upgrade)
 *   cliente → { "type": "auth", "widgetToken": "wgt_…" }    cliente de API/tests, sin cookie
 *   servidor → { "type": "ready", "kind": "staff" | "customer" }
 *   servidor → eventos recortados por destinatario (audience.ts)
 *   cliente → { "type": "ping" }  → servidor → { "type": "pong" }
 *
 * Seguridad:
 *  - Origin debe estar en CORS_ORIGIN (evita cross-site WebSocket hijacking,
 *    sobre todo con la cookie del widget, que el navegador enviaría sola).
 *  - El token del staff va en el primer mensaje, nunca en la URL (no queda en logs).
 *  - Sin autenticarse en AUTH_TIMEOUT_MS, se cierra. Mensajes grandes, JSON
 *    inválido o demasiados mensajes seguidos cierran la conexión.
 *  - Se cierra cuando vence el token del staff o la sesión del widget: el
 *    cliente renueva y se reconecta.
 */

export const WS_PATH = "/ws";
export const WS_CLOSE = {
  unauthorized: 4401,
  authTimeout: 4408,
  tokenExpired: 4409,
  tooManyMessages: 4429,
} as const;
const HEARTBEAT_MS = 30_000;
/** Mensajes entrantes permitidos por ventana (el cliente solo envía auth y ping). */
const MAX_MESSAGES_PER_WINDOW = 20;
const MESSAGE_WINDOW_MS = 10_000;

interface SocketState {
  identity: SocketIdentity | null;
  alive: boolean;
  expiryTimer?: NodeJS.Timeout;
  windowStart: number;
  messagesInWindow: number;
}

export interface RealtimeServer {
  close(): Promise<void>;
  /** Solo tests: entrega un evento como si llegara por el bus. */
  dispatch(event: RealtimeEvent): void;
  connected(): { staff: number; customer: number };
}

export async function attachRealtime(
  server: Server,
  options: { authTimeoutMs?: number; heartbeatMs?: number } = {}
): Promise<RealtimeServer> {
  const authTimeoutMs = options.authTimeoutMs ?? 5_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const states = new Map<WebSocket, SocketState>();
  const upgradeCookies = new WeakMap<WebSocket, string | undefined>();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
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

  function closeAt(ws: WebSocket, state: SocketState, expiresAtMs: number) {
    const msLeft = Math.max(expiresAtMs - Date.now(), 0);
    // setTimeout admite hasta ~24,8 días; una sesión más larga se revisa al reconectar.
    state.expiryTimer = setTimeout(
      () => ws.close(WS_CLOSE.tokenExpired, "Sesión expirada"),
      Math.min(msLeft, 2 ** 31 - 1)
    );
  }

  async function authenticate(ws: WebSocket, state: SocketState, message: Record<string, unknown>) {
    if (typeof message.accessToken === "string") {
      const payload = verifyAccessToken(message.accessToken);
      if (!payload) return false;
      state.identity = { kind: "staff", user: { staffId: payload.staffId, role: payload.role } };
      if (payload.exp) closeAt(ws, state, payload.exp * 1000);
      return true;
    }
    const widgetToken = typeof message.widgetToken === "string" ? message.widgetToken : upgradeCookies.get(ws);
    const identity = await resolveWidgetToken(widgetToken);
    if (!identity) return false;
    state.identity = { kind: "customer", customerId: identity.customerId };
    closeAt(ws, state, identity.expiresAt.getTime());
    return true;
  }

  wss.on("connection", (ws: WebSocket) => {
    const state: SocketState = { identity: null, alive: true, windowStart: Date.now(), messagesInWindow: 0 };
    states.set(ws, state);
    let authenticating = false;
    const authTimer = setTimeout(() => ws.close(WS_CLOSE.authTimeout, "Autenticación requerida"), authTimeoutMs);

    ws.on("pong", () => {
      state.alive = true;
    });

    ws.on("message", (raw) => {
      const now = Date.now();
      if (now - state.windowStart > MESSAGE_WINDOW_MS) {
        state.windowStart = now;
        state.messagesInWindow = 0;
      }
      if (++state.messagesInWindow > MAX_MESSAGES_PER_WINDOW) {
        ws.close(WS_CLOSE.tooManyMessages, "Demasiados mensajes");
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        ws.close(WS_CLOSE.unauthorized, "Mensaje inválido");
        return;
      }
      if (message.type === "ping") {
        if (state.identity) ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (message.type !== "auth" || state.identity || authenticating) return;
      authenticating = true;
      authenticate(ws, state, message)
        .then((ok) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (!ok) {
            ws.close(WS_CLOSE.unauthorized, "Credenciales inválidas");
            return;
          }
          clearTimeout(authTimer);
          websocketConnections.inc({ kind: state.identity!.kind });
          ws.send(JSON.stringify({ type: "ready", kind: state.identity!.kind }));
        })
        .catch((err: unknown) => {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Error autenticando un WebSocket");
          ws.close(WS_CLOSE.unauthorized, "Error de autenticación");
        })
        .finally(() => {
          authenticating = false;
        });
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      clearTimeout(state.expiryTimer);
      if (state.identity) websocketConnections.dec({ kind: state.identity.kind });
      states.delete(ws);
    });
  });

  // Heartbeat: cierra sockets muertos (portátil suspendido, red caída sin aviso).
  const heartbeat = setInterval(() => {
    for (const [ws, state] of states) {
      if (!state.alive) {
        ws.terminate();
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();

  /** Reparte un evento: a cada socket, SOLO lo que su identidad puede ver. */
  function dispatch(event: RealtimeEvent) {
    for (const [ws, state] of states) {
      if (!state.identity || ws.readyState !== WebSocket.OPEN) continue;
      const payload = audienceFor(event, state.identity);
      if (payload) ws.send(JSON.stringify(payload));
    }
  }

  const unsubscribe = await subscribeRealtime(dispatch);
  logger.info(`WebSocket de tiempo real en ${WS_PATH}`);

  return {
    dispatch,
    connected: () => {
      const counts = { staff: 0, customer: 0 };
      for (const state of states.values()) if (state.identity) counts[state.identity.kind] += 1;
      return counts;
    },
    async close() {
      clearInterval(heartbeat);
      server.off("upgrade", onUpgrade);
      await unsubscribe();
      for (const ws of states.keys()) ws.close(1001, "Servidor apagándose");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
