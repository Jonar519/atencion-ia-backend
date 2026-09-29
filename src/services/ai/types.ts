import type { MessageIntent, MessageSentiment, SenderType } from "@prisma/client";

/**
 * Contratos del proveedor de IA. El motor conversacional solo conoce estas
 * interfaces: cambiar de "mock" a "anthropic" (AI_PROVIDER) no toca el motor.
 *
 * Se separan en tres capacidades porque en producción vienen de proveedores
 * distintos (Claude para texto, Voyage para embeddings) y porque así cada una
 * se puede probar y medir por separado.
 */

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Clasificación por turno
// ---------------------------------------------------------------------------

export interface Classification {
  intent: MessageIntent;
  sentiment: MessageSentiment;
  /** 0-1: qué tan seguro está el clasificador. */
  confidence: number;
}

export interface ClassificationResult extends Classification {
  usage: Usage;
  model: string;
}

export interface ClassifierProvider {
  classify(customerText: string): Promise<ClassificationResult>;
}

// ---------------------------------------------------------------------------
// Respuesta con RAG
// ---------------------------------------------------------------------------

/** Un turno previo de LA MISMA conversación (el motor nunca mezcla conversaciones). */
export interface HistoryTurn {
  sender: SenderType;
  content: string;
}

/** Fragmento recuperado de la base de conocimiento (única fuente de contexto externo). */
export interface KbContextChunk {
  chunkId: string;
  articleId: string;
  articleVersion: number;
  title: string;
  content: string;
  score: number;
}

/**
 * Todo lo que el modelo recibe para responder un turno. Deliberadamente NO
 * incluye ids de cliente ni de conversación: el proveedor no tiene cómo
 * buscar nada más allá de lo que el motor le pasa.
 */
export interface ReplyContext {
  history: HistoryTurn[];
  kbChunks: KbContextChunk[];
  customerMessage: string;
}

export interface ReplyResult {
  text: string;
  usage: Usage;
  model: string;
}

export interface ChatProvider {
  reply(context: ReplyContext): Promise<ReplyResult>;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

/** "document" al indexar la KB; "query" al buscar (los modelos de embeddings los tratan distinto). */
export type EmbeddingKind = "document" | "query";

export interface EmbeddingResult {
  vectors: number[][];
  usage: Usage;
  model: string;
}

export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[], kind: EmbeddingKind): Promise<EmbeddingResult>;
}

/** Dimensión fija del índice (kb_chunks.embedding es vector(1024)). */
export const EMBEDDING_DIMENSION = 1024;

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/** El proveedor no respondió a tiempo, se cayó o devolvió un error. */
export class AiUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "AiUnavailableError";
  }
}

/** El modelo se negó a responder (stop_reason "refusal"). */
export class AiRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`El modelo declinó responder${category ? ` (${category})` : ""}`);
    this.name = "AiRefusalError";
  }
}

/** El modelo respondió algo que no cumple el formato esperado (nunca se confía en su salida). */
export class AiOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiOutputError";
  }
}
