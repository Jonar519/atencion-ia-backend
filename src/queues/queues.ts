import { Queue } from "bullmq";
import { redisConnection } from "../config/redis";
import { logger } from "../config/logger";
import { onScrape, queueJobs } from "../observability/metrics";

/**
 * Colas BullMQ (Redis). Los productores (API) solo encolan; el trabajo lo
 * hace el worker (src/workers/worker.ts), en otro proceso:
 *  - kb-indexing: calcular embeddings de un artículo e indexarlo para el RAG.
 *  - escalation-notify: avisar a los agentes de un escalamiento nuevo.
 *  - voice-maintenance: trabajos PROGRAMADOS de la voz (barrido de llamadas
 *    abandonadas cada minuto, purga por retención cada hora).
 *
 * Los tests reemplazan este módulo (tests/setup.ts): no necesitan Redis.
 */

export const KB_INDEXING_QUEUE = "kb-indexing";
export const ESCALATION_NOTIFY_QUEUE = "escalation-notify";
export const VOICE_MAINTENANCE_QUEUE = "voice-maintenance";
export type VoiceMaintenanceJob = Record<string, never>;

export interface KbIndexingJob {
  articleId: string;
}
export interface EscalationNotifyJob {
  escalationId: string;
}

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

let kbQueue: Queue<KbIndexingJob> | null = null;
let escalationQueue: Queue<EscalationNotifyJob> | null = null;
let voiceQueue: Queue<VoiceMaintenanceJob> | null = null;

function kbIndexingQueue() {
  kbQueue ??= new Queue<KbIndexingJob>(KB_INDEXING_QUEUE, { connection: redisConnection, defaultJobOptions });
  return kbQueue;
}
function escalationNotifyQueue() {
  escalationQueue ??= new Queue<EscalationNotifyJob>(ESCALATION_NOTIFY_QUEUE, {
    connection: redisConnection,
    defaultJobOptions,
  });
  return escalationQueue;
}

function voiceMaintenanceQueue() {
  voiceQueue ??= new Queue<VoiceMaintenanceJob>(VOICE_MAINTENANCE_QUEUE, {
    connection: redisConnection,
    defaultJobOptions: { attempts: 1, removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
  });
  return voiceQueue;
}

/**
 * Programa los trabajos periódicos de la voz (lo llama el worker al arrancar).
 * upsertJobScheduler es idempotente: reiniciar el worker, o tener varios, no
 * duplica la programación.
 */
export async function scheduleVoiceMaintenance() {
  const queue = voiceMaintenanceQueue();
  await queue.upsertJobScheduler("voice-sweep", { every: 60_000 }, { name: "sweep", data: {} });
  await queue.upsertJobScheduler("voice-purge", { every: 3_600_000 }, { name: "purge", data: {} });
}

/**
 * Encola la (re)indexación de un artículo. jobId con la versión y el estado:
 * dos ediciones seguidas iguales no duplican trabajo, pero una edición nueva sí
 * genera su propio trabajo. Si Redis falla, se registra y NO se rompe la
 * operación del admin: `npm run kb:reindex` repara el índice.
 */
export async function enqueueArticleIndexing(articleId: string, version: number, status: string) {
  try {
    await kbIndexingQueue().add("index", { articleId }, { jobId: `${articleId}-v${version}-${status}` });
  } catch (err) {
    logger.error(
      { articleId, err: err instanceof Error ? err.message : String(err) },
      "No se pudo encolar la indexación"
    );
  }
}

/** Encola el aviso de un escalamiento. jobId = id del escalamiento: nunca se avisa dos veces. */
export async function enqueueEscalationNotify(escalationId: string) {
  try {
    await escalationNotifyQueue().add("notify", { escalationId }, { jobId: escalationId });
  } catch (err) {
    // El escalamiento ya existe en la base y la conversación ya está en la cola
    // general: los agentes la ven aunque este aviso inmediato falle.
    logger.error(
      { escalationId, err: err instanceof Error ? err.message : String(err) },
      "No se pudo encolar el aviso"
    );
  }
}

export async function closeQueues() {
  await Promise.all([kbQueue?.close(), escalationQueue?.close(), voiceQueue?.close()]);
}

// Estado de las colas en cada scrape de /metrics.
onScrape(async () => {
  for (const [name, queue] of [
    [KB_INDEXING_QUEUE, kbIndexingQueue()],
    [ESCALATION_NOTIFY_QUEUE, escalationNotifyQueue()],
    [VOICE_MAINTENANCE_QUEUE, voiceMaintenanceQueue()],
  ] as const) {
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
    for (const [state, value] of Object.entries(counts)) queueJobs.set({ queue: name, state }, value);
  }
});
