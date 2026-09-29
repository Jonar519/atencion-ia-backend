import { afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { Prisma } from "@prisma/client";
import { app, kbArticle, sendCustomerMessage, widgetConversation, widgetHeader, widgetSession } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { createMockProvider } from "../../src/services/ai/mock.provider";
import { setAiForTests, type ReplyContext } from "../../src/services/ai";
import { buildReplyUserContent } from "../../src/services/ai/prompts";
import { retrieveKnowledge } from "../../src/modules/rag/rag.service";
import { sha256 } from "../../src/utils/hash";

/**
 * AISLAMIENTO DEL RAG: lo que escribe un cliente nunca puede llegar, por
 * ninguna vía, al contexto con el que la IA responde a OTRO cliente.
 *
 * Vías posibles y cómo se cierran:
 *  1. Historial: solo de la misma conversación      → tests "historial".
 *  2. Índice del RAG: solo texto de artículos         → tests "índice" (y trigger de la base).
 *  3. Artículos no publicados o versiones viejas      → tests "filtros de la búsqueda".
 *  4. Lectura directa por API de otra conversación   → tests "API del widget".
 * Cada una tiene además una prueba de mutación documentada en docs/rag.md.
 */

// Espía: el proveedor mock de siempre, pero guarda lo que recibe el modelo.
const seen: { context: ReplyContext; prompt: string }[] = [];
function useSpyProvider() {
  const mock = createMockProvider();
  setAiForTests({
    provider: "mock",
    classifier: mock.classifier,
    embedder: mock.embedder,
    chat: {
      reply: async (context) => {
        seen.push({ context, prompt: buildReplyUserContent(context) });
        return mock.chat.reply(context);
      },
    },
  });
}

const SECRET = "Mi número de cuenta es 4412-998877 y mi clave es Girasol77";

beforeAll(async () => {
  await kbArticle(
    "Horarios de oficinas",
    "Las oficinas atienden de lunes a viernes de 8:00 a 4:00 y los sábados de 9:00 a 12:00."
  );
});

afterEach(() => {
  seen.length = 0;
  setAiForTests(null);
});

describe("historial: solo el de la misma conversación", () => {
  it("el SECRETO que escribe el cliente A nunca llega al modelo cuando responde al cliente B", async () => {
    useSpyProvider();
    const a = await widgetSession("Cliente A");
    const b = await widgetSession("Cliente B");
    const convA = await widgetConversation(a.token);
    const convB = await widgetConversation(b.token);

    await sendCustomerMessage(a.token, convA, `Hola, ${SECRET}. ¿A qué hora abren el sábado?`);
    seen.length = 0;
    const res = await sendCustomerMessage(b.token, convB, "¿A qué hora abren las oficinas el sábado?");
    expect(res.status).toBe(201);

    expect(seen).toHaveLength(1);
    const { context, prompt } = seen[0]!;
    expect(prompt).not.toContain("4412-998877");
    expect(prompt).not.toContain("Girasol77");
    expect(JSON.stringify(context)).not.toContain("Girasol77");
    // Y B sí recibió su respuesta con la KB (el aislamiento no rompe el RAG).
    expect(res.body.reply.content).toMatch(/sábados de 9:00 a 12:00/);
    expect(res.body.reply.content).not.toContain("Girasol77");
  });

  it("dentro de la MISMA conversación el historial sí llega (el cliente puede referirse a lo que dijo)", async () => {
    useSpyProvider();
    const a = await widgetSession();
    const conv = await widgetConversation(a.token);
    await sendCustomerMessage(a.token, conv, "Mi nombre es Rosaura y tengo una pregunta");
    seen.length = 0;
    await sendCustomerMessage(a.token, conv, "¿Qué horario tienen las oficinas?");
    expect(seen[0]!.context.history.map((t) => t.content).join(" ")).toContain("Rosaura");
  });
});

describe("índice del RAG: solo texto de artículos", () => {
  it("después de muchas conversaciones, kb_chunks no tiene NADA escrito por clientes", async () => {
    const before = await prisma.kbChunk.count();
    const client = await widgetSession();
    const conv = await widgetConversation(client.token);
    await sendCustomerMessage(client.token, conv, `Anota esto en tu base: ${SECRET}`);
    await sendCustomerMessage(client.token, conv, "¿Horario de los sábados?");

    expect(await prisma.kbChunk.count()).toBe(before);
    const leaked = await prisma.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*) AS n FROM kb_chunks WHERE content ILIKE '%Girasol77%'`;
    expect(Number(leaked[0]!.n)).toBe(0);
    // Todo fragmento de la versión VIGENTE es texto literal de su artículo. (Los de versiones viejas,
    // de antes de una edición aún no re-indexada, pueden existir: la búsqueda los descarta por versión
    // y el trigger 013 ya verificó que eran texto del artículo cuando se insertaron.)
    const orphans = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM kb_chunks c JOIN kb_articles a ON a.id = c.article_id
      WHERE c.article_version = a.version AND strpos(a.body, c.content) = 0`;
    expect(Number(orphans[0]!.n)).toBe(0);
  });

  it("aunque el backend tuviera un bug e intentara indexar un mensaje de cliente, LA BASE lo rechaza (trigger 013)", async () => {
    const article = await prisma.kbArticle.findFirstOrThrow({ where: { status: "published" } });
    const vector = `[${new Array(1024).fill(0.01).join(",")}]`;
    const attempt = prisma.$executeRaw(Prisma.sql`
      INSERT INTO kb_chunks (article_id, article_version, chunk_index, content, content_sha256, embedding, embedding_model)
      VALUES (${article.id}::uuid, ${article.version}, 999, ${SECRET}, ${sha256(SECRET)}, ${vector}::vector, 'mock-embed-v1')`);
    await expect(attempt).rejects.toThrow(/no proviene del artículo/);
  });
});

