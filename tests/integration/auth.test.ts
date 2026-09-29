import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  app,
  authHeader,
  createStaff,
  csrfHeader,
  freshIp,
  login,
  staffSession,
  TEST_PASSWORD,
  unique,
} from "../helpers";
import { prisma } from "../../src/config/prisma";
import { flushAudit } from "../../src/services/audit/audit.service";
import { REUSE_GRACE_MS } from "../../src/modules/auth/sessions.service";
import { sha256 } from "../../src/utils/hash";

function refreshWith(cookie: string, ip = freshIp()) {
  return request(app).post("/api/auth/refresh").set("X-Forwarded-For", ip).set("Cookie", cookie).set(csrfHeader);
}

function newCookieOf(res: request.Response): string {
  const raw = [res.headers["set-cookie"]].flat().find((c) => c?.startsWith("atencion_ia_refresh="));
  return raw!.split(";")[0]!;
}

describe("login", () => {
  it("devuelve el access token en el cuerpo y el refresh SOLO en una cookie httpOnly, SameSite=Strict, Path=/api/auth", async () => {
    const staff = await createStaff("agent");
    const { res } = await login(staff.email);

    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.staff).toMatchObject({ id: staff.id, role: "agent" });
    expect(JSON.stringify(res.body)).not.toMatch(/refresh|passwordHash|password_hash/i);

    const cookie = [res.headers["set-cookie"]].flat().find((c) => c?.startsWith("atencion_ia_refresh="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/auth/i);
  });

  it("acepta el correo con mayúsculas y espacios (se normaliza)", async () => {
    const staff = await createStaff("agent");
    const res = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", freshIp())
      .send({ email: `  ${staff.email.toUpperCase()} `, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
  });

  it("contraseña incorrecta, correo inexistente y cuenta desactivada responden igual (no revelan cuál es)", async () => {
    const staff = await createStaff("agent");
    const inactive = await createStaff("agent", { isActive: false });
    const attempts = await Promise.all([
      request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", freshIp())
        .send({ email: staff.email, password: "otra-clave-cualquiera" }),
      request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", freshIp())
        .send({ email: `nadie-${unique()}@test.example`, password: TEST_PASSWORD }),
      request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", freshIp())
        .send({ email: inactive.email, password: TEST_PASSWORD }),
    ]);
    for (const res of attempts) {
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Credenciales inválidas");
    }
  });

  it("valida el cuerpo con zod: campos faltantes o no declarados son 400 con detalle", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", freshIp())
      .send({ email: "no-es-un-correo", role: "admin" });
    expect(res.status).toBe(400);
    const fields = (res.body.details as { field: string }[]).map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(["body.email", "body.password"]));
    expect(JSON.stringify(res.body.details)).toContain("Campos no permitidos: role");
  });

  it("bloqueo progresivo POR CUENTA: tras 5 fallos, incluso la contraseña correcta recibe 429", async () => {
    const staff = await createStaff("agent");
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", freshIp()) // IPs distintas: el bloqueo es por cuenta, no por IP
        .send({ email: staff.email, password: `mala-${i}-xxxxxxx` });
      expect(res.status).toBe(401);
    }
    const locked = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", freshIp())
      .send({ email: staff.email, password: TEST_PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toMatch(/Intenta de nuevo en 1 minuto/);
  });

  it("rate limit POR IP: 10 fallos desde la misma IP (aunque sean cuentas distintas) → 429", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", ip)
        .send({ email: `x${i}-${unique()}@t.example`, password: "x" });
    }
    const res = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", ip)
      .send({ email: "y@t.example", password: "x" });
    expect(res.status).toBe(429);
  });

  it("la auditoría registra los fallos sin el correo intentado", async () => {
    const email = `auditoria-${unique()}@test.example`;
    await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", freshIp())
      .send({ email, password: "xxxxxxxxxxxx" });
    await flushAudit();
    const rows = await prisma.auditLog.findMany({
      where: { action: "auth.login_failure" },
      orderBy: { id: "desc" },
      take: 5,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(email);
    // La IP se guarda como HMAC (64 hex), nunca en claro.
    expect(rows[0]!.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("refresh token rotativo", () => {
  it("rota: entrega una cookie nueva y revoca la anterior; el access token nuevo funciona", async () => {
    const { cookie } = await staffSession("agent");
    const res = await refreshWith(cookie);
    expect(res.status).toBe(200);
    const next = newCookieOf(res);
    expect(next).not.toBe(cookie);

    const old = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(cookie.split("=")[1]!) } });
    expect(old).toMatchObject({ revokeReason: "rotated" });
    expect(old!.replacedById).not.toBeNull();

    const me = await request(app).get("/api/auth/me").set(authHeader(res.body.accessToken));
    expect(me.status).toBe(200);
  });

  it("dentro de la ventana de gracia, reusar el token recién rotado da 409 (carrera entre pestañas), sin cerrar la sesión", async () => {
    const { cookie } = await staffSession("agent");
    const first = await refreshWith(cookie);
    const second = await refreshWith(cookie);
    expect(second.status).toBe(409);
    // La cookie nueva sigue sirviendo.
    expect((await refreshWith(newCookieOf(first))).status).toBe(200);
  });

  it("REUTILIZACIÓN fuera de la gracia = robo: revoca toda la familia y la cookie nueva deja de servir", async () => {
    const { staff, cookie } = await staffSession("agent");
    const first = await refreshWith(cookie);
    const stolenLater = newCookieOf(first);
    // Simula que pasó la ventana de gracia desde la rotación.
    await prisma.refreshToken.update({
      where: { tokenHash: sha256(cookie.split("=")[1]!) },
      data: { revokedAt: new Date(Date.now() - REUSE_GRACE_MS - 1_000) },
    });

    const reuse = await refreshWith(cookie);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error).toMatch(/se cerró por seguridad/);
    expect((await refreshWith(stolenLater)).status).toBe(401);

    const active = await prisma.refreshToken.count({ where: { staffUserId: staff.id, revokedAt: null } });
    expect(active).toBe(0);
    await flushAudit();
    expect(await prisma.auditLog.count({ where: { action: "auth.refresh_reuse_detected", actorId: staff.id } })).toBe(
      1
    );
  });

  it("sin el encabezado anti-CSRF, /refresh y /logout responden 403", async () => {
    const { cookie } = await staffSession("agent");
    const res = await request(app).post("/api/auth/refresh").set("X-Forwarded-For", freshIp()).set("Cookie", cookie);
    expect(res.status).toBe(403);
    const logout = await request(app).post("/api/auth/logout").set("X-Forwarded-For", freshIp()).set("Cookie", cookie);
    expect(logout.status).toBe(403);
  });

  it("con un Origin no permitido, 403 aunque traiga el encabezado", async () => {
    const { cookie } = await staffSession("agent");
    const res = await refreshWith(cookie).set("Origin", "https://sitio-malicioso.example");
    expect(res.status).toBe(403);
  });

  it("un agente desactivado no puede renovar su sesión", async () => {
    const { staff, cookie } = await staffSession("agent");
    await prisma.staffUser.update({ where: { id: staff.id }, data: { isActive: false } });
    const res = await refreshWith(cookie);
    expect(res.status).toBe(401);
  });
});

describe("logout y /me", () => {
  it("logout revoca la sesión: el refresh deja de funcionar", async () => {
    const { cookie } = await staffSession("agent");
    const res = await request(app)
      .post("/api/auth/logout")
      .set("X-Forwarded-For", freshIp())
      .set("Cookie", cookie)
      .set(csrfHeader);
    expect(res.status).toBe(204);
    expect((await refreshWith(cookie)).status).toBe(401);
  });

  it("/me exige token y no expone el hash", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set(authHeader("no.es.un.jwt"))).status).toBe(401);
    const { token, staff } = await staffSession("admin");
    const me = await request(app).get("/api/auth/me").set(authHeader(token));
    expect(me.body).toMatchObject({ id: staff.id, role: "admin" });
    expect(me.body).not.toHaveProperty("passwordHash");
  });
});
