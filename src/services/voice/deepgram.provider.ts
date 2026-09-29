import { WebSocket } from "ws";
import { durationMs } from "./pcm";
import {
  VoiceProviderError,
  type SpeechSynthesis,
  type SpeechToText,
  type SttOptions,
  type SttStream,
  type TextToSpeech,
} from "./types";

/**
 * Adaptador de Deepgram (recomendado: docs/adr/0011-proveedor-de-voz.md).
 *
 *  - STT: WebSocket de streaming `wss://api.deepgram.com/v1/listen` con
 *    resultados parciales (interim_results) y detección de fin de frase
 *    (endpointing). Deepgram marca como `is_final` trozos que ya no cambian y
 *    como `speech_final` el fin de la frase: se acumulan los `is_final` y el
 *    turno se cierra con `speech_final` (o con el mensaje UtteranceEnd).
 *  - TTS: `POST https://api.deepgram.com/v1/speak` pidiendo PCM16 crudo
 *    (encoding=linear16, container=none) a la frecuencia de la llamada.
 *  - `mip_opt_out=true`: se pide que el audio NO se use para mejorar sus
 *    modelos (docs/privacy-voice.md).
 *
 * El socket y fetch se inyectan: los tests prueban el protocolo con dobles,
 * sin red ni credenciales. NO probado contra el servicio real todavía.
 */

const LISTEN_URL = "wss://api.deepgram.com/v1/listen";
const SPEAK_URL = "https://api.deepgram.com/v1/speak";
/** Deepgram cierra el stream tras ~10 s sin audio: se envía KeepAlive antes. */
const KEEPALIVE_MS = 5_000;
const ENDPOINTING_MS = 300;
/** Límite de caracteres por petición de TTS (margen bajo el máximo documentado). */
const TTS_MAX_CHARS = 1_800;

export interface DeepgramSocket {
  readonly readyState: number;
  send(data: Buffer | string): void;
  close(): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: Buffer) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: (code: number) => void): this;
}

export interface DeepgramOptions {
  apiKey: string;
  sttModel: string;
  ttsModel: string;
  language: string;
  timeoutMs: number;
  createSocket?: (url: string, headers: Record<string, string>) => DeepgramSocket;
  fetchImpl?: typeof fetch;
}

const OPEN = 1;

interface DeepgramResults {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
  channel?: { alternatives?: { transcript?: string; confidence?: number }[] };
}

export function listenUrl(options: Pick<DeepgramOptions, "sttModel" | "language">, sampleRate: number): string {
  const params = new URLSearchParams({
    model: options.sttModel,
    language: options.language,
    encoding: "linear16",
    sample_rate: String(sampleRate),
    channels: "1",
    interim_results: "true",
    endpointing: String(ENDPOINTING_MS),
    utterance_end_ms: "1000",
    smart_format: "true",
    mip_opt_out: "true",
  });
  return `${LISTEN_URL}?${params}`;
}

