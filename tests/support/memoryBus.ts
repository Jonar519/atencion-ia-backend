import { EventEmitter } from "events";
import type { RealtimeEvent } from "../../src/realtime/events";
import type { VoiceBusMessage } from "../../src/realtime/voiceMessages";

/**
 * Bus de tiempo real EN MEMORIA para tests (misma interfaz que src/realtime/bus.ts).
 * Serializa y deserializa cada evento, igual que Redis: así un test no puede
 * depender de compartir objetos por referencia entre quien publica y quien recibe.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export const REALTIME_CHANNEL = "atencion-ia:realtime";
export const VOICE_CHANNEL = "atencion-ia:voice";
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

export const publishedVoice: VoiceBusMessage[] = [];

export async function publishVoice(message: VoiceBusMessage): Promise<void> {
  publishedVoice.push(message);
  emitter.emit("voice", JSON.parse(JSON.stringify(message)));
}

export async function subscribeVoice(handler: (message: VoiceBusMessage) => void): Promise<() => Promise<void>> {
  emitter.on("voice", handler);
  return async () => {
    emitter.off("voice", handler);
  };
}
