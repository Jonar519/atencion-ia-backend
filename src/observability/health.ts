import type { Request, Response } from "express";
import { prisma } from "../config/prisma";
import { redisConnection } from "../config/redis";

/**
 * Sondas para el orquestador (balanceador / ECS / Kubernetes):
 *
 *  - GET /health (liveness): "el proceso está vivo y el event loop responde".
 *    NO consulta dependencias: si PostgreSQL se cae, reiniciar la API no lo
 *    arregla, y un liveness que dependa de la base provocaría reinicios en cadena.
 *  - GET /ready (readiness): "puedo atender tráfico": PostgreSQL y Redis
 *    responden (con timeout). Durante el apagado ordenado responde 503 para
 *    que el balanceador deje de enviar solicitudes antes de cerrar.
 */

const CHECK_TIMEOUT_MS = 2_000;

let shuttingDown = false;

export function markShuttingDown() {
  shuttingDown = true;
}

/** Solo para tests. */
export function resetShuttingDown() {
  shuttingDown = false;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`sin respuesta en ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function check(fn: () => Promise<unknown>): Promise<string> {
  try {
    await withTimeout(fn(), CHECK_TIMEOUT_MS);
    return "ok";
  } catch (err) {
    // Mensaje corto y sin cadenas de conexión.
    return `error: ${err instanceof Error ? (err.message.split("\n")[0] ?? "").slice(0, 120) : "desconocido"}`;
  }
}

export async function readinessChecks() {
  const [database, redis] = await Promise.all([
    check(() => prisma.$queryRaw`SELECT 1`),
    check(() => redisConnection.ping()),
  ]);
  return { database, redis };
}

export function healthHandler(_req: Request, res: Response) {
  res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
}

export async function readyHandler(_req: Request, res: Response) {
  if (shuttingDown) {
    res.status(503).json({ status: "shutting_down" });
    return;
  }
  const checks = await readinessChecks();
  const ready = Object.values(checks).every((value) => value === "ok");
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
}
