import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, authHeader, createStaff, freshIp, login, staffSession, TEST_PASSWORD, unique } from "../helpers";
import { prisma } from "../../src/config/prisma";
import { passwordService } from "../../src/modules/auth/password.service";
import { totp } from "../../src/modules/auth/totp";
import { flushAudit } from "../../src/services/audit/audit.service";
import { INVALID_INVITATION } from "../../src/modules/staff/invitations.service";

/**
 * Bloque F2: alta de asesores SOLO por invitación. Cada test rompe (o intenta
 * romper) una regla: el enlace sirve una vez, vence, se invalida al reenviar
 * o cancelar, nunca llega al admin, y no hay otra forma de obtener una cuenta.
 */

/** La contraseña que elige la persona invitada (cumple la política). */
const CHOSEN = TEST_PASSWORD;

async function invite(adminToken: string, body: Record<string, unknown> = {}) {
  const email = `invitado-${unique()}@test.example`;
  const res = await request(app)
    .post("/api/staff/invitations")
    .set(authHeader(adminToken))
    .send({ name: "Persona Invitada", email, ...body });
  return { res, email: (body.email as string | undefined) ?? email };
}

/** El enlace del correo simulado (el token va en el fragmento: #/agente/invitacion?token=…). */
async function invitationLink(email: string) {
  const mail = await prisma.emailOutbox.findFirst({
    where: { toAddress: email, template: "invitation" },
    orderBy: { id: "desc" },
  });
  expect(mail, `no hay correo de invitación para ${email}`).not.toBeNull();
  expect(mail!.bodyText).toMatch(/#\/agente\/invitacion\?token=/);
  return decodeURIComponent(mail!.bodyText.match(/[?&]token=([^\s&]+)/)![1]!);
}

const inspect = (token: string) =>
  request(app).post("/api/auth/invitation").set("X-Forwarded-For", freshIp()).send({ token });

const accept = (token: string, password = CHOSEN) =>
  request(app).post("/api/auth/invitation/accept").set("X-Forwarded-For", freshIp()).send({ token, password });

describe("invitar (admin)", () => {
  it("crea una cuenta PENDIENTE (sin contraseña, inactiva) y el enlace va solo por correo, nunca en la respuesta", async () => {
    const admin = await staffSession("admin");
    const { res, email } = await invite(admin.token);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email, role: "agent", isActive: false, invitation: { expired: false } });
    expect(res.body).not.toHaveProperty("passwordHash");

    const token = await invitationLink(email);
    // Ni el token ni el enlace aparecen en NADA de lo que recibe el admin.
    expect(JSON.stringify(res.body)).not.toContain(token);
    const list = await request(app).get("/api/staff").set(authHeader(admin.token));
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(list.body.items.find((s: { email: string }) => s.email === email).invitation).toMatchObject({
      expired: false,
    });

    const stored = await prisma.staffUser.findUniqueOrThrow({ where: { email } });
    expect(stored.passwordHash).toBeNull();
    expect(stored.isActive).toBe(false);
    expect(stored.invitedById).toBe(admin.staff.id);
    await flushAudit();
    expect(await prisma.auditLog.count({ where: { action: "staff.invite", entityId: stored.id } })).toBe(1);
  });

  it("ya no existe crear una cuenta con contraseña fija: POST /api/staff es 404 y la invitación rechaza 'password'", async () => {
    const admin = await staffSession("admin");
    const old = await request(app)
      .post("/api/staff")
      .set(authHeader(admin.token))
      .send({ name: "Con Clave", email: `con-clave-${unique()}@test.example`, password: CHOSEN });
    expect(old.status).toBe(404);

    const { res } = await invite(admin.token, { password: CHOSEN });
    expect(res.status).toBe(400);
    expect(await prisma.staffUser.count({ where: { name: "Con Clave" } })).toBe(0);
  });

  it("un asesor no puede invitar, reenviar ni cancelar (403)", async () => {
    const admin = await staffSession("admin");
    const agent = await staffSession("agent");
    const { res } = await invite(admin.token);
    const id = res.body.id as string;
    expect((await invite(agent.token)).res.status).toBe(403);
    expect((await request(app).post(`/api/staff/${id}/invitation/resend`).set(authHeader(agent.token))).status).toBe(
      403
    );
    expect((await request(app).delete(`/api/staff/${id}/invitation`).set(authHeader(agent.token))).status).toBe(403);
  });

  it("un correo que ya tiene cuenta o invitación → 409 (solo lo ve el admin)", async () => {
    const admin = await staffSession("admin");
    const { email } = await invite(admin.token);
    expect((await invite(admin.token, { email })).res.status).toBe(409);
  });
});

