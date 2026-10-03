import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  app,
  createStaff,
  csrfHeader,
  freshIp,
  login,
  staffSession,
  TEST_PASSWORD,
  unique,
  authHeader,
} from "../helpers";
import { prisma } from "../../src/config/prisma";
import { sha256 } from "../../src/utils/hash";
import { passwordService, RESET_REQUESTED } from "../../src/modules/auth/password.service";
import { totp } from "../../src/modules/auth/totp";
import { decryptSecret } from "../../src/modules/auth/mfaCrypto";
import { mfaService } from "../../src/modules/auth/mfa.service";

const NEW_PASSWORD = "Otra-Llave-Muy-Distinta-2026";

async function lastEmailTo(to: string, template?: string) {
  return prisma.emailOutbox.findFirst({
    where: { toAddress: to, ...(template ? { template } : {}) },
    orderBy: { id: "desc" },
  });
}

/** Token del enlace del correo simulado (va en el fragmento: #/agente/...?token=...). */
function tokenFrom(body: string): string {
  return decodeURIComponent(body.match(/[?&]token=([^\s&]+)/)![1]!);
}

async function forgot(email: string) {
  const res = await request(app).post("/api/auth/forgot-password").set("X-Forwarded-For", freshIp()).send({ email });
  await passwordService.flush();
  return res;
}

function reset(token: string, password = NEW_PASSWORD) {
  return request(app).post("/api/auth/reset-password").set("X-Forwarded-For", freshIp()).send({ token, password });
}

function rawLogin(email: string, password = TEST_PASSWORD, ip = freshIp()) {
  return request(app).post("/api/auth/login").set("X-Forwarded-For", ip).send({ email, password });
}

function verify(challengeToken: string, code: string, ip = freshIp()) {
  return request(app).post("/api/auth/mfa/verify").set("X-Forwarded-For", ip).send({ challengeToken, code });
}

function refreshWith(cookie: string) {
  return request(app).post("/api/auth/refresh").set("X-Forwarded-For", freshIp()).set("Cookie", cookie).set(csrfHeader);
}

