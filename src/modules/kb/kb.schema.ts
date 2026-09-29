import { z } from "zod";
import { cleanText } from "../../utils/schemas";
import { paginationQuerySchema } from "../../utils/pagination";

const slugSchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Solo minúsculas, números y guiones (ej. bloquear-tarjeta)");

const tagsSchema = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(40)
      .regex(/^[\p{L}\p{N}-]+$/u, "Una etiqueta es una sola palabra (letras, números o guiones)")
  )
  .max(20)
  .transform((tags) => [...new Set(tags)]);

// Un admin solo puede crear/editar como borrador o publicado; "archived" se
// usa para retirar un artículo sin borrarlo (sigue citado en mensajes viejos).
const statusSchema = z.enum(["draft", "published", "archived"]);

export const createArticleSchema = z
  .object({
    slug: slugSchema,
    title: cleanText(3, 200),
    body: cleanText(20, 50_000),
    category: cleanText(2, 60).transform((value) => value.toLowerCase()),
    tags: tagsSchema.default([]),
    status: statusSchema.exclude(["archived"]).default("draft"),
  })
  .strict();

export const updateArticleSchema = z
  .object({
    slug: slugSchema.optional(),
    title: cleanText(3, 200).optional(),
    body: cleanText(20, 50_000).optional(),
    category: cleanText(2, 60)
      .transform((value) => value.toLowerCase())
      .optional(),
    tags: tagsSchema.optional(),
    status: statusSchema.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: "No hay campos para actualizar" });

export const listArticlesQuerySchema = paginationQuerySchema
  .extend({
    status: statusSchema.optional(),
    category: z.string().trim().toLowerCase().max(60).optional(),
    // Búsqueda simple por título (la búsqueda semántica es del RAG, Fase 3).
    q: z.string().trim().min(2).max(100).optional(),
  })
  .strict();

export type CreateArticleInput = z.infer<typeof createArticleSchema>;
export type UpdateArticleInput = z.infer<typeof updateArticleSchema>;
export type ListArticlesQuery = z.infer<typeof listArticlesQuerySchema>;
