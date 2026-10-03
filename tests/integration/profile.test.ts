import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import {
  app,
  authHeader,
  createConversation,
  createStaff,
  csrfHeader,
  freshIp,
  login,
  staffSession,
  TEST_PASSWORD,
  unique,
} from "../helpers";
import { prisma } from "../../src/config/prisma";
import { setStorageForTests, type StorageProvider } from "../../src/services/storage";
import { flushAudit } from "../../src/services/audit/audit.service";

// Almacenamiento en memoria: los tests no escriben archivos en disco.
const files = new Map<string, { data: Buffer; contentType: string }>();
const memoryStorage: StorageProvider = {
  provider: "local",
  async put(key, data, contentType) {
    files.set(key, { data, contentType });
  },
  async get(key) {
    return files.get(key) ?? null;
  },
  async delete(key) {
    files.delete(key);
  },
};
beforeAll(() => setStorageForTests(memoryStorage));
afterAll(() => setStorageForTests(null));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const NEW_PASSWORD = "Otra-Llave-Muy-Distinta-2026";

function refreshWith(cookie: string) {
  return request(app).post("/api/auth/refresh").set("X-Forwarded-For", freshIp()).set("Cookie", cookie).set(csrfHeader);
}

async function lastEmailTo(to: string, template: string) {
  return prisma.emailOutbox.findFirst({ where: { toAddress: to, template }, orderBy: { id: "desc" } });
}

describe("perfil propio", () => {
  it("GET devuelve el perfil sin secretos (ni hash, ni secreto MFA, ni clave del avatar)", async () => {
    const { token, staff } = await staffSession("agent");
    const res = await request(app).get("/api/profile").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: staff.id, mfaEnabled: false, hasAvatar: false });
    // El tema lo decide el sistema operativo (019): no hay preferencia guardada que devolver.
    expect(res.body).not.toHaveProperty("theme");
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|mfaSecret|avatarStorageKey|mfaLastUsedStep/);
    // /auth/me devuelve lo mismo (el frontend lo usa al recargar).
    const me = await request(app).get("/api/auth/me").set(authHeader(token));
    expect(me.body).toEqual(res.body);
  });

  it("PATCH cambia nombre y teléfono; valida el teléfono y rechaza campos no permitidos (incluido el tema)", async () => {
    const { token } = await staffSession("agent");
    const ok = await request(app)
      .patch("/api/profile")
      .set(authHeader(token))
      .send({ name: "Ana Pérez", phone: "+57 300 123 4567" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ name: "Ana Pérez", phone: "+57 300 123 4567" });
    const cleared = await request(app).patch("/api/profile").set(authHeader(token)).send({ phone: "" });
    expect(cleared.body.phone).toBeNull();
    // { theme: "dark" } ERA válido: desde la 019 el tema no se elige, así que también es un 400.
    for (const body of [{ phone: "llámame" }, { theme: "dark" }, { role: "admin" }, { email: "x@y.example" }, {}]) {
      expect(
        (await request(app).patch("/api/profile").set(authHeader(token)).send(body)).status,
        JSON.stringify(body)
      ).toBe(400);
    }
    expect((await prisma.staffUser.findFirstOrThrow({ where: { name: "Ana Pérez" } })).role).toBe("agent");
  });

  it("sin token → 401", async () => {
    expect((await request(app).get("/api/profile")).status).toBe(401);
  });
});

