import { z } from "zod";
import { uuidSchema } from "../../utils/schemas";

export const startCallSchema = z
  .object({
    consentVersion: z.string().min(1).max(20),
    // Debe ser literalmente true: el cliente marcó que leyó y acepta el aviso.
    accepted: z.literal(true, { errorMap: () => ({ message: "Debes aceptar el aviso para iniciar la llamada" }) }),
  })
  .strict();
export type StartCallInput = z.infer<typeof startCallSchema>;

/**
 * Señalización WebRTC que el servidor acepta RELEVAR entre cliente y agente.
 * Se valida la forma y el tamaño: el servidor no interpreta el SDP, pero no
 * reenvía cualquier cosa (ni objetos gigantes, ni campos extra).
 */
const sdpSignal = z
  .object({
    type: z.enum(["offer", "answer"]),
    sdp: z.string().min(1).max(16_000),
  })
  .strict();

const candidateSignal = z
  .object({
    type: z.literal("candidate"),
    candidate: z
      .object({
        candidate: z.string().max(1_000),
        sdpMid: z.string().max(64).nullable().optional(),
        sdpMLineIndex: z.number().int().min(0).max(16).nullable().optional(),
        usernameFragment: z.string().max(64).nullable().optional(),
      })
      .strict(),
  })
  .strict();

export const signalSchema = z.discriminatedUnion("type", [
  sdpSignal.extend({ type: z.literal("offer") }),
  sdpSignal.extend({ type: z.literal("answer") }),
  candidateSignal,
]);
export type Signal = z.infer<typeof signalSchema>;

/** Mensajes JSON que un participante puede enviar por el WebSocket de voz. */
export const voiceClientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("auth"),
      callId: uuidSchema,
      accessToken: z.string().max(4_000).optional(),
      widgetToken: z.string().max(100).optional(),
    })
    .strict(),
  z.object({ type: z.literal("signal"), signal: signalSchema }).strict(),
  z.object({ type: z.literal("hangup") }).strict(),
  z.object({ type: z.literal("ping") }).strict(),
]);
export type VoiceClientMessage = z.infer<typeof voiceClientMessageSchema>;
