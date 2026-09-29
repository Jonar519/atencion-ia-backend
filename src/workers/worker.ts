import http from "http";
import { Worker } from "bullmq";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { prisma } from "../config/prisma";
import { redisConnection } from "../config/redis";
import { renderMetrics, registry, tokenMatches } from "../observability/metrics";
import { closeHttpServer, createGracefulShutdown } from "../lifecycle/shutdown";
import { indexArticle } from "../modules/rag/indexing.service";
import {
  closeQueues,
  ESCALATION_NOTIFY_QUEUE,
  KB_INDEXING_QUEUE,
  scheduleVoiceMaintenance,
  VOICE_MAINTENANCE_QUEUE,
  type EscalationNotifyJob,
  type KbIndexingJob,
  type VoiceMaintenanceJob,
} from "../queues/queues";
import { callsService } from "../modules/voice/calls.service";
import { notifyEscalation } from "./notifyEscalation";

/**
 * Proceso worker (separado de la API): `npm run worker`.
 *  - kb-indexing: embeddings + índice del RAG de un artículo.
 *  - escalation-notify: aviso a los agentes de un escalamiento nuevo.
 *  - voice-maintenance (programado): cierra llamadas abandonadas y purga
 *    transcripciones vencidas (docs/privacy-voice.md).
 * Expone GET /health y GET /metrics (con METRICS_TOKEN) en WORKER_METRICS_PORT.
 * Apagado ordenado con SIGTERM/SIGINT: deja de tomar trabajos, termina los
 * que tiene en curso y cierra conexiones.
 */

const workerOptions = { connection: redisConnection, concurrency: env.workerConcurrency };

const kbWorker = new Worker<KbIndexingJob>(
  KB_INDEXING_QUEUE,
  async (job) => {
    const outcome = await indexArticle(job.data.articleId);
    logger.info({ jobId: job.id, articleId: job.data.articleId, outcome }, "Artículo procesado para el RAG");
    return outcome;
  },
  workerOptions
);

const notifyWorker = new Worker<EscalationNotifyJob>(
  ESCALATION_NOTIFY_QUEUE,
  async (job) => {
    const event = await notifyEscalation(job.data.escalationId);
    logger.info(
      { jobId: job.id, escalationId: job.data.escalationId, candidates: event?.candidateAgentIds.length ?? 0 },
      event ? "Escalamiento notificado a los agentes" : "Escalamiento ya no estaba abierto"
    );
    return event;
  },
  workerOptions
);

const voiceWorker = new Worker<VoiceMaintenanceJob>(
  VOICE_MAINTENANCE_QUEUE,
  async (job) => {
    if (job.name === "sweep") return { ended: await callsService.sweepStale() };
    let purged = 0;
    // Por lotes hasta vaciar lo vencido.
    for (
      let batch = await callsService.purgeExpiredTranscripts();
      batch > 0;
      batch = await callsService.purgeExpiredTranscripts()
    ) {
      purged += batch;
    }
    if (purged) logger.info({ purged }, "Transcripciones purgadas por retención");
    return { purged };
  },
  { connection: redisConnection, concurrency: 1 }
);

for (const worker of [kbWorker, notifyWorker, voiceWorker]) {
  worker.on("failed", (job, err) =>
    logger.warn(
      { queue: worker.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
      "Trabajo fallido"
    )
  );
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.url === "/metrics" && env.metricsToken) {
    if (!tokenMatches(req.headers.authorization)) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "Content-Type": registry.contentType }).end(await renderMetrics());
    return;
  }
  res.writeHead(404).end();
});
server.listen(env.workerMetricsPort, () => logger.info(`Worker: sondas y métricas en :${env.workerMetricsPort}`));

const shutdown = createGracefulShutdown(
  [
    {
      name: "workers (terminan lo que tienen en curso)",
      run: () => Promise.all([kbWorker.close(), notifyWorker.close(), voiceWorker.close()]),
    },
    { name: "colas", run: () => closeQueues() },
    { name: "servidor de métricas", run: () => closeHttpServer(server) },
    { name: "Redis", run: () => redisConnection.quit() },
    { name: "PostgreSQL", run: () => prisma.$disconnect() },
  ],
  { timeoutMs: env.shutdownTimeoutMs, log: (message, extra) => logger.info(extra ?? {}, message) }
);
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

scheduleVoiceMaintenance().catch((err: unknown) =>
  logger.error(
    { err: err instanceof Error ? err.message : String(err) },
    "No se pudo programar el mantenimiento de voz"
  )
);

logger.info({ provider: env.ai.provider, concurrency: env.workerConcurrency }, "Worker iniciado");