describe("cambio de correo (re-verificación)", () => {
  it("exige la contraseña actual; manda enlace al correo NUEVO y aviso al ANTERIOR; aplica solo al confirmar", async () => {
    const { token, staff } = await staffSession("agent");
    const newEmail = `nuevo-${unique()}@test.example`;
    const wrong = await request(app)
      .post("/api/profile/email")
      .set(authHeader(token))
      .send({ newEmail, currentPassword: "no-es-la-clave-xx" });
    expect(wrong.status).toBe(400);

    const res = await request(app)
      .post("/api/profile/email")
      .set(authHeader(token))
      .send({ newEmail, currentPassword: TEST_PASSWORD });
    expect(res.status).toBe(202);
    // Aún no cambió.
    expect((await prisma.staffUser.findUniqueOrThrow({ where: { id: staff.id } })).email).toBe(staff.email);
    expect(await lastEmailTo(staff.email, "email_change_notice")).not.toBeNull();
    const verifyMail = await lastEmailTo(newEmail, "email_change_verify");
    const token2 = decodeURIComponent(verifyMail!.bodyText.match(/token=([^\s&]+)/)![1]!);

    const confirm = await request(app)
      .post("/api/auth/confirm-email")
      .set("X-Forwarded-For", freshIp())
      .send({ token: token2 });
    expect(confirm.status).toBe(200);
    expect((await prisma.staffUser.findUniqueOrThrow({ where: { id: staff.id } })).email).toBe(newEmail);
    await login(newEmail);
    // Un solo uso.
    const again = await request(app)
      .post("/api/auth/confirm-email")
      .set("X-Forwarded-For", freshIp())
      .send({ token: token2 });
    expect(again.status).toBe(400);
  });

  it("un correo que ya usa otra cuenta: misma respuesta 202, pero no se envía nada (no revela cuentas)", async () => {
    const other = await createStaff("agent");
    const { token } = await staffSession("agent");
    const before = await prisma.emailOutbox.count({ where: { toAddress: other.email } });
    const res = await request(app)
      .post("/api/profile/email")
      .set(authHeader(token))
      .send({ newEmail: other.email, currentPassword: TEST_PASSWORD });
    expect(res.status).toBe(202);
    expect(await prisma.emailOutbox.count({ where: { toAddress: other.email } })).toBe(before);
  });
});

describe("cambio de contraseña", () => {
  it("pide la actual, aplica la política, y cierra las DEMÁS sesiones (la actual sigue)", async () => {
    const staff = await createStaff("agent");
    const other = await login(staff.email);
    const current = await login(staff.email);

    const wrong = await request(app)
      .post("/api/profile/password")
      .set(authHeader(current.token))
      .send({ currentPassword: "no-es-la-clave-xx", newPassword: NEW_PASSWORD });
    expect(wrong.status).toBe(400);
    const weak = await request(app)
      .post("/api/profile/password")
      .set(authHeader(current.token))
      .send({ currentPassword: TEST_PASSWORD, newPassword: "password1234" });
    expect(weak.status).toBe(400);
    const same = await request(app)
      .post("/api/profile/password")
      .set(authHeader(current.token))
      .send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD });
    expect(same.status).toBe(400);

    const ok = await request(app)
      .post("/api/profile/password")
      .set(authHeader(current.token))
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.otherSessionsClosed).toBe(1);
    expect((await refreshWith(other.cookie)).status).toBe(401);
    expect((await refreshWith(current.cookie)).status).toBe(200);
    expect(await lastEmailTo(staff.email, "password_changed")).not.toBeNull();
    await login(staff.email, NEW_PASSWORD);
  });
});

