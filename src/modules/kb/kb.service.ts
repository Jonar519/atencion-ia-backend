import { Prisma, type KbArticle } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ApiError } from "../../utils/apiError";
import { afterCursor, toPage } from "../../utils/pagination";
import type { CreateArticleInput, ListArticlesQuery, UpdateArticleInput } from "./kb.schema";

const LIST_FIELDS = {
  id: true,
  slug: true,
  title: true,
  category: true,
  tags: true,
  status: true,
  version: true,
  publishedAt: true,
  updatedAt: true,
} satisfies Prisma.KbArticleSelect;

const DETAIL_FIELDS = {
  ...LIST_FIELDS,
  body: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
  updatedBy: { select: { id: true, name: true } },
} satisfies Prisma.KbArticleSelect;

function conflictOnSlug(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    throw new ApiError(409, "Ya existe un artículo con ese slug");
  }
  throw err;
}

/**
 * Reglas de versión y publicación (función pura, probada en tests/unit):
 *  - version sube SOLO si cambia el contenido que se indexa (título o cuerpo):
 *    así el worker de embeddings (Fase 3) sabe qué fragmentos quedaron viejos.
 *  - published_at se fija la primera vez que se publica y no se pisa después.
 */
export function nextVersionAndPublication(
  current: Pick<KbArticle, "title" | "body" | "version" | "publishedAt">,
  input: UpdateArticleInput,
  now = new Date()
) {
  const contentChanged =
    (input.title !== undefined && input.title !== current.title) ||
    (input.body !== undefined && input.body !== current.body);
  return {
    version: contentChanged ? current.version + 1 : current.version,
    contentChanged,
    publishedAt: input.status === "published" && !current.publishedAt ? now : current.publishedAt,
  };
}

export const kbService = {
  async list(query: ListArticlesQuery) {
    const where: Prisma.KbArticleWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.q ? { title: { contains: query.q, mode: "insensitive" } } : {}),
      ...afterCursor("updatedAt", query.cursor),
    };
    const rows = await prisma.kbArticle.findMany({
      where,
      select: LIST_FIELDS,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
    });
    return toPage(rows, query.limit, (row) => row.updatedAt);
  },

  async get(id: string) {
    const article = await prisma.kbArticle.findUnique({ where: { id }, select: DETAIL_FIELDS });
    if (!article) throw new ApiError(404, "Artículo no encontrado");
    return article;
  },

  async create(actorId: string, input: CreateArticleInput) {
    return prisma.kbArticle
      .create({
        data: {
          ...input,
          createdById: actorId,
          updatedById: actorId,
          publishedAt: input.status === "published" ? new Date() : null,
        },
        select: DETAIL_FIELDS,
      })
      .catch(conflictOnSlug);
  },

  async update(actorId: string, id: string, input: UpdateArticleInput) {
    const current = await prisma.kbArticle.findUnique({ where: { id } });
    if (!current) throw new ApiError(404, "Artículo no encontrado");
    const { version, publishedAt, contentChanged } = nextVersionAndPublication(current, input);

    // Condicionado a la versión leída: si otro admin editó entre la lectura y
    // la escritura, no se pisa su cambio en silencio (409, recargar y reintentar).
    const { count } = await prisma.kbArticle
      .updateMany({
        where: { id, version: current.version },
        data: { ...input, version, publishedAt, updatedById: actorId },
      })
      .catch(conflictOnSlug);
    if (count === 0)
      throw new ApiError(409, "El artículo cambió mientras lo editabas. Recárgalo e inténtalo de nuevo.");
    return { article: await this.get(id), contentChanged };
  },

  /** Borrado definitivo. Las citas en mensajes viejos sobreviven (article_id pasa a NULL). */
  async remove(id: string) {
    const { count } = await prisma.kbArticle.deleteMany({ where: { id } });
    if (count === 0) throw new ApiError(404, "Artículo no encontrado");
  },
};
