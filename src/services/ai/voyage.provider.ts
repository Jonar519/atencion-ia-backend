import { z } from "zod";
import {
  AiOutputError,
  AiUnavailableError,
  EMBEDDING_DIMENSION,
  type EmbeddingProvider,
  type EmbeddingResult,
} from "./types";

/**
 * Embeddings con Voyage AI (mismo proveedor que el Proyecto 1).
 * NO PROBADO CONTRA EL PROVEEDOR REAL (sin API key hasta el cierre del curso);
 * probado con un fetch simulado en tests/unit/voyageProvider.test.ts.
 *
 * Diferencias con el Proyecto 1 (que usaba voyage-2 sin más parámetros):
 *  - Modelo configurable (VOYAGE_MODEL, por defecto voyage-3.5).
 *  - input_type "document" al indexar y "query" al buscar: Voyage optimiza
 *    cada lado de la búsqueda por separado, lo que mejora la recuperación.
 *  - output_dimension 1024 explícito y verificado en la respuesta: si el
 *    modelo devolviera otra dimensión, se rechaza antes de tocar la base
 *    (kb_chunks.embedding es vector(1024)).
 */

const ENDPOINT = "https://api.voyageai.com/v1/embeddings";
/** Máximo de textos por petición que enviamos (el límite de la API es mayor). */
const BATCH_SIZE = 64;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const responseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number().int() })),
  model: z.string(),
  usage: z.object({ total_tokens: z.number().int() }),
});

export function createVoyageProvider(options: {
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetchFn?: FetchLike;
}): EmbeddingProvider {
  const fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));

  async function embedBatch(texts: string[], inputType: "document" | "query") {
    let response: Response;
    try {
      response = await fetchFn(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          input: texts,
          model: options.model,
          input_type: inputType,
          output_dimension: EMBEDDING_DIMENSION,
        }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (err) {
      throw new AiUnavailableError("Voyage: sin respuesta (red o tiempo agotado)", err);
    }
    if (!response.ok) {
      // Sin el cuerpo en el mensaje: podría incluir el texto enviado.
      throw new AiUnavailableError(`Voyage respondió ${response.status}`);
    }
    const parsed = responseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new AiOutputError("Voyage devolvió una respuesta con formato inesperado");
    const vectors = [...parsed.data.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
    if (vectors.length !== texts.length) throw new AiOutputError("Voyage devolvió una cantidad distinta de embeddings");
    for (const vector of vectors) {
      if (vector.length !== EMBEDDING_DIMENSION) {
        throw new AiOutputError(`Voyage devolvió ${vector.length} dimensiones; el índice usa ${EMBEDDING_DIMENSION}`);
      }
    }
    return { vectors, tokens: parsed.data.usage.total_tokens };
  }

  return {
    model: options.model,
    async embed(texts, kind): Promise<EmbeddingResult> {
      const vectors: number[][] = [];
      let tokens = 0;
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = await embedBatch(texts.slice(i, i + BATCH_SIZE), kind);
        vectors.push(...batch.vectors);
        tokens += batch.tokens;
      }
      return { vectors, model: options.model, usage: { inputTokens: tokens, outputTokens: 0 } };
    },
  };
}
