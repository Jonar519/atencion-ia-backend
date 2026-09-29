import IORedis from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

// Conexión compartida: rate limiting ahora; colas BullMQ (Fase 3) y pub/sub de
// señalización WebRTC (Fase 5) después. maxRetriesPerRequest: null es
// requerido por BullMQ para las conexiones de Worker/QueueEvents.
export const redisConnection = new IORedis(env.redisUrl, {
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

// Sin este listener, ioredis imprime cada reintento como "Unhandled error event".
redisConnection.on("error", (err: Error) => logger.warn({ err: err.message }, "Error de conexión con Redis"));
