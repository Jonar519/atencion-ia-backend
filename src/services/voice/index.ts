import { env } from "../../config/env";
import { voiceProviderDuration, voiceTtsCharacters } from "../../observability/metrics";
import { createDeepgramVoice } from "./deepgram.provider";
import { createMockVoice } from "./mock.provider";
import type { SpeechToText, TextToSpeech } from "./types";

export * from "./types";
export { SAMPLE_RATE } from "./pcm";

/**
 * Punto único de acceso a la voz: la sesión de llamada pide `getVoice()` y no
 * sabe si detrás está el mock o Deepgram (mismo patrón que services/ai).
 */
export interface VoiceServices {
  readonly provider: "mock" | "deepgram";
  stt: SpeechToText;
  tts: TextToSpeech;
}

function instrument(services: VoiceServices): VoiceServices {
  const { provider, tts } = services;
  return {
    provider,
    stt: services.stt,
    tts: {
      provider: tts.provider,
      model: tts.model,
      async synthesize(text, options) {
        const end = voiceProviderDuration.startTimer({ provider, operation: "synthesize" });
        try {
          const result = await tts.synthesize(text, options);
          end({ outcome: "ok" });
          voiceTtsCharacters.inc({ provider }, result.characters);
          return result;
        } catch (err) {
          end({ outcome: err instanceof Error ? err.name : "error" });
          throw err;
        }
      },
    },
  };
}

function build(): VoiceServices {
  if (env.voice.provider === "deepgram") {
    // env.ts ya exigió DEEPGRAM_API_KEY con VOICE_PROVIDER=deepgram.
    const deepgram = createDeepgramVoice({
      apiKey: env.voice.deepgramApiKey!,
      sttModel: env.voice.sttModel,
      ttsModel: env.voice.ttsModel,
      language: env.voice.language,
      timeoutMs: env.voice.timeoutMs,
    });
    return { provider: "deepgram", ...deepgram };
  }
  return { provider: "mock", ...createMockVoice() };
}

let current: VoiceServices | null = null;

export function getVoice(): VoiceServices {
  current ??= instrument(build());
  return current;
}

/** Solo tests: reemplaza los proveedores (fallas simuladas, guion propio). null = volver al configurado. */
export function setVoiceForTests(services: VoiceServices | null) {
  current = services ? instrument(services) : null;
}
