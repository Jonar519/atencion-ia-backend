import "dotenv/config";
import { z } from "zod";

/**
 * Configuración validada con zod al arrancar: si falta o sobra algo peligroso,
 * el proceso no arranca (mejor fallar al inicio que a mitad de una petición).
 */

const nodeEnv = z.enum(["development", "test", "production"]).default("development").parse(process.env.NODE_ENV);
const isProduction = nodeEnv === "production";

const secret = (name: string) =>
  z
    .string({ required_error: `Falta la variable de entorno ${name}. Revisa tu archivo .env` })
    .min(32, `${name} debe tener al menos 32 caracteres`);

const positiveInt = (fallback: number) => z.coerce.number().int().min(1).default(fallback);

const schema = z
  .object({
    PORT: positiveInt(4100),
    DATABASE_URL: z.string({ required_error: "Falta DATABASE_URL. Revisa tu archivo .env" }).url(),
    REDIS_URL: z.string().url().default("redis://localhost:6380"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default(nodeEnv === "test" ? "silent" : "info"),

    JWT_SECRET: secret("JWT_SECRET"),
    JWT_EXPIRES_IN: z
      .string()
      .regex(/^\d+[smh]$/, 'JWT_EXPIRES_IN debe tener la forma "15m", "900s" o "1h"')
      .default("15m"),
    REFRESH_TOKEN_TTL_DAYS: positiveInt(7),
    COOKIE_SECURE: z.enum(["true", "false"]).default(isProduction ? "true" : "false"),
    IP_HASH_SECRET: secret("IP_HASH_SECRET"),

    // Orígenes permitidos por CORS, separados por coma. Obligatorio en producción.
    CORS_ORIGIN: isProduction ? z.string().min(1) : z.string().default("http://localhost:5174"),
    // Número de proxies delante de la app (para que el rate limiting vea la IP real).
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    // Multiplicador de TODOS los rate limits. Solo para pruebas de carga.
    RATE_LIMIT_SCALE: z.coerce.number().min(1).default(1),

    // Vacío = /metrics desactivado (404).
    METRICS_TOKEN: z.string().optional(),
    SHUTDOWN_TIMEOUT_MS: positiveInt(10_000),
    SHUTDOWN_DRAIN_DELAY_MS: z.coerce.number().int().min(0).default(0),
  })
  .superRefine((value, ctx) => {
    if (value.JWT_SECRET === value.IP_HASH_SECRET) {
      ctx.addIssue({ code: "custom", path: ["IP_HASH_SECRET"], message: "Debe ser distinto de JWT_SECRET" });
    }
    if (isProduction && value.RATE_LIMIT_SCALE !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["RATE_LIMIT_SCALE"],
        message: "Es solo para pruebas de carga y no puede usarse con NODE_ENV=production",
      });
    }
    if (value.METRICS_TOKEN && value.METRICS_TOKEN.length < 16) {
      ctx.addIssue({ code: "custom", path: ["METRICS_TOKEN"], message: "Debe tener al menos 16 caracteres" });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
  throw new Error(`Configuración inválida (revisa tu archivo .env):\n${problems}`);
}
const e = parsed.data;

export const env = {
  nodeEnv,
  port: e.PORT,
  databaseUrl: e.DATABASE_URL,
  redisUrl: e.REDIS_URL,
  logLevel: e.LOG_LEVEL,

  jwtSecret: e.JWT_SECRET,
  // Access token: corto, solo en memoria del navegador (nunca en localStorage).
  jwtExpiresIn: e.JWT_EXPIRES_IN,
  // Refresh token (cookie httpOnly, rotativo): días de vida de una sesión inactiva.
  refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
  cookieSecure: e.COOKIE_SECURE === "true",
  ipHashSecret: e.IP_HASH_SECRET,

  corsOrigins: e.CORS_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  trustProxy: e.TRUST_PROXY,
  rateLimitScale: e.RATE_LIMIT_SCALE,

  metricsToken: e.METRICS_TOKEN || undefined,
  shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
  // Espera entre "/ready = 503" y dejar de aceptar conexiones, para que el
  // balanceador alcance a sacar la instancia. 0 en local.
  shutdownDrainDelayMs: e.SHUTDOWN_DRAIN_DELAY_MS,
};
