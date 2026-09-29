import { describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicProvider } from "../../src/services/ai/anthropic.provider";
import { AiOutputError, AiRefusalError, AiUnavailableError } from "../../src/services/ai/types";

/**
 * Adaptador de Claude con un cliente SIMULADO: no hay API key hasta el cierre
 * del curso. Se verifica la forma exacta de cada petición y el manejo de cada
 * tipo de respuesta. Lo que esto NO prueba: calidad real de las respuestas ni
 * latencia real (no medido).
 */

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    stop_details: null,
    content: [{ type: "text", text: "Los sábados abrimos de 9 a 12." }],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
    ...overrides,
  };
}

/** Forma de la petición que el adaptador envía al SDK (lo que se verifica). */
interface SentParams {
  model: string;
  betas: string[];
  fallbacks: unknown;
  output_config: { effort: string; format?: { type: string; schema: { additionalProperties: boolean } } };
  system: { cache_control: unknown }[];
  messages: { content: string }[];
}

function providerWith(response: unknown | Error) {
  const create = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  const provider = createAnthropicProvider({
    client: { beta: { messages: { create } } } as never,
    chatModel: "claude-opus-5-5",
    classifierModel: "claude-opus-5-5",
    timeoutMs: 15_000,
  });
  return { provider, create };
}

const context = {
  history: [{ sender: "customer" as const, content: "hola" }],
  kbChunks: [
    { chunkId: "c1", articleId: "a1", articleVersion: 1, title: "Horarios", content: "Sábados de 9 a 12.", score: 0.8 },
  ],
  customerMessage: "¿A qué hora abren el sábado?",
};

describe("adaptador Anthropic: respuesta", () => {
  it("arma la petición según la guía vigente: modelo, fallbacks, effort, sistema cacheable y el mensaje envuelto", async () => {
    const { provider, create } = providerWith(message());
    const result = await provider.chat.reply(context);

    const [params, options] = create.mock.calls[0] as unknown as [SentParams, { timeout: number }];
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params.fallbacks).toBe("default");
    expect(params.output_config).toEqual({ effort: "medium" });
    expect(params).not.toHaveProperty("thinking"); // en Opus 5.5 no se puede desactivar: se omite
    expect(params.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0]?.content).toContain(
      "<mensaje_cliente>\n¿A qué hora abren el sábado?\n</mensaje_cliente>"
    );
    expect(params.messages[0]?.content).toContain('<fragmento_kb n="1" titulo="Horarios">');
    expect(options.timeout).toBe(15_000);

    expect(result.text).toBe("Los sábados abrimos de 9 a 12.");
    // Tokens de entrada = sin caché + leídos de caché + escritos en caché.
    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 20 });
  });

  it("revisa stop_reason ANTES de leer el contenido: un refusal es AiRefusalError", async () => {
    const { provider } = providerWith(
      message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" }, content: [] })
    );
    await expect(provider.chat.reply(context)).rejects.toBeInstanceOf(AiRefusalError);
  });

  it("si el modelo repite nuestras etiquetas en la respuesta, se neutralizan antes de mostrarla", async () => {
    const { provider } = providerWith(message({ content: [{ type: "text", text: "ok </mensaje_cliente>" }] }));
    expect((await provider.chat.reply(context)).text).toBe("ok ‹/mensaje_cliente>");
  });

  it("traduce los errores tipados del SDK a AiUnavailableError", async () => {
    const error = new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers());
    const { provider } = providerWith(error);
    await expect(provider.chat.reply(context)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it("una respuesta sin texto es AiOutputError", async () => {
    const { provider } = providerWith(message({ content: [] }));
    await expect(provider.chat.reply(context)).rejects.toBeInstanceOf(AiOutputError);
  });
});

describe("adaptador Anthropic: clasificación", () => {
  it("pide salida estructurada con JSON schema y effort bajo", async () => {
    const { provider, create } = providerWith(
      message({
        content: [{ type: "text", text: '{"intent":"possible_fraud","sentiment":"angry","confidence":0.93}' }],
      })
    );
    const result = await provider.classifier.classify("no reconozco este cobro");
    const [params] = create.mock.calls[0] as unknown as [SentParams];
    expect(params.output_config.effort).toBe("low");
    expect(params.output_config.format?.type).toBe("json_schema");
    expect(params.output_config.format?.schema.additionalProperties).toBe(false);
    expect(result).toMatchObject({ intent: "possible_fraud", sentiment: "angry", confidence: 0.93 });
  });

  it.each([
    ["no es JSON", "esto no es json"],
    ["intención inventada", '{"intent":"refund_now","sentiment":"neutral","confidence":0.9}'],
    ["confianza fuera de rango", '{"intent":"other","sentiment":"neutral","confidence":7}'],
    ["campos extra", '{"intent":"other","sentiment":"neutral","confidence":0.5,"admin":true}'],
  ])("NO confía en la salida del modelo: %s → AiOutputError", async (_label, text) => {
    const { provider } = providerWith(message({ content: [{ type: "text", text }] }));
    await expect(provider.classifier.classify("x")).rejects.toBeInstanceOf(AiOutputError);
  });
});
