import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { createMockVoice, encodeMockSpeech, MOCK_SCRIPT } from "../../src/services/voice/mock.provider";
import {
  createDeepgramVoice,
  listenUrl,
  splitForTts,
  type DeepgramSocket,
} from "../../src/services/voice/deepgram.provider";
import { durationMs, rms, silence, tone, BYTES_PER_MS } from "../../src/services/voice/pcm";
import type { TranscriptEvent } from "../../src/services/voice/types";
import { signalSchema, voiceClientMessageSchema } from "../../src/modules/voice/voice.schema";

function collect() {
  const events: TranscriptEvent[] = [];
  return { events, finals: () => events.filter((e) => e.isFinal).map((e) => e.text) };
}

describe("PCM", () => {
  it("mide duración y energía", () => {
    expect(durationMs(3_200)).toBe(100);
    expect(rms(silence(100))).toBe(0);
    expect(rms(tone(100, 440, 0.5))).toBeGreaterThan(0.3);
  });
});

describe("STT simulado", () => {
  it("transcribe EXACTAMENTE el habla simulada y cierra la frase con el silencio", async () => {
    const { events, finals } = collect();
    const stream = createMockVoice().stt.open({
      sampleRate: 16_000,
      language: "es",
      onTranscript: (e) => events.push(e),
      onError: () => undefined,
    });
    for (const frame of encodeMockSpeech("Hola, ¿cuál es el horario?")) stream.write(frame);
    for (const frame of encodeMockSpeech("Gracias")) stream.write(frame);
    await stream.finish();
    expect(finals()).toEqual(["Hola, ¿cuál es el horario?", "Gracias"]);
    // Parciales mientras se habla (palabra a palabra).
    expect(events.filter((e) => !e.isFinal).map((e) => e.text)).toContain("Hola, ¿cuál");
    const [first] = events.filter((e) => e.isFinal);
    expect(first!.endMs).toBeGreaterThan(first!.startMs);
    expect(stream.audioMs).toBeGreaterThan(2_000);
  });

  it("sin silencio final, finish() cierra la frase pendiente", async () => {
    const { finals, events } = collect();
    const stream = createMockVoice().stt.open({
      sampleRate: 16_000,
      language: "es",
      onTranscript: (e) => events.push(e),
      onError: () => undefined,
    });
    for (const frame of encodeMockSpeech("quiero un asesor", { pauseMs: 0 })) stream.write(frame);
    expect(finals()).toEqual([]);
    await stream.finish();
    expect(finals()).toEqual(["quiero un asesor"]);
  });

  it("audio de micrófono real: detecta voz por energía y usa el guion (confianza baja)", async () => {
    const { events, finals } = collect();
    const stream = createMockVoice({ script: ["frase uno", "frase dos"] }).stt.open({
      sampleRate: 16_000,
      language: "es",
      onTranscript: (e) => events.push(e),
      onError: () => undefined,
    });
    const speak = () => {
      for (let i = 0; i < 8; i += 1) stream.write(tone(100, 300, 0.3));
      for (let i = 0; i < 9; i += 1) stream.write(silence(100));
    };
    speak();
    speak();
    // Un golpe corto (100 ms) no es una frase.
    stream.write(tone(100, 300, 0.3));
    for (let i = 0; i < 9; i += 1) stream.write(silence(100));
    await stream.finish();
    expect(finals()).toEqual(["frase uno", "frase dos"]);
    expect(events.find((e) => e.isFinal)!.confidence).toBe(0.5);
  });

  it("el silencio puro no produce transcripciones", async () => {
    const { events } = collect();
    const stream = createMockVoice().stt.open({
      sampleRate: 16_000,
      language: "es",
      onTranscript: (e) => events.push(e),
      onError: () => undefined,
    });
    for (let i = 0; i < 50; i += 1) stream.write(silence(100));
    await stream.finish();
    expect(events).toEqual([]);
  });

  it("el guion por defecto existe y la tercera frase es un caso de fraude (demo de escalamiento)", () => {
    expect(MOCK_SCRIPT[2]).toMatch(/no reconozco/);
  });
});