describe("recuperar la contraseña", () => {
  it("responde IGUAL (202, mismo cuerpo) para un correo existente, uno inexistente y una cuenta desactivada", async () => {
    const staff = await createStaff("agent");
    const inactive = await createStaff("agent", { isActive: false });
    const ghost = `nadie-${unique()}@test.example`;
    const responses = [await forgot(staff.email), await forgot(ghost), await forgot(inactive.email)];
    for (const res of responses) {
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ message: RESET_REQUESTED });
    }
    // Solo la cuenta activa recibe el correo.
    expect(await lastEmailTo(staff.email, "password_reset")).not.toBeNull();
    expect(await lastEmailTo(ghost)).toBeNull();
    expect(await lastEmailTo(inactive.email)).toBeNull();
  });

  it("en la base queda SOLO el hash del token (el del enlace no aparece en claro)", async () => {
    const staff = await createStaff("agent");
    await forgot(staff.email);
    const token = tokenFrom((await lastEmailTo(staff.email, "password_reset"))!.bodyText);
    const rows = await prisma.staffToken.findMany({ where: { staffUserId: staff.id, purpose: "password_reset" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    // Vence a los 15 minutos (reloj de la base).
    expect(rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime()).toBe(15 * 60_000);
  });

  it("restablece: la contraseña vieja deja de servir, se cierran TODAS las sesiones y llega un aviso", async () => {
    const { staff, cookie } = await staffSession("agent");
    await forgot(staff.email);
    const token = tokenFrom((await lastEmailTo(staff.email, "password_reset"))!.bodyText);
    const res = await reset(token);
    expect(res.status).toBe(200);
    expect((await rawLogin(staff.email)).status).toBe(401);
    expect((await rawLogin(staff.email, NEW_PASSWORD)).status).toBe(200);
    expect((await refreshWith(cookie)).status).toBe(401);
    const revoked = await prisma.refreshToken.findFirst({
      where: { staffUserId: staff.id, revokeReason: "password_reset" },
    });
    expect(revoked).not.toBeNull();
    expect(await lastEmailTo(staff.email, "password_changed")).not.toBeNull();
  });

  it("el enlace sirve UNA sola vez", async () => {
    const staff = await createStaff("agent");
    await forgot(staff.email);
    const token = tokenFrom((await lastEmailTo(staff.email, "password_reset"))!.bodyText);
    expect((await reset(token)).status).toBe(200);
    const again = await reset(token, "Tercera-Llave-Distinta-2026");
    expect(again.status).toBe(400);
    expect((await rawLogin(staff.email, NEW_PASSWORD)).status).toBe(200);
  });

  it("dos usos SIMULTÁNEOS del mismo enlace: solo uno gana", async () => {
    const staff = await createStaff("agent");
    await forgot(staff.email);
    const token = tokenFrom((await lastEmailTo(staff.email, "password_reset"))!.bodyText);
    const results = await Promise.all([
      reset(token, "Primera-Carrera-Llave-2026"),
      reset(token, "Segunda-Carrera-Llave-2026"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it("un enlace vencido no sirve", async () => {
    const staff = await createStaff("agent");
    await forgot(staff.email);
    const token = tokenFrom((await lastEmailTo(staff.email, "password_reset"))!.bodyText);
    await prisma.$executeRaw`
      UPDATE staff_tokens SET created_at = now() - interval '16 minutes', expires_at = now() - interval '1 minute'
      WHERE token_hash = ${sha256(token)}`;
    expect((await reset(token)).status).toBe(400);
  });

  it("pedir otro enlace invalida el anterior", async () => {
    const staff = await createStaff("agent");
    await forgot(staff.email);
    const first = tokenFrom((await lastEmailTo(staff.email, "password_reset"))!.bodyText);
    await forgot(staff.email);
    const second = tokenFrom((await lastEmailTo(staff.email, "password_reset"))!.bodyText);
    expect(first).not.toBe(second);
    expect((await reset(first)).status).toBe(400);
    expect((await reset(second)).status).toBe(200);
  });

  it("una contraseña que no cumple la política se rechaza SIN gastar el enlace", async () => {
    const staff = await createStaff("agent");
    await forgot(staff.email);
    const token = tokenFrom((await lastEmailTo(staff.email, "password_reset"))!.bodyText);
    const weak = await reset(token, "corta");
    expect(weak.status).toBe(400);
    expect(weak.body.details).toEqual(expect.arrayContaining([expect.stringMatching(/al menos 12/)]));
    expect((await reset(token)).status).toBe(200);
  });

  it("un token de otro propósito (desafío de MFA) no sirve para restablecer", async () => {
    const staff = await createStaff("agent", { mfa: true });
    const res = await rawLogin(staff.email);
    expect(res.body.mfaRequired).toBe(true);
    expect((await reset(res.body.challengeToken)).status).toBe(400);
  });

  it("restablecer limpia el bloqueo por intentos fallidos, pero NO desactiva el MFA", async () => {
    const staff = await createStaff("admin");
    for (let i = 0; i < 6; i++) await rawLogin(staff.email, `mala-${i}-xxxxxxxxx`);
    expect((await rawLogin(staff.email)).status).toBe(429);
    await forgot(staff.email);
    await reset(tokenFrom((await lastEmailTo(staff.email, "password_reset"))!.bodyText));
    const res = await rawLogin(staff.email, NEW_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mfaRequired: true, challengeToken: expect.any(String) });
  });
});

describe("verificación en dos pasos en el login", () => {
  it("con MFA, la contraseña sola NO da sesión: ni access token ni cookie", async () => {
    const staff = await createStaff("agent", { mfa: true });
    const res = await rawLogin(staff.email);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.body.challengeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("con el código de la app entra; el MISMO código no sirve otra vez (anti-replay)", async () => {
    const staff = await createStaff("agent", { mfa: true });
    const code = totp(staff.totpSecret!);
    const first = await verify((await rawLogin(staff.email)).body.challengeToken, code);
    expect(first.status).toBe(200);
    expect(first.body.accessToken).toEqual(expect.any(String));
    expect([first.headers["set-cookie"]].flat().join()).toMatch(/atencion_ia_refresh=/);
    const replay = await verify((await rawLogin(staff.email)).body.challengeToken, code);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("El código no es correcto");
  });

  it("dos verificaciones SIMULTÁNEAS del mismo código: una sola sesión", async () => {
    const staff = await createStaff("agent", { mfa: true });
    const code = totp(staff.totpSecret!);
    const [a, b] = await Promise.all([rawLogin(staff.email), rawLogin(staff.email)]);
    // Emitir un desafío nuevo invalida el anterior: se usa el vigente dos veces.
    const live = [a, b].map((r) => r.body.challengeToken as string);
    const results = await Promise.all(live.flatMap((t) => [verify(t, code), verify(t, code)]));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it("el desafío es de UN solo uso: tras entrar no abre otra sesión, aunque el código nuevo sea válido", async () => {
    const staff = await createStaff("agent", { mfa: true });
    const { addBackupCode } = await import("../helpers");
    const challenge = (await rawLogin(staff.email)).body.challengeToken;
    expect((await verify(challenge, await addBackupCode(staff.id))).status).toBe(200);
    const second = await verify(challenge, await addBackupCode(staff.id));
    expect(second.status).toBe(401);
    expect(second.body.error).toMatch(/venció o ya se usó/);
  });

  it("anti-replay EN LA BASE: el mismo código verificado en paralelo solo vale una vez", async () => {
    // La comprobación en memoria no alcanza: todas las verificaciones leen el último paso
    // antes de que alguna lo guarde. La actualización condicional decide.
    const staff = await createStaff("agent", { mfa: true });
    const code = totp(staff.totpSecret!);
    const results = await Promise.all(Array.from({ length: 6 }, () => mfaService.verifyCode(staff.id, code)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("código de respaldo: sirve UNA vez y avisa cuántos quedan", async () => {
    const staff = await createStaff("agent", { mfa: true });
    const { addBackupCode } = await import("../helpers");
    await addBackupCode(staff.id, "abcd2345");
    await addBackupCode(staff.id, "wxyz6789");
    const ok = await verify((await rawLogin(staff.email)).body.challengeToken, "ABCD-2345");
    expect(ok.status).toBe(200);
    expect(ok.body.backupCodesRemaining).toBe(1);
    const again = await verify((await rawLogin(staff.email)).body.challengeToken, "abcd-2345");
    expect(again.status).toBe(401);
  });

  it("el desafío muere a los 5 códigos incorrectos (aunque después llegue el correcto)", async () => {
    const staff = await createStaff("agent", { mfa: true });
    const challenge = (await rawLogin(staff.email)).body.challengeToken;
    for (let i = 0; i < 5; i++) expect((await verify(challenge, "000000")).status).toBe(401);
    const late = await verify(challenge, totp(staff.totpSecret!));
    expect(late.status).toBe(401);
    expect(late.body.error).toMatch(/venció o ya se usó/);
  });

  it("los códigos incorrectos cuentan para el bloqueo de la CUENTA (pedir desafíos nuevos no da intentos gratis)", async () => {
    const staff = await createStaff("agent", { mfa: true });
    // 5 desafíos distintos, un código malo en cada uno: la cuenta queda bloqueada como con 5 contraseñas malas.
    for (let i = 0; i < 5; i++) {
      const challenge = (await rawLogin(staff.email)).body.challengeToken;
      expect((await verify(challenge, "111111")).status).toBe(401);
    }
    expect((await rawLogin(staff.email)).status).toBe(429);
  });

  it("un desafío vencido (5 min) no sirve", async () => {
    const staff = await createStaff("agent", { mfa: true });
    const challenge = (await rawLogin(staff.email)).body.challengeToken;
    await prisma.$executeRaw`
      UPDATE staff_tokens SET created_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute'
      WHERE token_hash = ${sha256(challenge)}`;
    expect((await verify(challenge, totp(staff.totpSecret!))).status).toBe(401);
  });

  it("valida el cuerpo: token con formato inválido o código raro → 400", async () => {
    const bad = await verify("corto", "12");
    expect(bad.status).toBe(400);
  });
});

describe("MFA obligatoria para admin", () => {
  it("admin sin MFA: el login exige enrolarse; con QR + código recibe sesión y 10 códigos de respaldo", async () => {
    const admin = await createStaff("admin", { mfa: false });
    const res = await rawLogin(admin.email);
    expect(res.body).toEqual({ mfaEnrollmentRequired: true, enrollmentToken: expect.any(String) });
    expect(res.headers["set-cookie"]).toBeUndefined();

    const start = await request(app)
      .post("/api/auth/mfa/enroll/start")
      .set("X-Forwarded-For", freshIp())
      .send({ enrollmentToken: res.body.enrollmentToken });
    expect(start.status).toBe(200);
    expect(start.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(start.body.otpauthUrl).toContain(encodeURIComponent(admin.email));

    // El secreto se guarda CIFRADO.
    const stored = await prisma.staffUser.findUniqueOrThrow({ where: { id: admin.id } });
    expect(stored.mfaSecretEncrypted).not.toContain(start.body.secret);
    expect(decryptSecret(stored.mfaSecretEncrypted!)).toBe(start.body.secret);
    expect(stored.mfaEnabledAt).toBeNull();

    const wrong = await request(app)
      .post("/api/auth/mfa/enroll/confirm")
      .set("X-Forwarded-For", freshIp())
      .send({ enrollmentToken: res.body.enrollmentToken, code: "000000" });
    expect(wrong.status).toBe(400);

    const ok = await request(app)
      .post("/api/auth/mfa/enroll/confirm")
      .set("X-Forwarded-For", freshIp())
      .send({ enrollmentToken: res.body.enrollmentToken, code: totp(start.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toEqual(expect.any(String));
    expect(ok.body.backupCodes).toHaveLength(10);
    expect(new Set(ok.body.backupCodes).size).toBe(10);
    // En la base, solo hashes.
    const codes = await prisma.mfaBackupCode.findMany({ where: { staffUserId: admin.id } });
    expect(codes).toHaveLength(10);
    expect(JSON.stringify(codes)).not.toContain(ok.body.backupCodes[0]);

    // Desde ahora el login pide el código.
    expect((await rawLogin(admin.email)).body.mfaRequired).toBe(true);
    // El token de enrolamiento ya se gastó.
    const reuse = await request(app)
      .post("/api/auth/mfa/enroll/start")
      .set("X-Forwarded-For", freshIp())
      .send({ enrollmentToken: res.body.enrollmentToken });
    expect(reuse.status).toBe(401);
  });

  it("un agente sin MFA entra directo (es opcional para agentes)", async () => {
    const agent = await createStaff("agent");
    const res = await rawLogin(agent.email);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });

  it("un admin NO puede desactivar su MFA; un agente sí, con contraseña Y código", async () => {
    const { staff: admin, token: adminToken } = await staffSession("admin");
    const denied = await request(app)
      .post("/api/profile/mfa/disable")
      .set(authHeader(adminToken))
      .send({ password: TEST_PASSWORD, code: totp(admin.totpSecret!) });
    expect(denied.status).toBe(409);

    const agent = await createStaff("agent", { mfa: true });
    const { token } = await login(agent.email);
    const wrongPassword = await request(app)
      .post("/api/profile/mfa/disable")
      .set(authHeader(token))
      .send({ password: "no-es-la-clave-xx", code: totp(agent.totpSecret!) });
    expect(wrongPassword.status).toBe(400);
    const ok = await request(app)
      .post("/api/profile/mfa/disable")
      .set(authHeader(token))
      .send({ password: TEST_PASSWORD, code: totp(agent.totpSecret!) });
    expect(ok.status).toBe(204);
    const after = await prisma.staffUser.findUniqueOrThrow({ where: { id: agent.id } });
    expect(after.mfaEnabledAt).toBeNull();
    expect(after.mfaSecretEncrypted).toBeNull();
    expect(await prisma.mfaBackupCode.count({ where: { staffUserId: agent.id } })).toBe(0);
    expect(await lastEmailTo(agent.email, "mfa_disabled")).not.toBeNull();
  });

  it("un agente activa la MFA desde su perfil y regenerar los códigos invalida los anteriores", async () => {
    const { staff, token } = await staffSession("agent");
    const setup = await request(app).post("/api/profile/mfa/setup").set(authHeader(token));
    expect(setup.status).toBe(200);
    const confirm = await request(app)
      .post("/api/profile/mfa/confirm")
      .set(authHeader(token))
      .send({ code: totp(setup.body.secret) });
    expect(confirm.status).toBe(200);
    const oldCode = confirm.body.backupCodes[0] as string;

    // Otro código TOTP (paso siguiente) para regenerar: el del enrolamiento ya se usó.
    const regen = await request(app)
      .post("/api/profile/mfa/backup-codes")
      .set(authHeader(token))
      .send({ code: totp(setup.body.secret, Date.now() + 30_000) });
    expect(regen.status).toBe(200);
    expect(regen.body.backupCodes).toHaveLength(10);

    const challenge = (await rawLogin(staff.email)).body.challengeToken;
    expect((await verify(challenge, oldCode)).status).toBe(401);
    const fresh = (await rawLogin(staff.email)).body.challengeToken;
    expect((await verify(fresh, regen.body.backupCodes[0])).status).toBe(200);
  });
});