describe("la cuenta pendiente no sirve para nada hasta completarla", () => {
  it("no puede iniciar sesión (mismo 401 que un correo inexistente) ni recibir un enlace de recuperación", async () => {
    const admin = await staffSession("admin");
    const { email } = await invite(admin.token);
    const res = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", freshIp())
      .send({ email, password: CHOSEN });
    const ghost = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", freshIp())
      .send({ email: `nadie-${unique()}@test.example`, password: CHOSEN });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(ghost.body);

    await request(app).post("/api/auth/forgot-password").set("X-Forwarded-For", freshIp()).send({ email });
    await passwordService.flush();
    expect(await prisma.emailOutbox.count({ where: { toAddress: email, template: "password_reset" } })).toBe(0);
  });

  it("no se activa ni se anonimiza por la gestión normal (409): se completa o se cancela", async () => {
    const admin = await staffSession("admin");
    const { res } = await invite(admin.token);
    const id = res.body.id as string;
    const activate = await request(app).patch(`/api/staff/${id}`).set(authHeader(admin.token)).send({ isActive: true });
    expect(activate.status).toBe(409);
    expect((await request(app).post(`/api/staff/${id}/anonymize`).set(authHeader(admin.token))).status).toBe(409);
    expect((await prisma.staffUser.findUniqueOrThrow({ where: { id } })).isActive).toBe(false);
  });
});

describe("completar la cuenta con el enlace", () => {
  it("ver la invitación: nombre, correo, rol y si pedirá MFA", async () => {
    const admin = await staffSession("admin");
    const { email } = await invite(admin.token, { role: "admin" });
    const res = await inspect(await invitationLink(email));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: "Persona Invitada", email, role: "admin", mfaRequired: true });
  });

  it("asesor: elige su contraseña, queda activo con sesión, y luego entra con ella", async () => {
    const admin = await staffSession("admin");
    const { email } = await invite(admin.token);
    const res = await accept(await invitationLink(email));
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.staff).toMatchObject({ email, role: "agent" });
    expect([res.headers["set-cookie"]].flat().some((c) => c?.startsWith("atencion_ia_refresh="))).toBe(true);

    const stored = await prisma.staffUser.findUniqueOrThrow({ where: { email } });
    expect(stored.isActive).toBe(true);
    expect(stored.activatedAt).not.toBeNull();
    expect(stored.passwordHash).not.toBeNull();
    // El enlace quedó CONSUMIDO en la base (no solo "inútil" porque la cuenta ya tiene contraseña).
    expect(
      await prisma.staffToken.count({ where: { staffUserId: stored.id, purpose: "invitation", usedAt: null } })
    ).toBe(0);
    expect((await login(email, CHOSEN)).token).toEqual(expect.any(String));
  });

  it("una contraseña que no cumple la política NO gasta el enlace", async () => {
    const admin = await staffSession("admin");
    const { email } = await invite(admin.token);
    const token = await invitationLink(email);
    const weak = await accept(token, "corta");
    expect(weak.status).toBe(400);
    expect(weak.body.error).toBe("La contraseña no cumple la política");
    expect((await accept(token)).status).toBe(200);
  });

  it("administrador: al completar NO hay sesión hasta activar la verificación en dos pasos", async () => {
    const admin = await staffSession("admin");
    const { email } = await invite(admin.token, { role: "admin" });
    const res = await accept(await invitationLink(email));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mfaEnrollmentRequired: true, enrollmentToken: expect.any(String) });
    expect(res.headers["set-cookie"]).toBeUndefined();

    const start = await request(app)
      .post("/api/auth/mfa/enroll/start")
      .set("X-Forwarded-For", freshIp())
      .send({ enrollmentToken: res.body.enrollmentToken });
    const ok = await request(app)
      .post("/api/auth/mfa/enroll/confirm")
      .set("X-Forwarded-For", freshIp())
      .send({ enrollmentToken: res.body.enrollmentToken, code: totp(start.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toEqual(expect.any(String));
    expect((await prisma.staffUser.findUniqueOrThrow({ where: { email } })).mfaEnabledAt).not.toBeNull();
  });
});

