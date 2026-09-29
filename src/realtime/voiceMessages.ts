import type { CallEndReason } from "@prisma/client";

/**
 * Mensajes internos del canal de voz entre instancias de la API (Redis pub/sub,
 * canal aparte del de eventos). El cliente y el agente de una llamada pueden
 * estar conectados a instancias distintas: la señalización WebRTC y el control
 * de la llamada viajan por aquí y cada instancia entrega a SUS sockets.
 */
export type VoiceRole = "customer" | "agent";

export type VoiceBusMessage =
  /** Oferta/respuesta SDP o candidato ICE, ya validado, para el OTRO participante. */
  | { kind: "signal"; callId: string; to: VoiceRole; signal: Record<string, unknown> }
  /**
   * Alguien se conectó (o se fue) de la llamada. Sirve para:
   *  - avisar al otro participante (el agente inicia la oferta WebRTC cuando el cliente está);
   *  - "el más nuevo gana": si el mismo rol se reconecta (otra pestaña, otra instancia),
   *    la conexión anterior se cierra y no quedan dos micrófonos transcribiendo.
   */
  | { kind: "presence"; callId: string; role: VoiceRole; present: boolean; connectionId: string; reply?: boolean }
  /** La llamada terminó (por quien sea): cada instancia cierra sus sockets de esa llamada. */
  | { kind: "ended"; callId: string; reason: CallEndReason };
