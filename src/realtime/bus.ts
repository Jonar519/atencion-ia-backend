import { redisConnection } from "../config/redis";
import { logger } from "../config/logger";
import type { RealtimeEvent } from "./events";

/**
 * Bus de eventos de tiempo real sobre Redis pub/sub: cualquier proceso publica
 * (API, worker) y cada instancia de la API recibe todo y lo reparte a sus
 * sockets (wsServer.ts). Así funciona igual con una o con varias instancias.
 *
 * Publicar NUNCA hace fallar la operación que lo originó: el dato ya quedó en
 * la base, y el cliente lo recupera al reconectar (el frontend re-sincroniza
 * por REST después de cada reconexión).
 *
 * Los tests reemplazan este módulo por un bus en memoria (tests/setup.ts).
 */
export const REALTIME_CHANNEL = "atencion-ia:realtime";

export async function publishRealtime(event: RealtimeEvent): Promise<void> {
  try {
    await redisConnection.publish(REALTIME_CHANNEL, JSON.stringify(event));
  } catch (err) {
    logger.warn(
      { type: event.type, err: err instanceof Error ? err.message : String(err) },
      "No se pudo publicar el evento"
    );
  }
}

/** Suscripción (conexión Redis aparte: una conexión en modo subscribe no puede hacer otros comandos). */
export async function subscribeRealtime(handler: (event: RealtimeEvent) => void): Promise<() => Promise<void>> {
  const subscriber = redisConnection.duplicate();
  subscriber.on("error", (err: Error) => logger.warn({ err: err.message }, "Error en la suscripción de tiempo real"));
  await subscriber.subscribe(REALTIME_CHANNEL);
  subscriber.on("message", (_channel: string, raw: string) => {
    try {
      handler(JSON.parse(raw) as RealtimeEvent);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Evento de tiempo real inválido");
    }
  });
  return async () => {
    await subscriber.quit();
  };
}
