import { describe, expect, it } from "vitest";
import { PLAIN_TEXT_RULE, stripMarkdownEmphasis } from "../../src/services/ai/plainText";
import { REPLY_SYSTEM_PROMPT } from "../../src/services/ai/prompts";

describe("stripMarkdownEmphasis: el texto del modelo llega al cliente sin asteriscos", () => {
  it.each([
    ["negrita", "Atendemos de **lunes a viernes**.", "Atendemos de lunes a viernes."],
    ["cursiva", "Puedes hacerlo *desde la app*.", "Puedes hacerlo desde la app."],
    [
      "negrita y cursiva juntas",
      "***Importante***: nunca compartas tu clave.",
      "Importante: nunca compartas tu clave.",
    ],
    ["negrita sin pareja (respuesta cortada)", "La cuota de manejo es **$15.000", "La cuota de manejo es $15.000"],
    ["asterisco suelto pegado", "Aplican condiciones*", "Aplican condiciones"],
    ["varias en una línea", "**Horario**: 8 a 5 y **sábados**: 9 a 12", "Horario: 8 a 5 y sábados: 9 a 12"],
  ])("%s", (_label, input, expected) => {
    expect(stripMarkdownEmphasis(input)).toBe(expected);
  });

  it("las viñetas con * pasan a guiones y conservan la sangría", () => {
    expect(stripMarkdownEmphasis("Opciones:\n* **App** móvil\n  * Oficina")).toBe(
      "Opciones:\n- App móvil\n  - Oficina"
    );
  });

  it("no toca multiplicaciones ni el resto del texto, y es idempotente", () => {
    expect(stripMarkdownEmphasis("Son 2 * 3 = 6 cuotas y 4*5 = 20")).toBe("Son 2 * 3 = 6 cuotas y 4*5 = 20");
    const plain = "Sin formato: $15.000 (20 %), guiones - y <etiquetas> intactas.";
    expect(stripMarkdownEmphasis(plain)).toBe(plain);
    const once = stripMarkdownEmphasis("**uno** y *dos*");
    expect(stripMarkdownEmphasis(once)).toBe(once);
  });
});

describe("El prompt de respuesta pide texto plano (también se lee en voz alta)", () => {
  it("incluye la regla", () => {
    expect(REPLY_SYSTEM_PROMPT).toContain(PLAIN_TEXT_RULE);
    expect(REPLY_SYSTEM_PROMPT).toMatch(/voz alta/);
    expect(PLAIN_TEXT_RULE).toMatch(/sin Markdown/);
  });
});
