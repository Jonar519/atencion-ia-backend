import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { EMBEDDING_DIMENSION } from "../../services/ai";
import { sha256 } from "../../utils/hash";

/**
 * Acceso a kb_chunks con SQL crudo: Prisma no soporta el tipo vector de
 * pgvector. TODAS las consultas van parametrizadas (Prisma.sql); el vector se
 * pasa como texto "[0.1,0.2,…]" y se castea a ::vector en la base.
 */

export interface RetrievedChunk {
  chunkId: string;
  articleId: string;
  articleVersion: number;
  title: string;
  content: string;
  score: number;
}

export function toVectorLiteral(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIMENSION || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`Vector inválido: se esperaban ${EMBEDDING_DIMENSION} números finitos`);
  }
  return `[${vector.join(",")}]`;
}

/**
 * Búsqueda semántica. AISLAMIENTO: la función solo recibe un vector (y el
 * modelo). No recibe ni puede filtrar por cliente o conversación porque en
 * kb_chunks NO hay datos de clientes (lo garantiza la base, migración 013).
 * Solo se devuelven fragmentos de artículos PUBLICADOS y de su versión
 * VIGENTE (un fragmento viejo, de antes de una edición, nunca se usa).
 */
export async function searchChunks(
  queryVector: number[],
  embeddingModel: string,
  limit: number
): Promise<RetrievedChunk[]> {
  const vector = toVectorLiteral(queryVector);
  return prisma.$queryRaw<RetrievedChunk[]>(Prisma.sql`
    SELECT c.id              AS "chunkId",
           c.article_id      AS "articleId",
           c.article_version AS "articleVersion",
           a.title           AS "title",
           c.content         AS "content",
           (1 - (c.embedding <=> ${vector}::vector))::float8 AS "score"
    FROM kb_chunks c
    JOIN kb_articles a ON a.id = c.article_id
    WHERE a.status = 'published'
      AND c.article_version = a.version
      AND c.embedding_model = ${embeddingModel}
    ORDER BY c.embedding <=> ${vector}::vector
    LIMIT ${limit}`);
}

export interface NewChunk {
  chunkIndex: number;
  content: string;
  vector: number[];
}

/**
 * Reemplaza los fragmentos de un artículo para un modelo, en UNA transacción
 * y solo si el artículo sigue en la versión que se indexó: si alguien lo editó
 * mientras se calculaban los embeddings, no se escribe nada (lo hará el
 * trabajo encolado por esa edición). Devuelve false si se descartó.
 */
export async function replaceArticleChunks(
  articleId: string,
  expectedVersion: number,
  embeddingModel: string,
  chunks: NewChunk[]
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ version: number; status: string }[]>`
      SELECT version, status::text AS status FROM kb_articles WHERE id = ${articleId}::uuid FOR UPDATE`;
    if (!row || row.version !== expectedVersion || row.status !== "published") return false;

    await tx.$executeRaw`DELETE FROM kb_chunks WHERE article_id = ${articleId}::uuid AND embedding_model = ${embeddingModel}`;
    for (const chunk of chunks) {
      await tx.$executeRaw`
        INSERT INTO kb_chunks (article_id, article_version, chunk_index, content, content_sha256, embedding, embedding_model)
        VALUES (${articleId}::uuid, ${expectedVersion}, ${chunk.chunkIndex}, ${chunk.content}, ${sha256(chunk.content)},
                ${toVectorLiteral(chunk.vector)}::vector, ${embeddingModel})`;
    }
    return true;
  });
}

export async function deleteArticleChunks(articleId: string): Promise<number> {
  return prisma.$executeRaw`DELETE FROM kb_chunks WHERE article_id = ${articleId}::uuid`;
}
