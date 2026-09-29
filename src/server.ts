import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { prisma } from "./config/prisma";
import { redisConnection } from "./config/redis";
import { markShuttingDown } from "./observability/health";
import { flushAudit } from "./services/audit/audit.service";
import { closeHttpServer, createGracefulShutdown } from "./lifecycle/shutdown";
import { closeQueues } from "./queues/queues";
import { attachRealtime } from "./realtime/wsServer";
import { attachVoice } from "./realtime/voiceServer";

async function main() {
  await prisma.$connect();
  logger.info({ aiProvider: env.ai.provider, voiceProvider: env.voice.provider }, "Conectado a la base de datos.");

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info(`API escuchando en http://localhost:${env.port}`);
  });
  // WebSocket de tiempo real en el mismo puerto (ruta /ws).
  const realtime = await attachRealtime(server);
  // WebSocket de voz (audio + señalización WebRTC) en /ws/voice.
  const voice = await attachVoice(server);

  /**
   * Apagado ordenado (SIGTERM del orquestador, o Ctrl+C = SIGINT en la consola):
   *  1. /ready empieza a responder 503 y se esperan SHUTDOWN_DRAIN_DELAY_MS
   *     para que el balanceador lo vea y deje de enviar tráfico.
   *  2. Se dejan de aceptar conexiones y se esperan las solicitudes en curso.
   *  3. Se escriben los registros de auditoría pendientes y se cierran Redis
   *     y PostgreSQL.
   * Si algo se cuelga, a los SHUTDOWN_TIMEOUT_MS se fuerza la salida.
   * Nota Windows: cmd.exe no envía SIGTERM; Ctrl+C envía SIGINT (mismo camino).
   */
  const shutdown = createGracefulShutdown(
    [
      { name: "readiness en 503", run: async () => markShuttingDown() },
      {
        name: "drenaje del balanceador",
        run: () => new Promise((resolve) => setTimeout(resolve, env.shutdownDrainDelayMs)),
      },
      // Primero los WebSocket: el navegador se reconecta a otra instancia.
      { name: "WebSocket", run: () => realtime.close() },
      { name: "WebSocket de voz", run: () => voice.close() },
      { name: "servidor HTTP", run: () => closeHttpServer(server) },
      { name: "auditoría pendiente", run: () => flushAudit() },
      { name: "colas", run: () => closeQueues() },
      { name: "Redis", run: () => redisConnection.quit() },
      { name: "PostgreSQL", run: () => prisma.$disconnect() },
    ],
    { timeoutMs: env.shutdownTimeoutMs, log: (message, extra) => logger.info(extra ?? {}, message) }
  );
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal(
    { err: err instanceof Error ? { name: err.name, message: err.message } : String(err) },
    "Error al iniciar el servidor"
  );
  process.exit(1);
});