describe("sesiones activas", () => {
  it("lista cada dispositivo con IP TRUNCADA, ubicación aproximada y cuál es la actual", async () => {
    const staff = await createStaff("agent");
    await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "192.0.2.77")
      .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0) Firefox/130.0")
      .send({ email: staff.email, password: TEST_PASSWORD });
    const current = await login(staff.email);

    const res = await request(app).get("/api/profile/sessions").set(authHeader(current.token));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const bogota = res.body.items.find((s: { ipAddress: string }) => s.ipAddress === "192.0.2.0");
    expect(bogota).toMatchObject({
      location: "Bogotá, Colombia",
      locationIsApproximate: true,
      current: false,
      userAgent: expect.stringContaining("Firefox"),
    });
    expect(res.body.items.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    // Nunca la IP completa en la base.
    expect(await prisma.refreshToken.count({ where: { staffUserId: staff.id, ipAddress: "192.0.2.77" } })).toBe(0);
  });

  it("cerrar sesión en los demás dispositivos deja solo la actual", async () => {
    const staff = await createStaff("agent");
    const a = await login(staff.email);
    const b = await login(staff.email);
    const current = await login(staff.email);
    const res = await request(app).post("/api/profile/sessions/revoke-others").set(authHeader(current.token));
    expect(res.body).toEqual({ closed: 2 });
    expect((await refreshWith(a.cookie)).status).toBe(401);
    expect((await refreshWith(b.cookie)).status).toBe(401);
    const list = await request(app).get("/api/profile/sessions").set(authHeader(current.token));
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].current).toBe(true);
  });

  it("cerrar UNA sesión propia; la de otra persona responde 404 (no se revela que existe)", async () => {
    const staff = await createStaff("agent");
    const other = await login(staff.email);
    const current = await login(staff.email);
    const stranger = await staffSession("agent");
    const list = await request(app).get("/api/profile/sessions").set(authHeader(current.token));
    const otherId = list.body.items.find((s: { current: boolean }) => !s.current).id as string;

    const foreign = await request(app).delete(`/api/profile/sessions/${otherId}`).set(authHeader(stranger.token));
    expect(foreign.status).toBe(404);
    expect((await refreshWith(other.cookie)).status).toBe(200);

    const own = await request(app).delete(`/api/profile/sessions/${otherId}`).set(authHeader(current.token));
    expect(own.status).toBe(204);
    const after = await request(app).get("/api/profile/sessions").set(authHeader(current.token));
    expect(after.body.items.map((s: { id: string }) => s.id)).not.toContain(otherId);
  });

  it("el refresh conserva la sesión (mismo id) y actualiza desde dónde se usó por última vez", async () => {
    const staff = await createStaff("agent");
    const first = await login(staff.email);
    const refreshed = await request(app)
      .post("/api/auth/refresh")
      .set("X-Forwarded-For", "198.51.100.20")
      .set("Cookie", first.cookie)
      .set(csrfHeader);
    expect(refreshed.status).toBe(200);
    const list = await request(app).get("/api/profile/sessions").set(authHeader(refreshed.body.accessToken));
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      current: true,
      ipAddress: "198.51.100.0",
      location: "Medellín, Colombia",
    });
  });
});

