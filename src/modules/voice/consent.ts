import { env } from "../../config/env";

/**
 * Aviso de consentimiento que el cliente acepta ANTES de iniciar una llamada.
 * La versión queda en calls.consent_version; si el texto cambia, sube la
 * versión y el backend rechaza iniciar una llamada con una versión vieja (el
 * cliente debe ver el aviso vigente). Política completa: docs/privacy-voice.md.
 */
export const CONSENT_VERSION = "voz-v1";

export function consentNotice() {
  const days = env.voice.retentionDays;
  const minutes = Math.floor(env.voice.maxCallSeconds / 60);
  return {
    version: CONSENT_VERSION,
    title: "Antes de llamar",
    points: [
      "Te atiende primero un asistente de inteligencia artificial. Puedes pedir un asesor humano en cualquier momento.",
      "Tu voz se transcribe a texto con IA mientras hablas, y el texto se analiza (intención y tono) para darte la mejor atención y, si hace falta, pasarte con un asesor.",
      "El audio NO se graba: se procesa al momento y se descarta. Lo que se conserva es la transcripción.",
      `La transcripción se guarda ${days} días como parte de tu conversación y luego se elimina.`,
      `Cada llamada dura como máximo ${minutes} minutos. Puedes colgar cuando quieras y seguir por chat.`,
      "No digas contraseñas, claves ni el código de seguridad de tu tarjeta: nunca te los pediremos.",
    ],
    retentionDays: days,
    maxCallSeconds: env.voice.maxCallSeconds,
  };
}
