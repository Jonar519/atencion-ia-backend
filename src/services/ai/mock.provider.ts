import type { MessageIntent, MessageSentiment } from "@prisma/client";
import {
  EMBEDDING_DIMENSION,
  type ChatProvider,
  type ClassificationResult,
  type ClassifierProvider,
  type EmbeddingKind,
  type EmbeddingProvider,
  type EmbeddingResult,
  type ReplyContext,
  type ReplyResult,
} from "./types";
import { contentWords, estimateTokens, fnv1a, normalize, relevantSentences, stem } from "./text";

/**
 * Proveedor "mock": DETERMINISTA (misma entrada → misma salida), sin red, sin
 * costo y sin credenciales. Es el que usan desarrollo, tests, CI y pruebas de
 * carga (AI_PROVIDER=mock, el valor por defecto).
 *
 * No es un adorno: sus embeddings son un "bag of words" con hashing (palabras
 * + trigramas), así que dos textos que comparten vocabulario quedan cerca y el
 * RAG funciona de verdad con él; su clasificador son reglas por palabras
 * clave; su respuesta se arma SOLO con los fragmentos de la KB recibidos.
 */

export const MOCK_CHAT_MODEL = "mock-chat-v1";
export const MOCK_CLASSIFIER_MODEL = "mock-classifier-v1";
export const MOCK_EMBEDDING_MODEL = "mock-embed-v1";

const sleep = (ms: number) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

// ---------------------------------------------------------------------------
// Embeddings: feature hashing con signo, normalizado (norma 1 → coseno = producto punto)
// ---------------------------------------------------------------------------

export function mockEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  const add = (feature: string, weight: number) => {
    const hash = fnv1a(feature);
    const index = hash % EMBEDDING_DIMENSION;
    // Bit alto como signo: las colisiones se cancelan en promedio en vez de sumar.
    vector[index]! += hash & 0x80000000 ? -weight : weight;
  };
  for (const word of contentWords(text)) {
    add(`w:${stem(word)}`, 1);
    const padded = ` ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) add(`t:${padded.slice(i, i + 3)}`, 0.35);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  // Texto sin palabras de contenido: vector unitario fijo (evita dividir por 0).
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => value / norm);
}

// ---------------------------------------------------------------------------
// Clasificación por reglas
// ---------------------------------------------------------------------------

const INTENT_RULES: { intent: MessageIntent; patterns: RegExp[] }[] = [
  {
    intent: "possible_fraud",
    patterns: [
      /no (lo |la )?(reconozco|hice|realice|autorice)/,
      /(cobro|cargo|compra|transaccion|retiro)s? (que )?(yo )?no/,
      /fraude|estafa|robaron|robo|clonaron|clonada|hackearon|suplantaron|me sacaron/,
      /(me|le) pidieron (la |mi )?(clave|contrasena|codigo)/,
    ],
  },
  {
    intent: "human_request",
    patterns: [/\b(asesor|humano|persona|agente|operador|alguien real)\b/, /hablar con (alguien|una persona)/],
  },
  {
    intent: "account_access",
    patterns: [
      /\b(clave|contrasena|usuario|pin)\b.*\b(bloquead|olvide|no funciona|no me deja)/,
      /no (puedo|me deja) (entrar|ingresar|acceder)/,
      /(bloquearon|bloqueada|bloqueado) (la )?(app|aplicacion|cuenta|clave|usuario)/,
      /codigo (de verificacion )?no (me )?llega/,
    ],
  },
  {
    intent: "complaint",
    patterns: [
      /\b(reclamo|queja|inaceptable|pesimo|pesima|terrible)\b/,
      /no me (entrego|devolvieron|han devuelto|han respondido)/,
      /(cobraron|descontaron) (de mas|dos veces|doble)/,
      /llevo \w+ (dias|semanas)/,
      /ya pasaron \w+ (dias|semanas)/,
    ],
  },
];

const ANGRY =
  /\b(estafadores|ladrones|inaceptable|basura|harto|harta|pesimo|pesima|ridiculo|incompetentes|demanda|denunciar)\b/;
const NEGATIVE = /\b(molesto|molesta|preocupado|preocupada|problema|mal|no puedo|no sirve|urgente|ayuda)\b/;
const POSITIVE = /\b(gracias|perfecto|excelente|genial|listo|muy amable|funciono)\b/;

export function mockClassify(text: string): { intent: MessageIntent; sentiment: MessageSentiment; confidence: number } {
  const normalized = normalize(text);
  const match = INTENT_RULES.find((rule) => rule.patterns.some((pattern) => pattern.test(normalized)));

  const upperWords = text.match(/\b[A-ZÁÉÍÓÚÑ]{3,}\b/g)?.length ?? 0;
  const shouting = /!{2,}/.test(text) || upperWords >= 2;
  const sentiment: MessageSentiment =
    ANGRY.test(normalized) || (shouting && (match || NEGATIVE.test(normalized)))
      ? "angry"
      : NEGATIVE.test(normalized) || match?.intent === "complaint" || match?.intent === "possible_fraud"
        ? "negative"
        : POSITIVE.test(normalized)
          ? "positive"
          : "neutral";

  if (match) return { intent: match.intent, sentiment, confidence: 0.9 };
  const isQuestion =
    /\?|^(como|cual|cuando|donde|que|cuanto|puedo|se puede|hay)\b/.test(normalized) || normalized.length > 25;
  return { intent: isQuestion ? "general_inquiry" : "other", sentiment, confidence: 0.6 };
}

// ---------------------------------------------------------------------------
// Respuesta: solo con lo que trae la KB
// ---------------------------------------------------------------------------

export const MOCK_NO_KB_REPLY =
  "No encontré información sobre eso en nuestra base de conocimiento. ¿Quieres que te comunique con un asesor?";

export function mockReplyText(context: ReplyContext): string {
  const best = context.kbChunks[0];
  if (!best) return MOCK_NO_KB_REPLY;
  return `Según nuestra información (${best.title}): ${relevantSentences(best.content, context.customerMessage, 2)} ¿Te puedo ayudar con algo más?`;
}

export function createMockProvider(options: { latencyMs?: number } = {}) {
  const latency = options.latencyMs ?? 0;

  const chat: ChatProvider = {
    async reply(context): Promise<ReplyResult> {
      await sleep(latency);
      const text = mockReplyText(context);
      const input = [
        context.customerMessage,
        ...context.history.map((t) => t.content),
        ...context.kbChunks.map((c) => c.content),
      ];
      return {
        text,
        model: MOCK_CHAT_MODEL,
        usage: { inputTokens: estimateTokens(input.join("\n")), outputTokens: estimateTokens(text) },
      };
    },
  };

  const classifier: ClassifierProvider = {
    async classify(text): Promise<ClassificationResult> {
      await sleep(latency);
      return {
        ...mockClassify(text),
        model: MOCK_CLASSIFIER_MODEL,
        usage: { inputTokens: estimateTokens(text), outputTokens: 12 },
      };
    },
  };

  const embedder: EmbeddingProvider = {
    model: MOCK_EMBEDDING_MODEL,
    async embed(texts: string[], _kind: EmbeddingKind): Promise<EmbeddingResult> {
      await sleep(latency);
      return {
        vectors: texts.map(mockEmbedding),
        model: MOCK_EMBEDDING_MODEL,
        usage: { inputTokens: texts.reduce((sum, text) => sum + estimateTokens(text), 0), outputTokens: 0 },
      };
    },
  };

  return { name: "mock" as const, chat, classifier, embedder };
}
