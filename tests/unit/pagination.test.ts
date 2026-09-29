import { describe, expect, it } from "vitest";
import { afterCursor, decodeCursor, encodeCursor, toPage } from "../../src/utils/pagination";

const ID = "c0000000-0000-4000-8000-000000000001";

describe("paginación por cursor", () => {
  it("el cursor es reversible", () => {
    const date = new Date("2026-09-29T10:00:00.123Z");
    expect(decodeCursor(encodeCursor(date, ID))).toEqual({ date, id: ID });
  });

  it.each(["no-es-base64", Buffer.from("2026-01-01|no-es-uuid").toString("base64url"), ""])(
    "un cursor manipulado (%s) es un 400, no un error interno",
    (cursor) => {
      expect(() => decodeCursor(cursor)).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
  );

  it("toPage devuelve nextCursor solo si hay más filas que el límite", () => {
    const rows = [1, 2, 3].map((n) => ({ id: `${ID.slice(0, -1)}${n}`, at: new Date(2026, 0, n) }));
    expect(toPage(rows, 3, (r) => r.at).nextCursor).toBeNull();
    const page = toPage(rows, 2, (r) => r.at);
    expect(page.items).toHaveLength(2);
    expect(decodeCursor(page.nextCursor!).id).toBe(rows[1]!.id);
  });

  it("sin cursor no filtra nada", () => {
    expect(afterCursor("createdAt")).toEqual({});
  });
});