describe("TTS simulado", () => {
  it("devuelve PCM16 con duración proporcional al texto", async () => {
    const { tts } = createMockVoice();
    const short = await tts.synthesize("Hola", { sampleRate: 16_000 });
    const long = await tts.synthesize("Hola, tu saldo está disponible en la app", { sampleRate: 16_000 });
    expect(short.audio.length % 2).toBe(0);
    expect(long.durationMs).toBeGreaterThan(short.durationMs * 4);
    expect(long.characters).toBe("Hola, tu saldo está disponible en la app".length);
    expect(rms(long.audio)).toBeGreaterThan(0);
  });
});

/** Doble del WebSocket de Deepgram: registra lo enviado y deja inyectar respuestas. */
class FakeDeepgramSocket extends EventEmitter {
  readyState = 0;
  sent: (Buffer | string)[] = [];
  closed = false;
  send(data: Buffer | string) {
    this.sent.push(data);
    const text = typeof data === "string" ? data : "";
    if (text.includes("CloseStream")) setImmediate(() => this.emit("close", 1000));
  }
  close() {
    this.closed = true;
    this.emit("close", 1000);
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  result(payload: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify({ type: "Results", ...payload })));
  }
}

const alt = (transcript: string, confidence = 0.9) => ({ channel: { alternatives: [{ transcript, confidence }] } });

describe("adaptador de Deepgram (con dobles, sin red)", () => {
  function setup() {
    const socket = new FakeDeepgramSocket();
    const created: { url: string; headers: Record<string, string> }[] = [];
    const voice = createDeepgramVoice({
      apiKey: "dg-test-key",
      sttModel: "nova-3",
      ttsModel: "aura-2-celeste-es",
      language: "es",
      timeoutMs: 1_000,
      createSocket: (url, headers) => {
        created.push({ url, headers });
        return socket as unknown as DeepgramSocket;
      },
    });
    const { events, finals } = collect();
    const stream = voice.stt.open({
      sampleRate: 16_000,
      language: "es",
      onTranscript: (e) => events.push(e),
      onError: vi.fn(),
    });
    return { socket, created, stream, events, finals };
  }

  it("se conecta con el modelo, idioma, PCM16 y opt-out de mejora de modelos; la key va en el header, no en la URL", () => {
    const { created } = setup();
    const url = new URL(created[0]!.url);
    expect(url.origin + url.pathname).toBe("wss://api.deepgram.com/v1/listen");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model: "nova-3",
      language: "es",
      encoding: "linear16",
      sample_rate: "16000",
      interim_results: "true",
      mip_opt_out: "true",
    });
    expect(created[0]!.url).not.toContain("dg-test-key");
    expect(created[0]!.headers.Authorization).toBe("Token dg-test-key");
  });

  it("encola el audio hasta que el socket abre y luego lo envía en orden", () => {
    const { socket, stream } = setup();
    stream.write(Buffer.from([1, 2]));
    stream.write(Buffer.from([3, 4]));
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent).toEqual([Buffer.from([1, 2]), Buffer.from([3, 4])]);
    stream.write(Buffer.from([5, 6]));
    expect(socket.sent).toHaveLength(3);
    expect(stream.audioMs).toBe(0); // 6 bytes ≈ 0 ms
  });

  it("acumula los trozos is_final y cierra el turno con speech_final (un turno = una frase)", () => {
    const { socket, events, finals } = setup();
    socket.open();
    socket.result({ ...alt("no reconozco"), is_final: false, start: 0.1, duration: 0.8 });
    socket.result({ ...alt("no reconozco un cargo", 0.8), is_final: true, start: 0.1, duration: 1.2 });
    socket.result({ ...alt("de mi"), is_final: false, start: 1.3, duration: 0.4 });
    expect(finals()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ isFinal: false, text: "no reconozco un cargo de mi" });
    socket.result({ ...alt("de mi tarjeta", 1), is_final: true, speech_final: true, start: 1.3, duration: 0.9 });
    expect(finals()).toEqual(["no reconozco un cargo de mi tarjeta"]);
    expect(events.at(-1)).toMatchObject({ startMs: 100, endMs: 2200, confidence: 0.9 });
  });

  it("UtteranceEnd también cierra la frase; resultados vacíos se ignoran", () => {
    const { socket, finals } = setup();
    socket.open();
    socket.result({ ...alt(""), is_final: true, speech_final: true });
    socket.result({ ...alt("hola"), is_final: true, start: 0, duration: 0.5 });
    socket.emit("message", Buffer.from(JSON.stringify({ type: "UtteranceEnd" })));
    expect(finals()).toEqual(["hola"]);
  });

  it("finish() envía CloseStream, espera el cierre y entrega la frase pendiente", async () => {
    const { socket, stream, finals } = setup();
    socket.open();
    socket.result({ ...alt("quiero un asesor"), is_final: true, start: 0, duration: 1 });
    await stream.finish();
    expect(socket.sent.some((m) => typeof m === "string" && JSON.parse(m).type === "CloseStream")).toBe(true);
    expect(finals()).toEqual(["quiero un asesor"]);
  });

  it("TTS: pide PCM16 crudo con la voz configurada, key en el header, y corta textos largos", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(new Uint8Array(3_200), { status: 200 });
    }) as unknown as typeof fetch;
    const voice = createDeepgramVoice({
      apiKey: "dg-test-key",
      sttModel: "nova-3",
      ttsModel: "aura-2-celeste-es",
      language: "es",
      timeoutMs: 1_000,
      fetchImpl,
    });
    const text = `${"Oración de prueba. ".repeat(150)}`;
    const speech = await voice.tts.synthesize(text, { sampleRate: 16_000 });
    expect(calls.length).toBeGreaterThan(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/speak");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model: "aura-2-celeste-es",
      encoding: "linear16",
      container: "none",
      sample_rate: "16000",
    });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Token dg-test-key");
    expect(speech.durationMs).toBe(100 * calls.length);
    for (const call of calls) expect(JSON.parse(call.init.body as string).text.length).toBeLessThanOrEqual(1_800);
  });

  it("TTS: un error del proveedor no filtra la key", async () => {
    const fetchImpl = vi.fn(async () => new Response("no autorizado", { status: 401 })) as unknown as typeof fetch;
    const voice = createDeepgramVoice({
      apiKey: "dg-secreta",
      sttModel: "nova-3",
      ttsModel: "x",
      language: "es",
      timeoutMs: 1_000,
      fetchImpl,
    });
    const error = await voice.tts.synthesize("hola", { sampleRate: 16_000 }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toContain("dg-secreta");
  });

  it("splitForTts respeta el máximo y no pierde texto", () => {
    const text = "Primera. Segunda oración más larga. " + "x".repeat(50);
    const chunks = splitForTts(text, 20);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(20);
    expect(chunks.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
    expect(listenUrl({ sttModel: "nova-3", language: "es" }, 16_000)).toContain("endpointing=300");
    expect(BYTES_PER_MS).toBe(32);
  });
});

