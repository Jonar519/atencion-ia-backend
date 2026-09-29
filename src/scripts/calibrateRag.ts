import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { redisConnection } from "../config/redis";
import { getAi } from "../services/ai";
import { searchChunks } from "../modules/rag/rag.repository";

/**
 * `npm run rag:calibrate`: mide la calidad del RAG sobre la KB del seed y
 * ayuda a elegir RAG_MIN_SCORE para el proveedor configurado.
 *
 * Requiere la KB indexada con ESE proveedor (`npm run kb:reindex`). Para cada
 * pregunta muestra el mejor fragmento y su similitud; al final, el acierto
 * (¿el mejor fragmento es del artículo correcto?) y cuántas preguntas quedan
 * bien clasificadas con el umbral actual (relevantes por encima, ajenas por debajo).
 *
 * Cuándo correrlo: al pasar a AI_PROVIDER=anthropic (Voyage) en el cierre del
 * curso, porque el umbral por defecto para Voyage (0.45) NO está calibrado
 * todavía (sin API key no se pudo medir). Resultados con el mock: docs/rag.md.
 */

/** [pregunta, slug esperado o null si la KB no la cubre] */
const CASES: [string, string | null][] = [
  ["¿A qué hora abren las oficinas el sábado?", "horarios-oficinas"],
  ["Me robaron la tarjeta, ¿cómo la bloqueo?", "bloquear-tarjeta"],
  ["Hay un cobro en mi tarjeta que yo no hice", "cargo-no-reconocido"],
  ["El cajero no me dio la plata pero me la descontó", "cajero-no-entrego-dinero"],
  ["¿Cuánto puedo transferir al día?", "limites-transferencias"],
  ["Olvidé la clave de la aplicación", "recuperar-clave-app"],
  ["¿Cómo descargo mi extracto?", "descargar-extractos"],
  ["Me voy de viaje a Chile, ¿sirve mi tarjeta allá?", "compras-internacionales"],
  ["Quiero poner una queja formal", "presentar-reclamo"],
  ["¿Cuál es la capital de Francia?", null],
  ["Me gusta el fútbol y la pizza", null],
  ["Hola", null],
  ["Quiero un crédito hipotecario para comprar casa", null],
  ["¿Me recomiendan invertir en acciones?", null],
];

async function main() {
  const { embedder } = getAi();
  const threshold = env.ai.ragMinScore;
  let correctTop = 0;
  let relevant = 0;
  let wellSeparated = 0;

  console.log(`Proveedor: ${env.ai.provider} · modelo: ${embedder.model} · RAG_MIN_SCORE: ${threshold}\n`);
  for (const [question, expected] of CASES) {
    const { vectors } = await embedder.embed([question], "query");
    const [best] = await searchChunks(vectors[0]!, embedder.model, 1);
    const slug = best
      ? (await prisma.kbArticle.findUnique({ where: { id: best.articleId }, select: { slug: true } }))?.slug
      : undefined;
    const score = best?.score ?? 0;
    const passes = score >= threshold;
    if (expected) {
      relevant += 1;
      if (slug === expected) correctTop += 1;
      if (passes && slug === expected) wellSeparated += 1;
    } else if (!passes) {
      wellSeparated += 1;
    }
    const verdict = expected ? (slug === expected ? "ok " : "MAL") : passes ? "FP " : "ok ";
    console.log(`${verdict} ${score.toFixed(3)} ${(slug ?? "-").padEnd(26)} ← ${question}`);
  }
  console.log(`\nMejor fragmento correcto: ${correctTop}/${relevant} preguntas relevantes`);
  console.log(`Bien clasificadas con el umbral ${threshold}: ${wellSeparated}/${CASES.length}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    redisConnection.disconnect();
  });