describe("avatar", () => {
  it("sube un PNG, lo ven los compañeros, y reemplazarlo borra el archivo anterior", async () => {
    const { token, staff } = await staffSession("agent");
    const colleague = await staffSession("agent");
    const res = await request(app)
      .put("/api/profile/avatar")
      .set(authHeader(token))
      .set("Content-Type", "image/png")
      .send(PNG);
    expect(res.status).toBe(200);
    expect(res.body.hasAvatar).toBe(true);
    const firstKey = (await prisma.staffUser.findUniqueOrThrow({ where: { id: staff.id } })).avatarStorageKey!;
    expect(firstKey).toMatch(new RegExp(`^avatars/${staff.id}-[0-9a-f]{8}\\.png$`));

    const seen = await request(app).get(`/api/staff/${staff.id}/avatar`).set(authHeader(colleague.token)).buffer(true);
    expect(seen.status).toBe(200);
    expect(seen.headers["content-type"]).toBe("image/png");
    expect(seen.headers["content-security-policy"]).toContain("sandbox");
    expect(Buffer.from(seen.body).equals(PNG)).toBe(true);

    await request(app).put("/api/profile/avatar").set(authHeader(token)).set("Content-Type", "image/png").send(PNG);
    expect(files.has(firstKey)).toBe(false);

    const removed = await request(app).delete("/api/profile/avatar").set(authHeader(token));
    expect(removed.body.hasAvatar).toBe(false);
    expect((await request(app).get(`/api/staff/${staff.id}/avatar`).set(authHeader(colleague.token))).status).toBe(404);
  });

  it("rechaza un SVG/HTML disfrazado de PNG (bytes mágicos), otro Content-Type y más de 300 KB", async () => {
    const { token } = await staffSession("agent");
    const svg = await request(app)
      .put("/api/profile/avatar")
      .set(authHeader(token))
      .set("Content-Type", "image/png")
      .send(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'));
    expect(svg.status).toBe(415);
    const textType = await request(app)
      .put("/api/profile/avatar")
      .set(authHeader(token))
      .set("Content-Type", "text/plain")
      .send("hola");
    expect(textType.status).toBe(415);
    const big = await request(app)
      .put("/api/profile/avatar")
      .set(authHeader(token))
      .set("Content-Type", "image/png")
      .send(Buffer.concat([PNG, Buffer.alloc(300 * 1024)]));
    expect(big.status).toBe(413);
  });
});

describe("exportar datos", () => {
  it("el propio agente descarga su JSON: perfil, sesiones y actividad, sin secretos ni datos de clientes", async () => {
    const { token, staff } = await staffSession("agent");
    await createConversation("agent_active", staff.id);
    await flushAudit();
    const res = await request(app).get("/api/profile/export").set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
    expect(res.body).toMatchObject({
      format: "atencion-ia/staff-export@1",
      profile: { id: staff.id, email: staff.email },
      conversationsHandled: [expect.objectContaining({ status: "agent_active" })],
    });
    expect(res.body.sessions.length).toBeGreaterThan(0);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/passwordHash|password_hash|tokenHash|token_hash|mfaSecret|codeHash/);
    // Sin el contenido de las conversaciones (pertenece al cliente).
    expect(text).not.toContain("necesito ayuda con mi tarjeta");
  });

  it("un admin exporta los datos de un agente; un agente no puede exportar los de otro", async () => {
    const admin = await staffSession("admin");
    const agent = await staffSession("agent");
    const other = await staffSession("agent");
    expect((await request(app).get(`/api/staff/${agent.staff.id}/export`).set(authHeader(admin.token))).status).toBe(
      200
    );
    expect((await request(app).get(`/api/staff/${agent.staff.id}/export`).set(authHeader(other.token))).status).toBe(
      403
    );
  });
});

