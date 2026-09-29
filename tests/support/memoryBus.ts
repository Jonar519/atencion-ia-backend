import { EventEmitter } from "events";
import type { RealtimeEvent } from "../../src/realtime/events";

/**
 * Bus de tiempo real EN MEMORIA para tests (misma interfaz que src/realtime/bus.ts).
 * Serializa y deserializa cada evento, igual que Redis: así un test no puede
 * depender de compartir objetos por referencia entre quien publica y quien recibe.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export const REALTIME_CHANNEL = "atencion-ia:realtime";
export const published: RealtimeEvent[] = [];

export async function publishRealtime(event: RealtimeEvent): Promise<void> {
  published.push(event);
  emitter.emit("event", JSON.parse(JSON.stringify(event)));
}

export async function subscribeRealtime(handler: (event: RealtimeEvent) => void): Promise<() => Promise<void>> {
  emitter.on("event", handler);
  return async () => {
    emitter.off("event", handler);
  };
}
