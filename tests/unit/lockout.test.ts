import { describe, expect, it } from "vitest";
import { FREE_ATTEMPTS, MAX_LOCK_MINUTES, lockMinutesFor } from "../../src/modules/auth/lockout.service";

describe("bloqueo progresivo de login", () => {
  it("los primeros intentos fallidos no bloquean", () => {
    for (let failures = 0; failures < FREE_ATTEMPTS; failures++) expect(lockMinutesFor(failures)).toBe(0);
  });

  it("a partir del umbral el bloqueo se duplica: 1, 2, 4, 8… minutos", () => {
    expect([0, 1, 2, 3].map((extra) => lockMinutesFor(FREE_ATTEMPTS + extra))).toEqual([1, 2, 4, 8]);
  });

  it(`nunca supera ${MAX_LOCK_MINUTES} minutos`, () => {
    expect(lockMinutesFor(FREE_ATTEMPTS + 30)).toBe(MAX_LOCK_MINUTES);
  });
});