describe("validación de la señalización WebRTC", () => {
  it("acepta oferta, respuesta y candidatos bien formados", () => {
    expect(signalSchema.safeParse({ type: "offer", sdp: "v=0\r\n..." }).success).toBe(true);
    expect(signalSchema.safeParse({ type: "answer", sdp: "v=0" }).success).toBe(true);
    expect(
      signalSchema.safeParse({
        type: "candidate",
        candidate: { candidate: "candidate:1 1 udp ...", sdpMid: "0", sdpMLineIndex: 0 },
      }).success
    ).toBe(true);
  });

  it("rechaza tipos desconocidos, campos extra y SDP gigantes", () => {
    expect(signalSchema.safeParse({ type: "rollback", sdp: "x" }).success).toBe(false);
    expect(signalSchema.safeParse({ type: "offer", sdp: "x", to: "otro-cliente" }).success).toBe(false);
    expect(signalSchema.safeParse({ type: "offer", sdp: "x".repeat(16_001) }).success).toBe(false);
    expect(signalSchema.safeParse({ type: "candidate", candidate: { candidate: "x", callId: "otra" } }).success).toBe(
      false
    );
  });

  it("un cliente no puede elegir destinatario ni llamada en un mensaje de señal", () => {
    expect(
      voiceClientMessageSchema.safeParse({ type: "signal", signal: { type: "answer", sdp: "x" }, callId: "otra" })
        .success
    ).toBe(false);
    expect(voiceClientMessageSchema.safeParse({ type: "auth", callId: "no-es-uuid" }).success).toBe(false);
  });
});
