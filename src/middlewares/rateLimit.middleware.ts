import { Request } from "express";
import { rateLimit, ipKeyGenerator, Options } from "express-rate-limit";
import { RedisStore, RedisReply } from "rate-limit-redis";
import { env } from "../config/env";
import { redisConnection } from "../config/redis";

/**
 * Rate limiting con contadores en Redis (compartidos entre instancias de la
 * API). En tests se usa el store en memoria para no depender de Redis.
 */
function store(prefix: string): Options["store"] | undefined {
  if (env.nodeEnv === "test") return undefined;
  return new RedisStore({
    prefix: `rl:${prefix}:`,
    sendCommand: (command: string, ...args: string[]) => redisConnection.call(command, ...args) as Promise<RedisReply>,
  });
}

function limiter(prefix: string, windowMs: number, limit: number, message: string, extra: Partial<Options> = {}) {
  return rateLimit({
    windowMs,
    // RATE_LIMIT_SCALE: solo pruebas de carga; 1 en producción (ver env.ts).
    limit: limit * env.rateLimitScale,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    store: store(prefix),
    message: { error: message },
    ...extra,
  });
}

const MINUTE = 60 * 1000;

// Clave por usuario autenticado (cae a la IP si no hay usuario). Debe usarse DESPUÉS de authMiddleware.
const byUser = (req: Request) => req.user?.staffId ?? ipKeyGenerator(req.ip ?? "");

/** Límite general por IP para toda la API. */
export const globalLimiter = limiter(
  "global",
  15 * MINUTE,
  600,
  "Demasiadas solicitudes. Intenta de nuevo en unos minutos."
);

/**
 * Anti fuerza bruta en el login, por IP: solo cuentan los intentos FALLIDOS.
 * (El bloqueo progresivo POR CUENTA lo hace lockout.service con la tabla login_attempts.)
 */
export const loginLimiter = limiter(
  "login",
  15 * MINUTE,
  10,
  "Demasiados intentos fallidos de inicio de sesión. Espera 15 minutos.",
  { skipSuccessfulRequests: true }
);

/**
 * /refresh y /logout: el frontend refresca cada ~15 min por pestaña; un
 * volumen mucho mayor desde una IP es un intento de adivinar tokens.
 */
export const sessionLimiter = limiter("session", 15 * MINUTE, 60, "Demasiadas renovaciones de sesión.");

/** Escritura de mensajes por un agente: holgado para una conversación real, corta un script. */
export const agentMessageLimiter = limiter("agent-msg", MINUTE, 60, "Estás enviando mensajes demasiado rápido.", {
  keyGenerator: byUser,
});

/** Escrituras administrativas (staff, base de conocimiento). */
export const adminWriteLimiter = limiter("admin-write", 15 * MINUTE, 120, "Demasiadas modificaciones seguidas.", {
  keyGenerator: byUser,
});
