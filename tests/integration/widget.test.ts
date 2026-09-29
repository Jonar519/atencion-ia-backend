import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  app,
  authHeader,
  csrfHeader,
  freshIp,
  staffSession,
  widgetConversation,
  widgetHeader,
  widgetSession,
} from "../helpers";
import { prisma } from "../../src/config/prisma";
import { sha256 } from "../../src/utils/hash";

describe("sesión anónima del widget", () => {
  it("entrega un token opaco wgt_… y en la base solo guarda su hash", async () => {
    const { token, customerId } = await widgetSession("Ana");
    expect(token).toMatch(/^wgt_[\w-]{40,}$/);
    const session = await prisma.widgetSession.findFirstOrThrow({ where: { customerId } });
    expect(session.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(session)).not.toContain(token);
    expect(session.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("no acepta correo ni teléfono: no permite 'reclamar' la identidad de otro cliente", async () => {
    const res = await request(app)
      .post("/api/widget/sessions")
      .set("X-Forwarded-For", freshIp())
      .send({ displayName: "Ana", email: "victima@correo.example" });
    expect(res.status).toBe(400);
  });

  it("dos sesiones con el mismo nombre son clientes distintos", async () => {
    const a = await widgetSession("Carlos");
    const b = await widgetSession("Carlos");
    expect(a.customerId).not.toBe(b.customerId);
  });

  it("un token inválido, revocado o expirado es 401", async () => {
    expect((await request(app).get("/api/widget/conversations").set(widgetHeader("wgt_inventado"))).status).toBe(401);
    const { token, customerId } = await widgetSession();
    await prisma.widgetSession.updateMany({ where: { customerId }, data: { revokedAt: new Date() } });
    expect((await request(app).get("/api/widget/conversations").set(widgetHeader(token))).status).toBe(401);

    const other = await widgetSession();
    await prisma.widgetSession.updateMany({
      where: { customerId: other.customerId },
      data: { createdAt: new Date(Date.now() - 3 * 86_400_000), expiresAt: new Date(Date.now() - 1_000) },
    });
    expect((await request(app).get("/api/widget/conversations").set(widgetHeader(other.token))).status).toBe(401);
  });
});

describe("separación de identidades: cliente vs staff", () => {
  it("un token de cliente NO sirve en el panel de agentes", async () => {
    const { token } = await widgetSession();
    for (const path of ["/api/conversations", "/api/kb/articles", "/api/auth/me"]) {
      expect((await request(app).get(path).set(authHeader(token))).status).toBe(401);
    }
  });

  it("un token de agente NO sirve en el widget (no puede hacerse pasar por cliente)", async () => {
    const { token } = await staffSession("admin");
    expect((await request(app).get("/api/widget/conversations").set(widgetHeader(token))).status).toBe(401);
  });
});

describe("conversaciones del cliente", () => {
  it("limita las conversaciones abiertas a la vez (no se multiplica el cupo abriendo muchas)", async () => {
    const { token } = await widgetSession();
    for (let i = 0; i < 3; i++) await widgetConversation(token);
    const res = await request(app).post("/api/widget/conversations").set(widgetHeader(token)).send({});
    expect(res.status).toBe(409);
  });

  it("valida el mensaje con zod (vacío, demasiado largo, campos extra)", async () => {
    const { token } = await widgetSession();
    const id = await widgetConversation(token);
    const post = (body: object) =>
      request(app).post(`/api/widget/conversations/${id}/messages`).set(widgetHeader(token)).send(body);
    expect((await post({ content: "" })).status).toBe(400);
    expect((await post({ content: "x".repeat(2_001) })).status).toBe(400);
    expect((await post({ content: "hola", senderType: "agent" })).status).toBe(400);
  });

  it("crear sesiones está limitado por IP (20 por hora)", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await request(app).post("/api/widget/sessions").set("X-Forwarded-For", ip).send({})).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe("codificación del texto", () => {
  it("un cuerpo en Windows-1252 (no UTF-8) es 400 claro, no texto corrompido guardado en silencio", async () => {
    const { token } = await widgetSession();
    const id = await widgetConversation(token);
    // "bloqueé" en Windows-1252: la "é" es el byte 0xE9, inválido como UTF-8.
    const latin1 = Buffer.concat([Buffer.from('{"content":"bloque'), Buffer.from([0xe9]), Buffer.from('"}')]);
    const res = await request(app)
      .post(`/api/widget/conversations/${id}/messages`)
      .set(widgetHeader(token))
      .set("Content-Type", "application/json")
      // serialize: envía los bytes tal cual (sin él, supertest convierte el Buffer a JSON).
      .send({})
      .serialize(() => latin1 as unknown as string);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("UTF-8");
    expect(await prisma.message.count({ where: { conversationId: id } })).toBe(0);
  });
});

describe("sesión del widget en cookie httpOnly (navegador)", () => {
  async function browserSession() {
    const res = await request(app)
      .post("/api/widget/sessions")
      .set("X-Forwarded-For", freshIp())
      .set(csrfHeader)
      .send({ displayName: "Navegador" });
    const raw = [res.headers["set-cookie"]].flat().find((c) => c?.startsWith("atencion_ia_widget="))!;
    return { res, raw, cookie: raw.split(";")[0]! };
  }

  it("la cookie es httpOnly, SameSite=Strict y Path=/; al navegador NO se le devuelve el token", async () => {
    const { res, raw } = await browserSession();
    expect(res.status).toBe(201);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Path=\//i);
    expect(res.body).not.toHaveProperty("token");
    expect(JSON.stringify(res.body)).not.toContain("wgt_");
  });

  it("un cliente de API (sin el encabezado del navegador) sí recibe el token para usarlo como Bearer", async () => {
    const res = await request(app).post("/api/widget/sessions").set("X-Forwarded-For", freshIp()).send({});
    expect(res.body.token).toMatch(/^wgt_/);
  });

  it("con la cookie se puede leer (GET) sin más", async () => {
    const { cookie } = await browserSession();
    const res = await request(app).get("/api/widget/session").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ displayName: "Navegador" });
  });

  it("CSRF: una escritura autenticada SOLO con la cookie exige el encabezado anti-CSRF y un Origin permitido", async () => {
    const { cookie } = await browserSession();
    const sinHeader = await request(app).post("/api/widget/conversations").set("Cookie", cookie).send({});
    expect(sinHeader.status).toBe(403);
    const otroOrigen = await request(app)
      .post("/api/widget/conversations")
      .set("Cookie", cookie)
      .set(csrfHeader)
      .set("Origin", "https://sitio-malicioso.example")
      .send({});
    expect(otroOrigen.status).toBe(403);
    const ok = await request(app).post("/api/widget/conversations").set("Cookie", cookie).set(csrfHeader).send({});
    expect(ok.status).toBe(201);
  });

  it("terminar la sesión la revoca en la base y borra la cookie", async () => {
    const { cookie, res } = await browserSession();
    const end = await request(app).post("/api/widget/session/end").set("Cookie", cookie).set(csrfHeader);
    expect(end.status).toBe(204);
    expect([end.headers["set-cookie"]].flat().join()).toMatch(/atencion_ia_widget=;/);
    expect((await request(app).get("/api/widget/session").set("Cookie", cookie)).status).toBe(401);
    const session = await prisma.widgetSession.findFirstOrThrow({ where: { customerId: res.body.customerId } });
    expect(session.revokedAt).not.toBeNull();
  });
});
