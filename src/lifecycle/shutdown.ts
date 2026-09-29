import type { Server } from "http";

export interface ShutdownStep {
  name: string;
  run: () => Promise<unknown>;
}

interface ShutdownOptions {
  timeoutMs: number;
  log: (message: string, extra?: Record<string, unknown>) => void;
  /** Inyectable en tests. */
  exit?: (code: number) => void;
}

/**
 * Apagado ordenado reutilizable (API y, desde la Fase 3, el worker): ejecuta
 * los pasos EN ORDEN y sale con 0; si un paso falla, sale con 1; si todo tarda
 * más de timeoutMs, fuerza la salida con 1. Una segunda señal mientras se
 * apaga se ignora.
 */
export function createGracefulShutdown(
  steps: ShutdownStep[],
  { timeoutMs, log, exit = process.exit }: ShutdownOptions
) {
  let started: Promise<void> | null = null;
  return (signal: string): Promise<void> => {
    started ??= (async () => {
      log("Apagado ordenado iniciado", { signal });
      const force = setTimeout(() => {
        log("El apagado ordenado superó el tiempo máximo; se fuerza la salida", { timeoutMs });
        exit(1);
      }, timeoutMs);
      force.unref?.();
      try {
        for (const step of steps) {
          await step.run();
          log(`Apagado: ${step.name} listo`);
        }
        clearTimeout(force);
        log("Apagado ordenado completo");
        exit(0);
      } catch (err) {
        clearTimeout(force);
        log("Error durante el apagado ordenado", { err: err instanceof Error ? err.message : String(err) });
        exit(1);
      }
    })();
    return started;
  };
}

const IDLE_SWEEP_MS = 100;

/**
 * Deja de aceptar conexiones y espera a que terminen las solicitudes en curso.
 * Las conexiones keep-alive ociosas se cierran de inmediato, y también las que
 * quedan ociosas DESPUÉS (cuando termina una solicitud en curso): sin ese
 * barrido el cierre esperaría al timeout de keep-alive del cliente.
 */
export function closeHttpServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  server.closeIdleConnections();
  const sweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS);
  return closed.finally(() => clearInterval(sweep));
}
