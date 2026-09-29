import { prisma } from "../config/prisma";
import { redisConnection } from "../config/redis";
import { logger } from "../config/logger";
import { indexArticle } from "../modules/rag/indexing.service";

/**
 * `npm run kb:reindex`: (re)indexa TODA la base de conocimiento, en este mismo
 * proceso (no necesita el worker). Úsalo:
 *  - después de cargar el seed (los artículos del seed vienen sin embeddings);
 *  - al cambiar de proveedor de embeddings (mock → Voyage), porque los vectores
 *    de un modelo no sirven para otro;
 *  - si Redis estuvo caído y se perdieron trabajos de indexación.
 * Es idempotente: se puede correr cuantas veces se quiera.
 */
async function main() {
  const articles = await prisma.kbArticle.findMany({ select: { id: true, slug: true }, orderBy: { slug: "asc" } });
  const totals = { indexed: 0, removed: 0, stale: 0, chunks: 0 };
  for (const article of articles) {
    const outcome = await indexArticle(article.id);
    if (outcome.status === "indexed") {
      totals.indexed += 1;
      totals.chunks += outcome.chunks;
    } else if (outcome.status === "removed") totals.removed += 1;
    else totals.stale += 1;
    logger.info({ slug: article.slug, ...outcome }, "kb:reindex");
  }
  logger.info(totals, `kb:reindex terminado: ${articles.length} artículos revisados`);
}

main()
  .catch((err) => {
    logger.fatal({ err: err instanceof Error ? err.message : String(err) }, "kb:reindex falló");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    redisConnection.disconnect();
  });
