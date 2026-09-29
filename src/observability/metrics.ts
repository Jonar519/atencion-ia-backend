import type { NextFunction, Request, Response } from "express";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import { timingSafeEqual } from "crypto";
import { env } from "../config/env";

/**
 * Métricas Prometheus (prom-client), en GET /metrics con
 * "Authorization: Bearer <METRICS_TOKEN>". Sin METRICS_TOKEN el endpoint no
 * existe (404). Las etiquetas nunca llevan ids ni datos de personas: la ruta
 * se registra como patrón ("/api/conversations/:id"), no como URL real.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "atencion_ia_" });

const SECONDS_FAST = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const httpRequestDuration = new Histogram({
  name: "atencion_ia_http_request_duration_seconds",
  help: "Duración de las solicitudes HTTP de la API",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: SECONDS_FAST,
  registers: [registry],
});

export const authEvents = new Counter({
  name: "atencion_ia_auth_events_total",
  help: "Eventos de autenticación (login ok/fallido/bloqueado, reutilización de refresh token)",
  labelNames: ["event"] as const,
  registers: [registry],
});

export const conversationEvents = new Counter({
  name: "atencion_ia_conversation_events_total",
  help: "Transiciones de conversaciones hechas por el staff (tomar, cerrar)",
  labelNames: ["event"] as const,
  registers: [registry],
});

const SECONDS_SLOW = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30];

export const aiRequestDuration = new Histogram({
  name: "atencion_ia_ai_request_duration_seconds",
  help: "Latencia de las llamadas al proveedor de IA (respuesta, clasificación, embeddings)",
  labelNames: ["provider", "operation", "outcome"] as const,
  buckets: SECONDS_SLOW,
  registers: [registry],
});

export const aiTokens = new Counter({
  name: "atencion_ia_ai_tokens_total",
  help: "Tokens consumidos en el proveedor de IA",
  labelNames: ["provider", "operation", "direction"] as const,
  registers: [registry],
});

export const engineTurns = new Counter({
  name: "atencion_ia_engine_turns_total",
  help: "Turnos de cliente procesados por el motor conversacional, por canal y resultado",
  labelNames: ["channel", "outcome"] as const,
  registers: [registry],
});

export const escalationsCreated = new Counter({
  name: "atencion_ia_escalations_total",
  help: "Escalamientos creados (y los descartados por ya existir uno abierto)",
  labelNames: ["reason", "trigger", "result"] as const,
  registers: [registry],
});

export const ragTopScore = new Histogram({
  name: "atencion_ia_rag_top_score",
  help: "Similitud del mejor fragmento recuperado por turno (0 = no se usó ninguno)",
  buckets: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
  registers: [registry],
});

export const websocketConnections = new Gauge({
  name: "atencion_ia_websocket_connections",
  help: "WebSockets autenticados conectados a esta instancia, por tipo (staff o cliente)",
  labelNames: ["kind"] as const,
  registers: [registry],
});

export const queueJobs = new Gauge({
  name: "atencion_ia_queue_jobs",
  help: "Trabajos por cola y estado (se lee de Redis en cada scrape)",
  labelNames: ["queue", "state"] as const,
  registers: [registry],
});

type ScrapeHook = () => Promise<void>;
const scrapeHooks: ScrapeHook[] = [];

/** Registra una función que actualiza gauges justo antes de cada scrape (p. ej. leer las colas). */
export function onScrape(hook: ScrapeHook) {
  scrapeHooks.push(hook);
}

export async function renderMetrics(): Promise<string> {
  await Promise.all(scrapeHooks.map((hook) => hook().catch(() => undefined)));
  return registry.metrics();
}

/** Middleware: duración por método, ruta (patrón, no la URL real) y código. */
export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    // req.route solo existe si una ruta respondió; baseUrl + path = patrón.
    const route = req.route ? `${req.baseUrl}${req.route.path}` : req.baseUrl || "sin_ruta";
    end({ method: req.method, route, status_code: String(res.statusCode) });
  });
  next();
}

export function tokenMatches(header: string | undefined): boolean {
  if (!env.metricsToken || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(env.metricsToken);
  // Comparación en tiempo constante: no filtra el token carácter a carácter.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function metricsHandler(req: Request, res: Response) {
  if (!env.metricsToken) {
    res.status(404).json({ error: "Ruta no encontrada" });
    return;
  }
  if (!tokenMatches(req.get("authorization"))) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }
  res.set("Content-Type", registry.contentType);
  res.send(await renderMetrics());
}
