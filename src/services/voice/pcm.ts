/**
 * Audio del canal de voz: PCM lineal de 16 bits, little-endian, mono, 16 kHz
 * ("linear16"). Es lo que el navegador envía (AudioWorklet) y lo que aceptan
 * los proveedores de STT sin recodificar; el TTS se pide en el mismo formato.
 */
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;
export const BYTES_PER_MS = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000; // 32

export function durationMs(bytes: number, sampleRate = SAMPLE_RATE): number {
  return Math.round(bytes / ((sampleRate * BYTES_PER_SAMPLE) / 1000));
}

/** Energía RMS normalizada (0 = silencio, 1 = máxima amplitud). */
export function rms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const value = pcm.readInt16LE(i * BYTES_PER_SAMPLE) / 32_768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

export function silence(ms: number, sampleRate = SAMPLE_RATE): Buffer {
  return Buffer.alloc(Math.round((ms * sampleRate) / 1000) * BYTES_PER_SAMPLE);
}

/** Tono senoidal: la "voz" del TTS simulado y el relleno del habla simulada. */
export function tone(ms: number, frequency: number, amplitude = 0.2, sampleRate = SAMPLE_RATE): Buffer {
  const samples = Math.round((ms * sampleRate) / 1000);
  const buffer = Buffer.alloc(samples * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples; i += 1) {
    // Rampa de 5 ms al inicio y al final: sin "clics" al reproducir.
    const edge = Math.min(1, i / (sampleRate * 0.005), (samples - i) / (sampleRate * 0.005));
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude * edge;
    buffer.writeInt16LE(Math.round(value * 32_767), i * BYTES_PER_SAMPLE);
  }
  return buffer;
}

/** Corta un buffer en trozos de `frameBytes` (el último puede ser más corto). */
export function frames(buffer: Buffer, frameBytes: number): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += frameBytes) {
    out.push(buffer.subarray(offset, Math.min(offset + frameBytes, buffer.length)));
  }
  return out;
}
