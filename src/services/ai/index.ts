import { env } from "../../config/env";
import { aiRequestDuration, aiTokens } from "../../observability/metrics";
import { createAnthropicClient, createAnthropicProvider } from "./anthropic.provider";
import { createMockProvider } from "./mock.provider";
import { createVoyageProvider } from "./voyage.provider";
import type { ChatProvider, ClassifierProvider, EmbeddingProvider, Usage } from "./types";

export * from "./types";

/**
 * Punto único de acceso a la IA: el resto del backend pide `getAi()` y no
 * sabe si detrás hay Claude + Voyage o el mock. Cada llamada queda medida
 * (latencia, resultado y tokens) en Prometheus.
 */
export interface AiServices {
  readonly provider: "mock" | "anthropic";
  chat: ChatProvider;
  classifier: ClassifierProvider;
  embedder: EmbeddingProvider;
}

async function measured<T extends { usage: Usage }>(
  provider: string,
  operation: string,
  run: () => Promise<T>
): Promise<T> {
  const end = aiRequestDuration.startTimer({ provider, operation });
  try {
    const result = await run();
    end({ outcome: "ok" });
    aiTokens.inc({ provider, operation, direction: "input" }, result.usage.inputTokens);
    aiTokens.inc({ provider, operation, direction: "output" }, result.usage.outputTokens);
    return result;
  } catch (err) {
    end({ outcome: err instanceof Error ? err.name : "error" });
    throw err;
  }
}

export function instrument(services: AiServices): AiServices {
  const { provider } = services;
  return {
    provider,
    chat: { reply: (context) => measured(provider, "reply", () => services.chat.reply(context)) },
    classifier: { classify: (text) => measured(provider, "classify", () => services.classifier.classify(text)) },
    embedder: {
      model: services.embedder.model,
      embed: (texts, kind) => measured(provider, `embed_${kind}`, () => services.embedder.embed(texts, kind)),
    },
  };
}

function build(): AiServices {
  if (env.ai.provider === "anthropic") {
    // env.ts ya exigió ambas keys con AI_PROVIDER=anthropic.
    const anthropic = createAnthropicProvider({
      client: createAnthropicClient(env.ai.anthropicApiKey!, env.ai.timeoutMs),
      chatModel: env.ai.chatModel,
      classifierModel: env.ai.classifierModel,
      timeoutMs: env.ai.timeoutMs,
    });
    const embedder = createVoyageProvider({
      apiKey: env.ai.voyageApiKey!,
      model: env.ai.embeddingModel,
      timeoutMs: env.ai.timeoutMs,
    });
    return { provider: "anthropic", chat: anthropic.chat, classifier: anthropic.classifier, embedder };
  }
  const mock = createMockProvider({ latencyMs: env.ai.mockLatencyMs });
  return { provider: "mock", chat: mock.chat, classifier: mock.classifier, embedder: mock.embedder };
}

let current: AiServices | null = null;

export function getAi(): AiServices {
  current ??= instrument(build());
  return current;
}

/** Solo tests: reemplaza los proveedores (espías, fallas simuladas). null = volver al configurado. */
export function setAiForTests(services: AiServices | null) {
  current = services ? instrument(services) : null;
}
