import { env } from "../../config/env";
import { getAi, type KbContextChunk, type Usage } from "../../services/ai";
import { ragTopScore } from "../../observability/metrics";
import { searchChunks } from "./rag.repository";

export interface RetrievalResult {
  chunks: KbContextChunk[];
  /** Mejor similitud encontrada (aunque no supere el umbral); 0 si no hubo candidatos. */
  topScore: number;
  usage: Usage;
}

/**
 * Recupera contexto de la base de conocimiento para un texto.
 *
 * AISLAMIENTO POR DISEÑO: la única entrada es el texto a buscar. No recibe
 * cliente ni conversación, y busca solo en kb_chunks, donde la base garantiza
 * que solo hay texto de artículos (migración 013). El historial de la
 * conversación NO pasa por aquí: lo arma el motor con los mensajes de esa
 * misma conversación (engine/history.ts).
 */
export async function retrieveKnowledge(query: string): Promise<RetrievalResult> {
  const { embedder } = getAi();
  const { vectors, usage } = await embedder.embed([query], "query");
  const candidates = await searchChunks(vectors[0]!, embedder.model, env.ai.ragTopK);
  const chunks = candidates.filter((chunk) => chunk.score >= env.ai.ragMinScore);
  const topScore = candidates[0]?.score ?? 0;
  ragTopScore.observe(chunks.length ? topScore : 0);
  return { chunks, topScore, usage };
}
