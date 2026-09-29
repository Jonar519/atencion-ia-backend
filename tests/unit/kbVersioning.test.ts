import { describe, expect, it } from "vitest";
import { nextVersionAndPublication } from "../../src/modules/kb/kb.service";

const current = { title: "Bloquear tarjeta", body: "Cuerpo original del artículo", version: 3, publishedAt: null };

describe("versión y publicación de artículos", () => {
  it("la versión sube si cambia el título o el cuerpo (lo que se indexa para el RAG)", () => {
    expect(nextVersionAndPublication(current, { title: "Nuevo título" }).version).toBe(4);
    expect(nextVersionAndPublication(current, { body: "Otro cuerpo distinto del anterior" }).version).toBe(4);
  });

  it("la versión NO sube si solo cambian metadatos o el contenido es idéntico", () => {
    expect(nextVersionAndPublication(current, { tags: ["tarjeta"], category: "tarjetas" }).version).toBe(3);
    expect(nextVersionAndPublication(current, { title: current.title }).contentChanged).toBe(false);
  });

  it("published_at se fija la primera vez que se publica y no se pisa después", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    expect(nextVersionAndPublication(current, { status: "published" }, now).publishedAt).toEqual(now);
    const alreadyPublished = { ...current, publishedAt: new Date("2026-01-01T00:00:00Z") };
    expect(nextVersionAndPublication(alreadyPublished, { status: "published" }, now).publishedAt).toEqual(
      alreadyPublished.publishedAt
    );
  });
});
