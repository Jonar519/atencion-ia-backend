/**
 * Contrato de los proveedores de voz. El resto del backend (sesión de llamada,
 * WebSocket de voz) solo conoce estas interfaces: detrás puede estar el mock
 * (desarrollo, tests, CI, carga) o Deepgram, sin cambiar una línea.
 */

export interface TranscriptEvent {
  text: string;
  /** true = segmento terminado (fin de frase): se convierte en un turno de la conversación. */
  isFinal: boolean;
  /** Milisegundos desde que empezó ESTE stream de audio. */
  startMs: number;
  endMs: number;
  confidence: number | null;
}

export interface SttOptions {
  sampleRate: number;
  language: string;
  onTranscript(event: TranscriptEvent): void;
  onError(error: Error): void;
}

export interface SttStream {
  /** Un trozo de audio PCM16 mono. Nunca bloquea: el adaptador encola si hace falta. */
  write(pcm: Buffer): void;
  /** Cierra el segmento en curso (si lo hay, emite su final) y termina el stream. */
  finish(): Promise<void>;
  /** Corta de inmediato, sin esperar resultados pendientes. */
  close(): void;
  /** Milisegundos de audio recibidos (para medir consumo: ai_usage en segundos). */
  readonly audioMs: number;
}

export interface SpeechToText {
  readonly provider: string;
  readonly model: string;
  open(options: SttOptions): SttStream;
}

export interface SpeechSynthesis {
  /** PCM16 mono a `sampleRate`. */
  audio: Buffer;
  sampleRate: number;
  durationMs: number;
  characters: number;
}

export interface TextToSpeech {
  readonly provider: string;
  readonly model: string;
  synthesize(text: string, options: { sampleRate: number }): Promise<SpeechSynthesis>;
}

/** Falla del proveedor de voz. El mensaje nunca incluye la API key ni el audio. */
export class VoiceProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "VoiceProviderError";
  }
}
