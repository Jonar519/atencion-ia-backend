import { describe, expect, it, vi } from "vitest";
import { createVoyageProvider } from "../../src/services/ai/voyage.provider";
import { AiOutputError, AiUnavailableError } from "../../src/services/ai/types";

/** Adaptador de Voyage con fetch SIMULADO (sin API key hasta el cierre del curso). */

const vector = (fill = 0.01, size = 1024) => new Array(size).fill(fill);

function voyageWith(response: { status?: number; body?: unknown } | Error) {
  const fetchFn = vi.fn(async (_url: string, _init: RequestInit) => {
    if (response instanceof Error) throw response;
    return new Response(JSON.stringify(response.body ?? {}), { status: response.status ?? 200 });
  });
  return {
    fetchFn,
    provider: createVoyageProvider({ apiKey: "vk-test", model: "voyage-3.5", timeoutMs: 5_000, fetchFn }),
  };
}

describe("adaptador Voyage", () => {
  it("envía input_type y output_dimension 1024, y ordena por index", async () => {
    const { provider, fetchFn } = voyageWith({
      body: {
        model: "voyage-3.5",
        data: [
          { index: 1, embedding: vector(0.2) },
          { index: 0, embedding: vector(0.1) },
        ],
        usage: { total_tokens: 12 },
      },
    });
    const result = await provider.embed(["uno", "dos"], "query");
    const init = fetchFn.mock.calls[0]![1];
    expect(JSON.parse(init.body as string)).toEqual({
      input: ["uno", "dos"],
      model: "voyage-3.5",
      input_type: "query",
      output_dimension: 1024,
    });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer vk-test");
    expect(result.vectors[0]![0]).toBe(0.1);
    expect(result.usage.inputTokens).toBe(12);
  });

  it("rechaza vectores de otra dimensión ANTES de que lleguen a la base", async () => {
    const { provider } = voyageWith({
      body: { model: "voyage-3.5", data: [{ index: 0, embedding: vector(0.1, 512) }], usage: { total_tokens: 1 } },
    });
    await expect(provider.embed(["x"], "document")).rejects.toBeInstanceOf(AiOutputError);
  });

  it("un error HTTP es AiUnavailableError y no incluye el cuerpo (podría traer el texto enviado)", async () => {
    const { provider } = voyageWith({ status: 500, body: { detail: "texto privado del cliente" } });
    const error = await provider.embed(["x"], "query").catch((e) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect(error.message).not.toContain("privado");
  });

  it("un fallo de red o timeout es AiUnavailableError", async () => {
    const { provider } = voyageWith(new TypeError("fetch failed"));
    await expect(provider.embed(["x"], "query")).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it("parte en lotes de 64 textos", async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const n = JSON.parse(init.body as string).input.length;
      return new Response(
        JSON.stringify({
          model: "voyage-3.5",
          data: Array.from({ length: n }, (_, index) => ({ index, embedding: vector() })),
          usage: { total_tokens: n },
        })
      );
    });
    const provider = createVoyageProvider({ apiKey: "k", model: "voyage-3.5", timeoutMs: 1_000, fetchFn });
    const result = await provider.embed(
      Array.from({ length: 130 }, (_, i) => `t${i}`),
      "document"
    );
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(result.vectors).toHaveLength(130);
  });
});