describe("el enlace es de un solo uso, vence y no revela nada", () => {
  it("un enlace YA USADO no sirve otra vez (ni para ver ni para completar), con el mismo mensaje", async () => {
    const admin = await staffSession("admin");
    const { email } = await invite(admin.token);
    const token = await invitationLink(email);
    expect((await accept(token)).status).toBe(200);
    const again = await accept(token, "Otra-Distinta-Para-Cambiarla-2026");
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: INVALID_INVITATION });
    expect((await inspect(token)).body).toEqual({ error: INVALID_INVITATION });
    // La contraseña sigue siendo la que eligió la persona.
    expect((await login(email, CHOSEN)).token).toEqual(expect.any(String));
  });

  it("dos envíos simultáneos del mismo enlace: exactamente uno completa la cuenta", async () => {
    const admin = await staffSession("admin");
    const { email } = await invite(admin.token);
    const token = await invitationLink(email);
    const results = await Promise.all([accept(token), accept(token), accept(token)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
  });

  it("un enlace VENCIDO no sirve", async () => {
    const admin = await staffSession("admin");
    const { email } = await invite(admin.token);
    const token = await invitationLink(email);
    const staff = await prisma.staffUser.findUniqueOrThrow({ where: { email } });
    // Como si se hubiera emitido hace 4 días (el CHECK de la base exige vida ≤ 72 h).
    await prisma.$executeRaw`
      UPDATE staff_tokens SET created_at = now() - interval '4 days', expires_at = now() - interval '1 day'
      WHERE staff_user_id = ${staff.id}::uuid AND purpose = 'invitation'`;
    expect((await inspect(token)).body).toEqual({ error: INVALID_INVITATION });
    const res = await accept(token);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: INVALID_INVITATION });
    expect((await prisma.staffUser.findUniqueOrThrow({ where: { email } })).passwordHash).toBeNull();
    const list = await request(app).get("/api/staff").set(authHeader(admin.token));
    expect(list.body.items.find((s: { email: string }) => s.email === email).invitation.expired).toBe(true);
  });

  it("enlaces inventados, mal copiados o vacíos reciben EXACTAMENTE la misma respuesta", async () => {
    const bodies = await Promise.all(
      ["x".repeat(43), "abc", "%%%", "A".repeat(100)].map(async (token) => (await accept(token)).body)
    );
    for (const body of bodies) expect(body).toEqual({ error: INVALID_INVITATION });
    expect((await inspect("x".repeat(43))).body).toEqual({ error: INVALID_INVITATION });
  });

  it("no se completa una cuenta sin el token de INVITACIÓN (otro token o ninguno no sirven)", async () => {
    const admin = await staffSession("admin");
    const { email } = await invite(admin.token);
    const missing = await request(app)
      .post("/api/auth/invitation/accept")
      .set("X-Forwarded-For", freshIp())
      .send({ password: CHOSEN });
    expect(missing.status).toBe(400);
    // Un enlace de recuperación de OTRA cuenta (otro propósito) no completa la invitación.
    const other = await createStaff("agent");
    await request(app).post("/api/auth/forgot-password").set("X-Forwarded-For", freshIp()).send({ email: other.email });
    await passwordService.flush();
    const mail = await prisma.emailOutbox.findFirstOrThrow({
      where: { toAddress: other.email, template: "password_reset" },
      orderBy: { id: "desc" },
    });
    const resetToken = decodeURIComponent(mail.bodyText.match(/[?&]token=([^\s&]+)/)![1]!);
    expect((await accept(resetToken)).body).toEqual({ error: INVALID_INVITATION });
    expect((await prisma.staffUser.findUniqueOrThrow({ where: { email } })).passwordHash).toBeNull();
  });
});

describe("reenviar y cancelar (admin)", () => {
  it("reenviar emite un enlace NUEVO y el anterior deja de servir", async () => {
    const admin = await staffSession("admin");
    const { res, email } = await invite(admin.token);
    const first = await invitationLink(email);
    const resend = await request(app).post(`/api/staff/${res.body.id}/invitation/resend`).set(authHeader(admin.token));
    expect(resend.status).toBe(200);
    const second = await invitationLink(email);
    expect(second).not.toBe(first);
    expect(JSON.stringify(resend.body)).not.toContain(second);
    expect((await accept(first)).body).toEqual({ error: INVALID_INVITATION });
    expect((await accept(second)).status).toBe(200);
  });

  it("cancelar borra la cuenta pendiente y su enlace deja de servir; no se cancela una cuenta en uso", async () => {
    const admin = await staffSession("admin");
    const { res, email } = await invite(admin.token);
    const token = await invitationLink(email);
    const cancel = await request(app).delete(`/api/staff/${res.body.id}/invitation`).set(authHeader(admin.token));
    expect(cancel.status).toBe(204);
    expect(await prisma.staffUser.count({ where: { email } })).toBe(0);
    expect((await accept(token)).body).toEqual({ error: INVALID_INVITATION });

    const active = await createStaff("agent");
    expect((await request(app).delete(`/api/staff/${active.id}/invitation`).set(authHeader(admin.token))).status).toBe(
      409
    );
    expect(
      (await request(app).post(`/api/staff/${active.id}/invitation/resend`).set(authHeader(admin.token))).status
    ).toBe(409);
  });
});