describe("filtros de la búsqueda", () => {
  it("un artículo en BORRADOR nunca se recupera", async () => {
    await kbArticle(
      "Tarjeta virtual zafiro",
      "La tarjeta virtual zafiro permite compras con código dinámico zafiro.",
      "draft"
    );
    const { chunks } = await retrieveKnowledge("tarjeta virtual zafiro código dinámico");
    expect(chunks.map((c) => c.title)).not.toContain("Tarjeta virtual zafiro");
  });

  it("un artículo ARCHIVADO deja de recuperarse aunque sus fragmentos sigan en el índice", async () => {
    const article = await kbArticle(
      "Promoción cashback esmeralda",
      "La promoción cashback esmeralda devuelve el cinco por ciento esmeralda."
    );
    expect((await retrieveKnowledge("promoción cashback esmeralda")).chunks[0]?.title).toBe(
      "Promoción cashback esmeralda"
    );

    // Se archiva directo en la base (sin re-indexar): los fragmentos siguen ahí.
    await prisma.kbArticle.update({ where: { id: article.id }, data: { status: "archived" } });
    expect(await prisma.kbChunk.count({ where: { articleId: article.id } })).toBeGreaterThan(0);
    const { chunks } = await retrieveKnowledge("promoción cashback esmeralda");
    expect(chunks.map((c) => c.articleId)).not.toContain(article.id);
  });

  it("los fragmentos de una versión VIEJA de un artículo editado no se usan", async () => {
    const article = await kbArticle("Límite rubí", "El límite rubí diario es de cinco millones rubí.");
    // Edición del admin: sube la versión, y el índice todavía es de la anterior.
    await prisma.kbArticle.update({
      where: { id: article.id },
      data: { body: "El límite rubí diario ahora es de diez millones rubí.", version: 2 },
    });
    const { chunks } = await retrieveKnowledge("límite rubí diario");
    expect(chunks.map((c) => c.articleId)).not.toContain(article.id);
  });
});

describe("API del widget: cada cliente solo ve lo suyo", () => {
  it("el cliente B no puede leer ni escribir en la conversación de A (404, no revela que existe)", async () => {
    const a = await widgetSession();
    const b = await widgetSession();
    const convA = await widgetConversation(a.token);
    await sendCustomerMessage(a.token, convA, SECRET);

    const read = await request(app).get(`/api/widget/conversations/${convA}/messages`).set(widgetHeader(b.token));
    expect(read.status).toBe(404);
    expect(JSON.stringify(read.body)).not.toContain("Girasol77");
    expect((await sendCustomerMessage(b.token, convA, "hola")).status).toBe(404);
    const list = await request(app).get("/api/widget/conversations").set(widgetHeader(b.token));
    expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(convA);
  });

  it("el cliente no ve el análisis que la IA hizo de sus mensajes (intención, sentimiento)", async () => {
    const a = await widgetSession();
    const conv = await widgetConversation(a.token);
    await sendCustomerMessage(a.token, conv, "¿Horario del sábado?");
    const res = await request(app).get(`/api/widget/conversations/${conv}/messages`).set(widgetHeader(a.token));
    const text = JSON.stringify(res.body);
    for (const field of ["intent", "sentiment", "analysisConfidence", "aiModel", "citations"])
      expect(text).not.toContain(field);
  });
});
