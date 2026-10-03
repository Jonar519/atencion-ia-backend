import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { idVariation, simulatedCsatScore, summarizeCsat } from "../../src/modules/analytics/csat";

/** Busca un id cuya variación sea la pedida (para probar la regla sin azar). */
function idWith(variation: -1 | 0 | 1): string {
  for (;;) {
    const id = randomUUID();
    if (idVariation(id) === variation) return id;
  }
}

describe("CSAT simulado (regla documentada en docs/analytics.md)", () => {
  it("es determinista: el mismo id da siempre la misma variación", () => {
    const id = randomUUID();
    expect(new Set(Array.from({ length: 5 }, () => idVariation(id))).size).toBe(1);
  });

  it("la variación es −1, 0 o +1, repartida de forma pareja", () => {
    const counts = { "-1": 0, "0": 0, "1": 0 };
    for (let i = 0; i < 3000; i++) counts[String(idVariation(randomUUID())) as keyof typeof counts] += 1;
    for (const count of Object.values(counts)) expect(count).toBeGreaterThan(850);
  });

  it("base según cómo terminó, −1 si tardó más de 30 min", () => {
    const id = idWith(0);
    expect(simulatedCsatScore({ id, closeReason: "resolved_by_ai", resolutionMinutes: 5 })).toBe(4);
    expect(simulatedCsatScore({ id, closeReason: "resolved_by_agent", resolutionMinutes: 31 })).toBe(3);
    expect(simulatedCsatScore({ id, closeReason: "resolved_by_agent", resolutionMinutes: 30 })).toBe(4);
    expect(simulatedCsatScore({ id, closeReason: "inactivity", resolutionMinutes: 5 })).toBe(3);
    expect(simulatedCsatScore({ id, closeReason: "customer_abandoned", resolutionMinutes: 5 })).toBe(2);
  });

  it("el spam y lo que no está cerrado no entran; la nota queda entre 1 y 5", () => {
    expect(simulatedCsatScore({ id: idWith(0), closeReason: "spam", resolutionMinutes: 1 })).toBeNull();
    expect(simulatedCsatScore({ id: idWith(0), closeReason: null, resolutionMinutes: 1 })).toBeNull();
    expect(simulatedCsatScore({ id: idWith(1), closeReason: "resolved_by_ai", resolutionMinutes: 1 })).toBe(5);
    expect(simulatedCsatScore({ id: idWith(-1), closeReason: "customer_abandoned", resolutionMinutes: 99 })).toBe(1);
  });

  it("resumen: % de notas 4–5, promedio y distribución; sin datos, null (no 0)", () => {
    expect(summarizeCsat([5, 4, 3, 2])).toEqual({
      simulated: true,
      responses: 4,
      satisfiedPercent: 50,
      average: 3.5,
      distribution: [0, 1, 1, 1, 1],
    });
    expect(summarizeCsat([])).toMatchObject({ responses: 0, satisfiedPercent: null, average: null });
  });
});
