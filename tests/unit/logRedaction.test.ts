import { describe, expect, it } from "vitest";
import pino from "pino";
import { Writable } from "stream";
import { REDACT_PATHS } from "../../src/config/logger";

function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = pino({ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, stream);
  return { logger, output: () => lines.join("") };
}

describe("redacción de datos sensibles en logs", () => {
  it("oculta credenciales, cookies y el contenido de los mensajes aunque se loguee el objeto entero", () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        password: "Llave-Secreta-123",
        req: { headers: { authorization: "Bearer eyJ.secreto", cookie: "atencion_ia_refresh=abc" } },
        body: { content: "Mi número de tarjeta es 4111 1111 1111 1111" },
        config: { jwtSecret: "s3cr3t", databaseUrl: "postgresql://u:p@h/db" },
        staffId: "visible-porque-no-es-sensible",
      },
      "prueba"
    );
    const text = output();
    for (const secret of ["Llave-Secreta-123", "eyJ.secreto", "atencion_ia_refresh=abc", "4111", "s3cr3t", "u:p@h"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("visible-porque-no-es-sensible");
  });
});
