import { afterEach, describe, expect, it, vi } from "vitest";
import { processCustomerSegment } from "../../src/modules/voice/voicePipeline";
import { handleCustomerTurn } from "../../src/modules/engine/conversationEngine";
import { callsService } from "../../src/modules/voice/calls.service";
import { setVoiceForTests } from "../../src/services/voice";
import { createMockVoice } from "../../src/services/voice/mock.provider";

/**
 * Defensa propia del camino de voz: aunque el texto que llega al pipeline traiga
 * Markdown (el motor ya lo limpia, pero no se depende de eso), lo que va al
 * sintetizador, a la transcripción y a los eventos de la llamada sale sin asteriscos.
 * Sin base ni IA: el motor y la transcripción están simulados.
 */
vi.mock("../../src/modules/engine/conversationEngine", () => ({ handleCustomerTurn: vi.fn() }));
vi.mock("../../src/modules/voice/calls.service", () => ({
  callsService: { appendSegment: vi.fn(async () => undefined), markWaitingAgent: vi.fn(async () => undefined) },
}));
vi.mock("../../src/modules/voice/voiceBudget", () => ({ recordTtsUsage: vi.fn(async () => undefined) }));

afterEach(() => {
  setVoiceForTests(null);
  vi.clearAllMocks();
});

const ctx = { callId: "call-1", conversationId: "conv-1", customerId: "cust-1", offsetMs: 0 };
const segment = { text: "¿Cuál es el horario?", startMs: 0, endMs: 1000, confidence: 0.9 };

function voiceWith(synthesize: (text: string) => void | Promise<never>) {
  const mock = createMockVoice();
  setVoiceForTests({
    provider: "mock",
    stt: mock.stt,
    tts: {
      ...mock.tts,
      synthesize: async (text, options) => {
        await synthesize(text);
        return mock.tts.synthesize(text, options);
      },
    },
  });
}

function turnReplying(content: string) {
  vi.mocked(handleCustomerTurn).mockResolvedValue({
    customerMessage: { id: "m-cliente" },
    reply: { id: "m-ia", content },
    conversationStatus: "bot",
  } as unknown as Awaited<ReturnType<typeof handleCustomerTurn>>);
}

describe("voicePipeline: el sintetizador nunca recibe marcadores de Markdown", () => {
  it("TTS, transcripción y tts.start con el texto limpio", async () => {
    const spoken: string[] = [];
    voiceWith((text) => void spoken.push(text));
    turnReplying("Atendemos de **lunes a viernes**, *8 a 5*.");
    const events: Record<string, unknown>[] = [];

    await processCustomerSegment(ctx, segment, { json: (m) => events.push(m), audio: () => {} });

    expect(spoken).toEqual(["Atendemos de lunes a viernes, 8 a 5."]);
    const aiSegment = vi.mocked(callsService.appendSegment).mock.calls.find(([s]) => s.speaker === "ai")?.[0];
    expect(aiSegment?.text).toBe("Atendemos de lunes a viernes, 8 a 5.");
    expect(events.find((e) => e.type === "tts.start")?.text).toBe("Atendemos de lunes a viernes, 8 a 5.");
    expect(JSON.stringify(events)).not.toContain("*");
  });

  it("si el TTS falla, tts.unavailable también lleva el texto limpio", async () => {
    voiceWith(() => Promise.reject(new Error("TTS caído")));
    turnReplying("Escribe a **soporte**.");
    const events: Record<string, unknown>[] = [];

    await processCustomerSegment(ctx, segment, { json: (m) => events.push(m), audio: () => {} });

    expect(events.find((e) => e.type === "tts.unavailable")?.text).toBe("Escribe a soporte.");
  });
});