function createDeepgramStream(options: DeepgramOptions, stt: SttOptions): SttStream {
  const createSocket =
    options.createSocket ?? ((url, headers) => new WebSocket(url, { headers }) as unknown as DeepgramSocket);
  const socket = createSocket(listenUrl(options, stt.sampleRate), { Authorization: `Token ${options.apiKey}` });
  const pending: Buffer[] = [];
  let audioBytes = 0;
  let lastAudioAt = Date.now();
  let closed = false;
  // Trozos is_final de la frase en curso.
  let finalized: string[] = [];
  let segmentStartMs: number | null = null;
  let segmentEndMs = 0;
  let confidences: number[] = [];
  let onClosed: (() => void) | null = null;

  const keepAlive = setInterval(() => {
    if (socket.readyState === OPEN && Date.now() - lastAudioAt >= KEEPALIVE_MS) {
      socket.send(JSON.stringify({ type: "KeepAlive" }));
    }
  }, KEEPALIVE_MS);
  keepAlive.unref?.();

  function emitFinal() {
    const text = finalized.join(" ").trim();
    if (text && segmentStartMs !== null && !closed) {
      const confidence = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null;
      stt.onTranscript({ text, isFinal: true, startMs: segmentStartMs, endMs: segmentEndMs, confidence });
    }
    finalized = [];
    confidences = [];
    segmentStartMs = null;
  }

  socket.on("open", () => {
    for (const chunk of pending.splice(0)) socket.send(chunk);
  });
  socket.on("message", (raw) => {
    let message: DeepgramResults;
    try {
      message = JSON.parse(raw.toString()) as DeepgramResults;
    } catch {
      return;
    }
    if (message.type === "UtteranceEnd") {
      emitFinal();
      return;
    }
    if (message.type !== "Results") return;
    const alternative = message.channel?.alternatives?.[0];
    const text = (alternative?.transcript ?? "").trim();
    const startMs = Math.round((message.start ?? 0) * 1000);
    const endMs = Math.round(((message.start ?? 0) + (message.duration ?? 0)) * 1000);
    if (text) {
      segmentStartMs ??= startMs;
      segmentEndMs = endMs;
      if (message.is_final) {
        finalized.push(text);
        if (typeof alternative?.confidence === "number") confidences.push(alternative.confidence);
      } else if (!closed) {
        stt.onTranscript({
          text: [...finalized, text].join(" "),
          isFinal: false,
          startMs: segmentStartMs,
          endMs,
          confidence: null,
        });
      }
    }
    if (message.speech_final) emitFinal();
  });
  socket.on("error", (err) => {
    if (!closed) stt.onError(new VoiceProviderError(`STT de Deepgram: ${err.message}`));
  });
  socket.on("close", () => {
    clearInterval(keepAlive);
    onClosed?.();
  });

  return {
    get audioMs() {
      return durationMs(audioBytes, stt.sampleRate);
    },
    write(pcm: Buffer) {
      if (closed) return;
      audioBytes += pcm.length;
      lastAudioAt = Date.now();
      if (socket.readyState === OPEN) socket.send(pcm);
      else pending.push(pcm);
    },
    async finish() {
      if (closed) return;
      // CloseStream: Deepgram procesa lo que tiene, envía los últimos resultados y cierra.
      const done = new Promise<void>((resolve) => {
        onClosed = resolve;
        setTimeout(resolve, options.timeoutMs).unref?.();
      });
      if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: "CloseStream" }));
      else socket.close();
      await done;
      emitFinal();
      closed = true;
      clearInterval(keepAlive);
    },
    close() {
      closed = true;
      clearInterval(keepAlive);
      socket.close();
    },
  };
}

/** Corta el texto en trozos ≤ TTS_MAX_CHARS por oraciones (una respuesta larga no falla). */
export function splitForTts(text: string, max = TTS_MAX_CHARS): string[] {
  const sentences = text.match(/[^.!?¿¡]+[.!?]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if ((current + sentence).length > max && current) {
      chunks.push(current.trim());
      current = "";
    }
    // Una "oración" más larga que el máximo se corta a la fuerza.
    let rest = sentence;
    while (rest.length > max) {
      chunks.push(rest.slice(0, max).trim());
      rest = rest.slice(max);
    }
    current += rest;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function createDeepgramVoice(options: DeepgramOptions): { stt: SpeechToText; tts: TextToSpeech } {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    stt: {
      provider: "deepgram",
      model: options.sttModel,
      open: (stt) => createDeepgramStream(options, stt),
    },
    tts: {
      provider: "deepgram",
      model: options.ttsModel,
      async synthesize(text: string, { sampleRate }): Promise<SpeechSynthesis> {
        const params = new URLSearchParams({
          model: options.ttsModel,
          encoding: "linear16",
          sample_rate: String(sampleRate),
          container: "none",
          mip_opt_out: "true",
        });
        const parts: Buffer[] = [];
        for (const chunk of splitForTts(text)) {
          let response: Response;
          try {
            response = await fetchImpl(`${SPEAK_URL}?${params}`, {
              method: "POST",
              headers: { Authorization: `Token ${options.apiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ text: chunk }),
              signal: AbortSignal.timeout(options.timeoutMs),
            });
          } catch (err) {
            throw new VoiceProviderError(`TTS de Deepgram no disponible: ${err instanceof Error ? err.name : "error"}`);
          }
          if (!response.ok) {
            throw new VoiceProviderError(`TTS de Deepgram respondió ${response.status}`, response.status);
          }
          parts.push(Buffer.from(await response.arrayBuffer()));
        }
        const audio = Buffer.concat(parts);
        return { audio, sampleRate, durationMs: durationMs(audio.length, sampleRate), characters: text.length };
      },
    },
  };
}
