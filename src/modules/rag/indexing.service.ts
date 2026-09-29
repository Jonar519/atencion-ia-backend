import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { getAi } from "../../services/ai";
import { chunkArticleBody, embeddingInput } from "./chunking";
import { deleteArticleChunks, replaceArticleChunks } from "./rag.repository";

export type IndexOutcome =
  | { status: "indexed"; chunks: number; version: number }
  | { status: "removed"; reason: "not_found" | "not_published" }
  | { status: "stale" };

/**
 * Indexa (o des-indexa) un artículo. Lo ejecuta el worker de la cola
 * "kb-indexing" y el script `npm run kb:reindex`. Idempotente: se puede
 * correr las veces que sea; el resultado depende solo del estado actual del
 * artículo, no de cuántas veces se encoló.
 *
 *  - No existe o no está publicado → se borran sus fragmentos (un borrador o
 *    un artículo archivado nunca debe aparecer en el RAG).
 *  - Publicado → fragmentos nuevos de la versión actual (reemplazan a los viejos).
 *  - Si se editó mientras se calculaban los embeddings → "stale", no se escribe.
 */
export async function indexArticle(articleId: string): Promise<IndexOutcome> {
  const article = await prisma.kbArticle.findUnique({
    where: { id: articleId },
    select: { id: true, title: true, body: true, status: true, version: true },
  });
  if (!article || article.status !== "published") {
    await deleteArticleChunks(articleId);
    return { status: "removed", reason: article ? "not_published" : "not_found" };
  }

  const pieces = chunkArticleBody(article.body);
  const { embedder } = getAi();
  const { vectors } = await embedder.embed(
    pieces.map((piece) => embeddingInput(article.title, piece)),
    "document"
  );
  const written = await replaceArticleChunks(
    article.id,
    article.version,
    embedder.model,
    pieces.map((content, chunkIndex) => ({ chunkIndex, content, vector: vectors[chunkIndex]! }))
  );
  if (!written) {
    logger.info({ articleId }, "Indexación descartada: el artículo cambió durante el proceso");
    return { status: "stale" };
  }
  return { status: "indexed", chunks: pieces.length, version: article.version };
}
