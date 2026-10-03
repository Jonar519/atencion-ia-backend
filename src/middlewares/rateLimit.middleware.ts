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

/** Sesiones anónimas del widget: por IP, para que un script no cree miles de clientes. */
export const widgetSessionLimiter = limiter(
  "widget-session",
  60 * MINUTE,
  20,
  "Demasiadas sesiones nuevas desde tu red."
);

/**
 * Mensajes del cliente al asistente: cada uno dispara IA (cuesta dinero).
 * Por SESIÓN del widget (debe ir después de widgetAuth). El tope diario de
 * tokens por cliente (engine/budget.service.ts) es la segunda barrera.
 */
export const customerAiLimiter = limiter(
  "customer-ai",
  MINUTE,
  12,
  "Estás escribiendo muy rápido. Espera un momento.",
  {
    keyGenerator: (req: Request) => req.widget?.sessionId ?? ipKeyGenerator(req.ip ?? ""),
  }
);

/**
 * Llamadas de voz nuevas: cada una abre STT/TTS (cuesta dinero). Por sesión
 * del widget; los topes diarios de voz y de IA por cliente son la segunda barrera.
 */
export const callStartLimiter = limiter(
  "call-start",
  60 * MINUTE,
  6,
  "Demasiadas llamadas seguidas. Espera un momento.",
  {
    keyGenerator: (req: Request) => req.widget?.sessionId ?? ipKeyGenerator(req.ip ?? ""),
  }
);

/** Unirse/salir/colgar llamadas desde el panel. */
export const callStaffLimiter = limiter("call-staff", MINUTE, 30, "Demasiadas acciones sobre llamadas seguidas.", {
  keyGenerator: byUser,
});

/** Segundo paso del login (MFA), por IP. El bloqueo por cuenta lo lleva lockout.service. */
export const mfaLimiter = limiter("mfa", 15 * MINUTE, 20, "Demasiados intentos de verificación. Espera 15 minutos.");

/**
 * "Olvidé mi contraseña" y confirmar enlaces, por IP: cada solicitud genera un
 * correo (no se debe poder usar la API para inundar la bandeja de alguien).
 */
export const passwordResetLimiter = limiter(
  "password-reset",
  60 * MINUTE,
  10,
  "Demasiadas solicitudes de recuperación. Espera una hora."
);

/** Cambios en el propio perfil (datos, correo, contraseña, avatar, MFA, sesiones). */
export const profileWriteLimiter = limiter("profile-write", 15 * MINUTE, 60, "Demasiados cambios seguidos.", {
  keyGenerator: byUser,
});

/**
 * Subida de adjuntos (bloque C): cada uno ocupa almacenamiento. Por sesión del
 * widget o por miembro del staff; 30 por hora alcanza para una conversación real.
 */
export const attachmentUploadLimiter = limiter(
  "attachment-upload",
  60 * MINUTE,
  30,
  "Adjuntaste demasiados archivos seguidos. Espera un momento.",
  {
    keyGenerator: (req: Request) => req.widget?.sessionId ?? req.user?.staffId ?? ipKeyGenerator(req.ip ?? ""),
  }
);
