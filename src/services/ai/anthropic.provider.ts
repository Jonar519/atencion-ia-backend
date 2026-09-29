import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  AiOutputError,
  AiRefusalError,
  AiUnavailableError,
  type ChatProvider,
  type ClassificationResult,
  type ClassifierProvider,
  type ReplyResult,
  type Usage,
} from "./types";
import {
  buildClassifierUserContent,
  buildReplyUserContent,
  CLASSIFIER_SYSTEM_PROMPT,
  REPLY_SYSTEM_PROMPT,
} from "./prompts";
import { neutralizeTags } from "./untrusted";

/**
 * Claude (Anthropic) para las respuestas y la clasificación de intención.
 * NO PROBADO CONTRA EL PROVEEDOR REAL (no hay API key hasta el cierre del
 * curso); sí probado con un cliente simulado en tests/unit/anthropicProvider.test.ts,
 * que verifica la forma exacta de cada petición y el manejo de cada respuesta.
 *
 * Decisiones (según la guía vigente de la API):
 *  - Modelo por defecto claude-opus-5-5 (ANTHROPIC_MODEL / ANTHROPIC_CLASSIFIER_MODEL).
 *    En este modelo el razonamiento no se puede apagar; la profundidad se
 *    controla con output_config.effort: "low" para clasificar (tarea simple y
 *    muy frecuente) y "medium" para responder.
 *  - Endpoint beta con fallbacks: "default" (server-side-fallback-2026-07-01):
 *    si los clasificadores de seguridad declinan una petición, la API la
 *    reintenta en el modelo que Anthropic recomienda para ese caso. Si igual
 *    termina en stop_reason "refusal", se lanza AiRefusalError y el motor
 *    escala a un humano (nunca se lee `content` sin revisar stop_reason).
 *  - Clasificación con salida estructurada (output_config.format = JSON
 *    schema) y, aun así, validada con zod: la salida del modelo no se confía.
 *  - Prompt de sistema estable con cache_control: es el prefijo que se repite
 *    en cada turno (se cachea si supera el mínimo del modelo, 512 tokens).
 *  - Timeout por petición (AI_TIMEOUT_MS) y 2 reintentos automáticos del SDK
 *    (solo 408/409/429/5xx y errores de conexión).
 */

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const REPLY_MAX_TOKENS = 1_024;
const CLASSIFY_MAX_TOKENS = 256;
const REPLY_MAX_CHARS = 2_000;

/** Lo único del SDK que usa este adaptador: permite inyectar un cliente simulado en tests. */
export interface AnthropicLike {
  beta: { messages: { create: (params: never, options?: { timeout?: number }) => Promise<unknown> } };
}

export interface AnthropicProviderOptions {
  client: AnthropicLike;
  chatModel: string;
  classifierModel: string;
  timeoutMs: number;
}

export function createAnthropicClient(apiKey: string, timeoutMs: number): Anthropic {
  return new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 2 });
}

const classificationSchema = z
  .object({
    intent: z.enum(["general_inquiry", "complaint", "possible_fraud", "account_access", "human_request", "other"]),
    sentiment: z.enum(["positive", "neutral", "negative", "angry"]),
    confidence: z.number().min(0).max(1),
  })
  .strict();

/** El mismo contrato como JSON Schema para output_config.format. */
export const CLASSIFICATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["general_inquiry", "complaint", "possible_fraud", "account_access", "human_request", "other"],
    },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative", "angry"] },
    confidence: { type: "number" },
  },
  required: ["intent", "sentiment", "confidence"],
  additionalProperties: false,
} as const;

type BetaMessage = Anthropic.Beta.BetaMessage;

function usageOf(message: BetaMessage): Usage {
  return {
    inputTokens:
      (message.usage.input_tokens ?? 0) +
      (message.usage.cache_read_input_tokens ?? 0) +
      (message.usage.cache_creation_input_tokens ?? 0),
    outputTokens: message.usage.output_tokens ?? 0,
  };
}

function textOf(message: BetaMessage): string {
  // Primero stop_reason: un "refusal" no trae una respuesta utilizable.
  if (message.stop_reason === "refusal") {
    throw new AiRefusalError(message.stop_details?.category ?? null);
  }
  const text = message.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!text) throw new AiOutputError("El modelo no devolvió texto");
  return text;
}

/** Traduce los errores del SDK (clases tipadas, de la más específica a la general). */
function toAiError(err: unknown): Error {
  if (err instanceof AiRefusalError || err instanceof AiOutputError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AiUnavailableError("Credenciales de Anthropic inválidas o sin permisos", err);
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AiUnavailableError("Anthropic rechazó la petición (400): revisar modelo y parámetros", err);
  }
  if (err instanceof Anthropic.RateLimitError) return new AiUnavailableError("Anthropic: límite de peticiones", err);
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return new AiUnavailableError("Anthropic: tiempo de espera agotado", err);
  if (err instanceof Anthropic.APIError)
    return new AiUnavailableError(`Anthropic: error ${err.status ?? "de red"}`, err);
  return new AiUnavailableError("Error inesperado llamando a Anthropic", err);
}

export function createAnthropicProvider(options: AnthropicProviderOptions) {
  const create = (params: Record<string, unknown>) =>
    options.client.beta.messages.create(params as never, { timeout: options.timeoutMs }) as Promise<BetaMessage>;

  const chat: ChatProvider = {
    async reply(context): Promise<ReplyResult> {
      try {
        const message = await create({
          model: options.chatModel,
          max_tokens: REPLY_MAX_TOKENS,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          output_config: { effort: "medium" },
          system: [{ type: "text", text: REPLY_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: buildReplyUserContent(context) }],
        });
        // La respuesta se muestra al cliente: se recorta y se le quitan nuestras
        // etiquetas por si el modelo las repitiera.
        const text = neutralizeTags(textOf(message)).slice(0, REPLY_MAX_CHARS);
        return { text, usage: usageOf(message), model: message.model };
      } catch (err) {
        throw toAiError(err);
      }
    },
  };

  const classifier: ClassifierProvider = {
    async classify(customerText): Promise<ClassificationResult> {
      try {
        const message = await create({
          model: options.classifierModel,
          max_tokens: CLASSIFY_MAX_TOKENS,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          output_config: { effort: "low", format: { type: "json_schema", schema: CLASSIFICATION_JSON_SCHEMA } },
          system: [{ type: "text", text: CLASSIFIER_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: buildClassifierUserContent(customerText) }],
        });
        let json: unknown;
        try {
          json = JSON.parse(textOf(message));
        } catch (err) {
          if (err instanceof AiRefusalError || err instanceof AiOutputError) throw err;
          throw new AiOutputError("La clasificación no es JSON válido");
        }
        const parsed = classificationSchema.safeParse(json);
        if (!parsed.success) throw new AiOutputError("La clasificación no cumple el esquema");
        return { ...parsed.data, usage: usageOf(message), model: message.model };
      } catch (err) {
        throw toAiError(err);
      }
    },
  };

  return { name: "anthropic" as const, chat, classifier };
}
