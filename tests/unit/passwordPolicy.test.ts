import { describe, expect, it } from "vitest";
import { PASSWORD_MIN_LENGTH, passwordProblems } from "../../src/modules/auth/passwordPolicy";

describe("política de contraseñas", () => {
  it("acepta una frase larga sin reglas de composición", () => {
    expect(passwordProblems("caballo correcto grapa")).toEqual([]);
  });

  it(`exige al menos ${PASSWORD_MIN_LENGTH} caracteres`, () => {
    expect(passwordProblems("Corta-123")).toContain(`Debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`);
  });

  it("mide el máximo en bytes (bcrypt corta a 72): 40 'ñ' son 80 bytes", () => {
    expect(passwordProblems("ñ".repeat(40))).toContain("Debe tener como máximo 72 bytes");
  });

  it.each(["password1234!", "Cordillera2026", "qwertyuiop12", "aaaaaaaaaaaaaa", "123456789012345"])(
    "rechaza la contraseña común o trivial %s",
    (password) => {
      expect(passwordProblems(password)).toContain("Es demasiado común o fácil de adivinar");
    }
  );

  it("rechaza contraseñas que contienen el correo o el nombre", () => {
    expect(passwordProblems("laura.mendez-2026!", { email: "laura.mendez@x.example" })).toContain(
      "No debe contener tu correo"
    );
    expect(passwordProblems("SoyDiegoElMejor99", { name: "Diego Rojas" })).toContain("No debe contener tu nombre");
  });
});
