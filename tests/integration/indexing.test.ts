import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app, authHeader, createConversation, kbArticle, staffSession } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { indexArticle } from "../../src/modules/rag/indexing.service";
import { replaceArticleChunks } from "../../src/modules/rag/rag.repository";
import { enqueueArticleIndexing } from "../../src/queues/queues";
import { notifyEscalation } from "../../src/workers/notifyEscalation";
import { publishStaffEvent } from "../../src/realtime/staffEvents";

const longBody = [
  "Primer párrafo sobre cómo solicitar un certificado bancario desde la banca en línea.",
  "Segundo párrafo. ".repeat(50),
  "Tercer párrafo con el plazo de entrega de cinco días hábiles.",
].join("\n\n");

describe("indexación de la base de conocimiento (worker kb-indexing)", () => {
  it("indexa un artículo publicado en fragmentos que son texto literal del cuerpo", async () => {
    const article = await kbArticle("Certificados", longBody);
    const chunks = await prisma.kbChunk.findMany({ where: { articleId: article.id }, orderBy: { chunkIndex: "asc" } });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(longBody.includes(chunk.content)).toBe(true);
      expect(chunk.articleVersion).toBe(1);
      expect(chunk.embeddingModel).toBe("mock-embed-v1");
    }
  });

  it("re-indexar es idempotente: no duplica fragmentos", async () => {
    const article = await kbArticle("Certificados 2", longBody);
    const before = await prisma.kbChunk.count({ where: { articleId: article.id } });
    await indexArticle(article.id);
    await indexArticle(article.id);
    expect(await prisma.kbChunk.count({ where: { articleId: article.id } })).toBe(before);
  });

  it("al editar el contenido, los fragmentos se reemplazan por los de la versión nueva", async () => {
    const article = await kbArticle("Horario cambiante", "Abrimos a las 8.");
    await prisma.kbArticle.update({ where: { id: article.id }, data: { body: "Ahora abrimos a las 7.", version: 2 } });
    expect(await indexArticle(article.id)).toMatchObject({ status: "indexed", version: 2 });
    const chunks = await prisma.kbChunk.findMany({ where: { articleId: article.id } });
    expect(chunks.map((c) => c.content)).toEqual(["Ahora abrimos a las 7."]);
  });

  it("al despublicar (borrador o archivado) sus fragmentos se eliminan", async () => {
    const article = await kbArticle("Temporal", "Contenido temporal de prueba.");
    await prisma.kbArticle.update({ where: { id: article.id }, data: { status: "archived" } });
    expect(await indexArticle(article.id)).toEqual({ status: "removed", reason: "not_published" });
    expect(await prisma.kbChunk.count({ where: { articleId: article.id } })).toBe(0);
  });

  it("si el artículo cambió mientras se calculaban los embeddings, NO se escribe la versión vieja", async () => {
    const article = await kbArticle("Carrera", "Versión uno del texto.");
    await prisma.kbArticle.update({ where: { id: article.id }, data: { body: "Versión dos del texto.", version: 2 } });
    const written = await replaceArticleChunks(article.id, 1, "mock-embed-v1", [
      { chunkIndex: 0, content: "Versión uno del texto.", vector: new Array(1024).fill(0.01) },
    ]);
    expect(written).toBe(false);
  });

  it("crear o editar un artículo por la API encola su indexación", async () => {
    const { token } = await staffSession("admin");
    vi.mocked(enqueueArticleIndexing).mockClear();
    const res = await request(app)
      .post("/api/kb/articles")
      .set(authHeader(token))
      .send({
        slug: `enc-${Date.now()}`,
        title: "Encolado",
        body: "Cuerpo suficientemente largo para validar.",
        category: "pruebas",
        status: "published",
      });
    expect(res.status).toBe(201);
    expect(enqueueArticleIndexing).toHaveBeenCalledWith(res.body.id, 1, "published");
  });
});

describe("aviso de escalamientos (worker escalation-notify)", () => {
  it("sugiere al agente disponible con menos carga y excluye a los no disponibles, inactivos o sin cupo", async () => {
    // Estado controlado: nadie más "available" en la base de pruebas.
    await prisma.staffUser.updateMany({ data: { availability: "offline" } });
    const [libre, ocupado, lleno, ausente, inactivo] = await Promise.all([
      staffSession("agent"),
      staffSession("agent"),
      staffSession("agent", { maxConcurrent: 1 }),
      staffSession("agent"),
      staffSession("agent"),
    ]);
    await prisma.staffUser.updateMany({
      where: { id: { in: [libre, ocupado, lleno, inactivo].map((s) => s.staff.id) } },
      data: { availability: "available" },
    });
    await prisma.staffUser.update({ where: { id: inactivo.staff.id }, data: { isActive: false } });
    await createConversation("agent_active", ocupado.staff.id);
    await createConversation("agent_active", lleno.staff.id);

    const { conversation } = await createConversation("waiting_agent");
    const escalation = await prisma.escalation.findFirstOrThrow({ where: { conversationId: conversation.id } });
    vi.mocked(publishStaffEvent).mockClear();

    const event = await notifyEscalation(escalation.id);
    expect(event?.suggestedAgentId).toBe(libre.staff.id);
    expect(event?.candidateAgentIds).toEqual([libre.staff.id, ocupado.staff.id]);
    expect(event?.candidateAgentIds).not.toContain(ausente.staff.id);
    expect(publishStaffEvent).toHaveBeenCalledWith(event);
    // El evento no lleva contenido de mensajes ni datos del cliente.
    expect(Object.keys(event!).sort()).toEqual(
      [
        "candidateAgentIds",
        "conversationId",
        "createdAt",
        "escalationId",
        "priority",
        "reason",
        "suggestedAgentId",
        "type",
      ].sort()
    );
  });

  it("si el escalamiento ya fue tomado cuando llega el trabajo, no avisa", async () => {
    const agent = await staffSession("agent");
    const { conversation } = await createConversation("agent_active", agent.staff.id);
    const escalation = await prisma.escalation.findFirstOrThrow({ where: { conversationId: conversation.id } });
    vi.mocked(publishStaffEvent).mockClear();
    expect(await notifyEscalation(escalation.id)).toBeNull();
    expect(publishStaffEvent).not.toHaveBeenCalled();
  });
});
