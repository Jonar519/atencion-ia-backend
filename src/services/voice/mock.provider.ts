import { BYTES_PER_MS, durationMs, frames, rms, silence, tone } from "./pcm";
import type { SpeechSynthesis, SpeechToText, SttOptions, SttStream, TextToSpeech, TranscriptEvent } from "./types";

/**
 * Proveedor de voz SIMULADO: todo el flujo de una llamada (audio → texto →
 * motor conversacional → texto → audio) funciona sin credenciales ni costo.
 *
 * STT simulado. Entiende dos clases de audio:
 *  1. "Habla simulada" (tests, demo por consola): tramas PCM que empiezan con
 *     la marca MOCK_SPEECH_MAGIC y llevan una palabra en UTF-8 (ver
 *     encodeMockSpeech). Se transcriben EXACTAMENTE: los tests son deterministas.
 *  2. Audio real de un micrófono (Fase 6, navegador): no se puede entender sin
 *     un modelo, así que se detecta la voz por energía (VAD simple) y, al
 *     terminar cada frase, se "transcribe" la siguiente frase de un guion fijo
 *     (MOCK_SCRIPT). Tiene confianza baja (0.5) para que se note que es simulado.
 * En ambos casos, un silencio de ENDPOINT_MS cierra el segmento (como el
 * "endpointing" de un STT real) y los parciales se emiten mientras se habla.
 *
 * TTS simulado: un tono corto por palabra (duración realista, audible en el
 * navegador), en el mismo PCM16 mono que el TTS real.
 */

export const MOCK_SPEECH_MAGIC = Buffer.from("MOCKSPEECH", "ascii");
const ENDPOINT_MS = 700;
/** Energía por encima de la cual una trama de micrófono cuenta como voz. */
const VOICE_RMS_THRESHOLD = 0.02;
/** Voz real mínima para considerar que hubo una frase (descarta golpes y clics). */
const MIN_SPEECH_MS = 300;
const WORD_MS = 250;

export const MOCK_SCRIPT = [
  "Hola, quisiera saber el horario de atención de las oficinas",
  "¿Cómo bloqueo mi tarjeta si la pierdo?",
  "Tengo un cargo que no reconozco en mi tarjeta de crédito",
];

/**
 * Convierte texto en "habla simulada": una trama de WORD_MS por palabra
 * (marca + largo + palabra, rellena con un tono) y un silencio final que
 * cierra la frase. Lo usan los tests y el script de demo.
 */
export function encodeMockSpeech(text: string, options: { pauseMs?: number; frameMs?: number } = {}): Buffer[] {
  const pauseMs = options.pauseMs ?? 900;
  const frameMs = options.frameMs ?? 100;
  const out: Buffer[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const payload = Buffer.from(word, "utf8");
    const header = Buffer.alloc(MOCK_SPEECH_MAGIC.length + 2);
    MOCK_SPEECH_MAGIC.copy(header);
    header.writeUInt16LE(payload.length, MOCK_SPEECH_MAGIC.length);
    const body = Buffer.concat([header, payload]);
    const padBytes = Math.max(0, WORD_MS * BYTES_PER_MS - body.length);
    // Largo par: cada muestra PCM16 ocupa 2 bytes.
    const frame = Buffer.concat([body, tone(padBytes / BYTES_PER_MS, 220)]);
    out.push(frame.length % 2 === 0 ? frame : Buffer.concat([frame, Buffer.alloc(1)]));
  }
  out.push(...frames(silence(pauseMs), frameMs * BYTES_PER_MS));
  return out;
}

function decodeMockWord(frame: Buffer): string | null {
  if (frame.length < MOCK_SPEECH_MAGIC.length + 2) return null;
  if (!frame.subarray(0, MOCK_SPEECH_MAGIC.length).equals(MOCK_SPEECH_MAGIC)) return null;
  const length = frame.readUInt16LE(MOCK_SPEECH_MAGIC.length);
  const start = MOCK_SPEECH_MAGIC.length + 2;
  if (start + length > frame.length) return null;
  return frame.subarray(start, start + length).toString("utf8");
}

function createMockStream(options: SttOptions, script: string[]): SttStream {
  let clockMs = 0;
  let words: string[] = [];
  let speechMs = 0;
  let silenceMs = 0;
  let segmentStartMs: number | null = null;
  let scriptIndex = 0;
  let closed = false;

  const scripted = () => script[scriptIndex % script.length] ?? "";

  function emit(event: TranscriptEvent) {
    if (!closed) options.onTranscript(event);
  }

  function flush() {
    if (segmentStartMs === null) return;
    const real = words.length === 0;
    if (!real || speechMs >= MIN_SPEECH_MS) {
      const text = real ? scripted() : words.join(" ");
      if (real) scriptIndex += 1;
      emit({
        text,
        isFinal: true,
        startMs: segmentStartMs,
        endMs: clockMs - silenceMs,
        confidence: real ? 0.5 : 0.95,
      });
    }
    words = [];
    speechMs = 0;
    segmentStartMs = null;
  }

  return {
    get audioMs() {
      return clockMs;
    },
    write(pcm: Buffer) {
      if (closed || pcm.length === 0) return;
      const ms = durationMs(pcm.length, options.sampleRate);
      const word = decodeMockWord(pcm);
      if (word !== null || rms(pcm) > VOICE_RMS_THRESHOLD) {
        segmentStartMs ??= clockMs;
        silenceMs = 0;
        if (word !== null) {
          words.push(word);
          emit({
            text: words.join(" "),
            isFinal: false,
            startMs: segmentStartMs,
            endMs: clockMs + ms,
            confidence: null,
          });
        } else {
          speechMs += ms;
          // Parcial del guion, palabra a palabra según cuánto se ha hablado.
          const all = scripted().split(" ");
          const count = Math.min(all.length, Math.max(1, Math.floor(speechMs / 300)));
          emit({
            text: all.slice(0, count).join(" "),
            isFinal: false,
            startMs: segmentStartMs,
            endMs: clockMs + ms,
            confidence: null,
          });
        }
      } else if (segmentStartMs !== null) {
        silenceMs += ms;
        if (silenceMs >= ENDPOINT_MS) {
          clockMs += ms;
          flush();
          return;
        }
      }
      clockMs += ms;
    },
    async finish() {
      flush();
      closed = true;
    },
    close() {
      closed = true;
    },
  };
}

export function createMockVoice(options: { script?: string[] } = {}): { stt: SpeechToText; tts: TextToSpeech } {
  const script = options.script ?? MOCK_SCRIPT;
  return {
    stt: { provider: "mock", model: "mock-stt-v1", open: (sttOptions) => createMockStream(sttOptions, script) },
    tts: {
      provider: "mock",
      model: "mock-tts-v1",
      async synthesize(text: string, { sampleRate }): Promise<SpeechSynthesis> {
        const parts: Buffer[] = [];
        for (const word of text.split(/\s+/).filter(Boolean)) {
          // Tono por palabra entre 180 y 260 Hz (varía con la palabra: suena a "habla").
          const frequency = 180 + ((word.codePointAt(0) ?? 0) % 80);
          parts.push(tone(180, frequency, 0.15, sampleRate), silence(70, sampleRate));
        }
        const audio = Buffer.concat(parts);
        return { audio, sampleRate, durationMs: durationMs(audio.length, sampleRate), characters: text.length };
      },
    },
  };
}
