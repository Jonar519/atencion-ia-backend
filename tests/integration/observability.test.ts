import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app, authHeader, createConversation, staffSession } from "../helpers";
import { markShuttingDown, resetShuttingDown } from "../../src/observability/health";

const METRICS = { Authorization: `Bearer ${process.env.METRICS_TOKEN}` };

describe("sondas", () => {
  afterEach(() => resetShuttingDown());

  it("/health responde sin consultar dependencias", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("/ready verifica PostgreSQL y Redis", async () => {
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ database: "ok", redis: "ok" });
  });

  it("/ready responde 503 durante el apagado ordenado (y /health sigue en 200)", async () => {
    markShuttingDown();
    expect((await request(app).get("/ready")).status).toBe(503);
    expect((await request(app).get("/health")).status).toBe(200);
  });
});

describe("métricas Prometheus", () => {
  it("exigen el token: sin él 401, con uno equivocado 401", async () => {
    expect((await request(app).get("/metrics")).status).toBe(401);
    expect((await request(app).get("/metrics").set("Authorization", "Bearer equivocado")).status).toBe(401);
  });

  it("registran la RUTA como patrón, nunca ids de conversaciones", async () => {
    const { staff, token } = await staffSession("agent");
    const { conversation } = await createConversation("agent_active", staff.id);
    await request(app).get(`/api/conversations/${conversation.id}`).set(authHeader(token));

    const res = await request(app).get("/metrics").set(METRICS);
    expect(res.status).toBe(200);
    expect(res.text).toContain('route="/api/conversations/:id"');
    expect(res.text).not.toContain(conversation.id);
    expect(res.text).toContain("atencion_ia_auth_events_total");
  });
});

describe("cabeceras de seguridad y trazabilidad", () => {
  it("toda respuesta de la API es no-store, lleva X-Request-Id y cabeceras de helmet", async () => {
    const res = await request(app).get("/api/kb/articles");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-request-id"]).toMatch(/^[\w-]{8,64}$/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("respeta un X-Request-Id válido del cliente y descarta uno malicioso", async () => {
    expect((await request(app).get("/health").set("X-Request-Id", "abc-12345678")).headers["x-request-id"]).toBe(
      "abc-12345678"
    );
    // (Un CR/LF ni siquiera sale del cliente HTTP de Node; se prueba con marcado y exceso de largo.)
    for (const malicious of ["<script>alert(1)</script>", "a".repeat(500)]) {
      const res = await request(app).get("/health").set("X-Request-Id", malicious);
      expect(res.headers["x-request-id"]).not.toBe(malicious);
      expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("JSON mal formado es 400 y un cuerpo enorme es 413, no 500", async () => {
    const bad = await request(app).post("/api/auth/login").set("Content-Type", "application/json").send("{roto");
    expect(bad.status).toBe(400);
    const huge = await request(app)
      .post("/api/auth/login")
      .send({ email: "a@b.example", password: "x".repeat(200_000) });
    expect(huge.status).toBe(413);
  });

  it("una ruta inexistente es 404 JSON", async () => {
    const res = await request(app).get("/api/no-existe");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Ruta no encontrada");
  });
});
