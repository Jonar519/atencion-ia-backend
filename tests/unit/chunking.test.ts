import { describe, expect, it } from "vitest";
import { chunkArticleBody, MAX_CHUNK_CHARS } from "../../src/modules/rag/chunking";

const para = (n: number, len = 300) =>
  `Párrafo ${n}. ${"texto de soporte ".repeat(Math.ceil(len / 17))}`.slice(0, len).trim() + ".";

describe("fragmentación de artículos", () => {
  it("cada fragmento es una subcadena EXACTA del cuerpo (lo exige la base, migración 013)", () => {
    const body = [para(1), para(2), para(3, 900), para(4, 2500)].join("\n\n");
    for (const chunk of chunkArticleBody(body)) expect(body.includes(chunk)).toBe(true);
  });

  it("no deja texto por fuera: todas las palabras del cuerpo aparecen en algún fragmento", () => {
    const body = [para(1), para(2, 1200), "Cierre final único."].join("\n\n");
    const joined = chunkArticleBody(body).join(" ");
    for (const marker of ["Párrafo 1.", "Párrafo 2.", "Cierre final único."]) expect(joined).toContain(marker);
  });

  it("ningún fragmento supera el máximo, aunque un párrafo sea enorme y sin puntos", () => {
    const body = `${para(1)}\n\n${"a".repeat(3500)}`;
    for (const chunk of chunkArticleBody(body)) expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  it("junta párrafos cortos en un solo fragmento", () => {
    expect(chunkArticleBody("Uno corto.\n\nDos corto.\n\nTres corto.")).toEqual([
      "Uno corto.\n\nDos corto.\n\nTres corto.",
    ]);
  });

  it("un cuerpo vacío o solo de espacios no produce fragmentos", () => {
    expect(chunkArticleBody("   \n\n  ")).toEqual([]);
  });
});
