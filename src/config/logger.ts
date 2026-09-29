import pino from "pino";
import { env } from "./env";

/**
 * Logger estructurado. `redact` reemplaza por "[REDACTED]" cualquier campo
 * sensible que termine dentro de un log, aunque se loguee por accidente un
 * objeto completo (headers, body de login, configuración…).
 *
 * Además de credenciales, se redacta el CONTENIDO de las conversaciones: el
 * texto que escribe o dice un cliente es dato personal y no debe ir a los logs.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "authorization",
  "cookie",
  "password",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "content",
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.content",
  "*.jwtSecret",
  "*.ipHashSecret",
  "*.metricsToken",
  "*.databaseUrl",
  "*.redisUrl",
];

export const logger = pino({
  level: env.logLevel,
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  ...(env.nodeEnv === "development"
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } } }
    : {}),
});
