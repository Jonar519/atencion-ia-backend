import { describe, expect, it } from "vitest";
import { consumeHiddenInput, firstLine, parseArgs } from "../../src/scripts/crearAdmin";

describe("npm run admin:crear: argumentos", () => {
  it("lee --correo y --nombre, con espacio o con =", () => {
    expect(parseArgs(["--correo", "a@b.co", "--nombre=Ana Ríos"])).toEqual({
      email: "a@b.co",
      name: "Ana Ríos",
      stdin: false,
      help: false,
    });
    expect(parseArgs(["--correo=a@b.co", "--nombre", "Ana", "--stdin"])).toMatchObject({ stdin: true });
  });

  it.each(["--password", "--contrasena", "--contraseña"])("rechaza la contraseña por argumento (%s)", (flag) => {
    expect(() => parseArgs(["--correo", "a@b.co", flag, "x"])).toThrow(/no se pasa por argumento/);
  });

  it("rechaza argumentos desconocidos y banderas sin valor", () => {
    expect(() => parseArgs(["--rol", "admin"])).toThrow(/desconocido/);
    expect(() => parseArgs(["--correo"])).toThrow(/Falta el valor/);
    expect(() => parseArgs(["--correo", "--nombre", "Ana"])).toThrow(/Falta el valor/);
  });
});

describe("npm run admin:crear: lectura sin eco", () => {
  it("acumula hasta Enter, con Retroceso y sin controles ni secuencias de escape", () => {
    let step = consumeHiddenInput("", "abc");
    expect(step).toEqual({ value: "abc", done: false, aborted: false });
    step = consumeHiddenInput(step.value, "\u007f");
    expect(step.value).toBe("ab");
    step = consumeHiddenInput(step.value, "\u001b[A");
    expect(step.value).toBe("ab");
    step = consumeHiddenInput(step.value, "\tñ\r");
    expect(step).toEqual({ value: "abñ", done: true, aborted: false });
  });

  it("todo en un solo trozo (texto pegado) y Ctrl+C cancela", () => {
    expect(consumeHiddenInput("", "frase larga pegada\r\n")).toEqual({
      value: "frase larga pegada",
      done: true,
      aborted: false,
    });
    expect(consumeHiddenInput("secreto", "\u0003")).toEqual({ value: "", done: true, aborted: true });
  });

  it("--stdin: primera línea, sin BOM ni salto de línea", () => {
    expect(firstLine(`${String.fromCharCode(0xfeff)}Mi frase segura 2026\r\nresto`)).toBe("Mi frase segura 2026");
    expect(firstLine("solo una línea\n")).toBe("solo una línea");
  });
});