describe("reasignar y eliminar (anonimizar) la cuenta de un agente", () => {
  it("con casos en curso → 409 con el detalle; tras reasignarlos, se anonimiza y ya no puede entrar", async () => {
    const admin = await staffSession("admin");
    const leaving = await staffSession("agent");
    const receiver = await staffSession("agent");
    const { conversation } = await createConversation("agent_active", leaving.staff.id);
    await request(app)
      .put("/api/profile/avatar")
      .set(authHeader(leaving.token))
      .set("Content-Type", "image/png")
      .send(PNG);

    const blocked = await request(app).post(`/api/staff/${leaving.staff.id}/anonymize`).set(authHeader(admin.token));
    expect(blocked.status).toBe(409);
    expect(blocked.body.details).toEqual({ activeConversations: 1, activeCalls: 0 });

    const moved = await request(app)
      .post(`/api/conversations/${conversation.id}/reassign`)
      .set(authHeader(admin.token))
      .send({ agentId: receiver.staff.id });
    expect(moved.status).toBe(200);
    expect(moved.body.assignedAgent.id).toBe(receiver.staff.id);
    const escalation = await prisma.escalation.findFirstOrThrow({ where: { conversationId: conversation.id } });
    expect(escalation.assignedAgentId).toBe(receiver.staff.id);
    const note = await prisma.message.findFirst({
      where: { conversationId: conversation.id, senderType: "system" },
      orderBy: { createdAt: "desc" },
    });
    expect(note!.content).toMatch(/continúa con la conversación/);

    const avatarKey = (await prisma.staffUser.findUniqueOrThrow({ where: { id: leaving.staff.id } })).avatarStorageKey!;
    const res = await request(app).post(`/api/staff/${leaving.staff.id}/anonymize`).set(authHeader(admin.token));
    expect(res.status).toBe(200);
    const after = await prisma.staffUser.findUniqueOrThrow({ where: { id: leaving.staff.id } });
    expect(after).toMatchObject({
      isActive: false,
      phone: null,
      avatarStorageKey: null,
      mfaSecretEncrypted: null,
      availability: "offline",
    });
    expect(after.email).toMatch(/@anonimizado\.invalid$/);
    expect(after.name).toMatch(/^Agente eliminado/);
    expect(after.deletedAt).not.toBeNull();
    expect(files.has(avatarKey)).toBe(false);
    // Sus sesiones se cerraron y ya no guardan desde dónde se conectaba.
    expect((await refreshWith(leaving.cookie)).status).toBe(401);
    const tokens = await prisma.refreshToken.findMany({ where: { staffUserId: leaving.staff.id } });
    expect(tokens.every((t) => t.revokedAt && t.ipAddress === null && t.userAgent === null)).toBe(true);
    // Ni con su correo viejo ni con el nuevo.
    for (const email of [leaving.staff.email, after.email]) {
      const attempt = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", freshIp())
        .send({ email, password: TEST_PASSWORD });
      expect(attempt.status).toBe(401);
    }
    // Es definitivo: no se reactiva.
    const reactivate = await request(app)
      .patch(`/api/staff/${leaving.staff.id}`)
      .set(authHeader(admin.token))
      .send({ isActive: true });
    expect(reactivate.status).toBe(409);
    // Los mensajes que envió siguen (registro del banco), ahora con el nombre anonimizado.
    expect(await prisma.staffUser.count({ where: { id: leaving.staff.id } })).toBe(1);
  });

  it("solo cuentas de agente, nunca la propia, y solo un admin", async () => {
    const admin = await staffSession("admin");
    const otherAdmin = await createStaff("admin");
    const agent = await staffSession("agent");
    const victim = await createStaff("agent");
    expect((await request(app).post(`/api/staff/${otherAdmin.id}/anonymize`).set(authHeader(admin.token))).status).toBe(
      409
    );
    expect(
      (await request(app).post(`/api/staff/${admin.staff.id}/anonymize`).set(authHeader(admin.token))).status
    ).toBe(409);
    expect((await request(app).post(`/api/staff/${victim.id}/anonymize`).set(authHeader(agent.token))).status).toBe(
      403
    );
    expect((await prisma.staffUser.findUniqueOrThrow({ where: { id: victim.id } })).deletedAt).toBeNull();
  });

  it("reasignar: solo admin, solo casos atendidos, respeta el máximo del destino y rechaza destinos inactivos", async () => {
    const admin = await staffSession("admin");
    const owner = await staffSession("agent");
    const full = await createStaff("agent", { maxConcurrent: 1 });
    const inactive = await createStaff("agent", { isActive: false });
    await createConversation("agent_active", full.id);
    const { conversation } = await createConversation("agent_active", owner.staff.id);
    const queued = await createConversation("waiting_agent");
    const send = (token: string, id: string, agentId: string) =>
      request(app).post(`/api/conversations/${id}/reassign`).set(authHeader(token)).send({ agentId });

    expect((await send(owner.token, conversation.id, full.id)).status).toBe(403);
    expect((await send(admin.token, conversation.id, full.id)).status).toBe(409);
    expect((await send(admin.token, conversation.id, inactive.id)).status).toBe(409);
    expect((await send(admin.token, conversation.id, owner.staff.id)).status).toBe(409);
    expect((await send(admin.token, queued.conversation.id, full.id)).status).toBe(409);
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).assignedAgentId).toBe(
      owner.staff.id
    );
  });
});
