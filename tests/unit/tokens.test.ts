import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { issueAccessToken, verifyAccessToken } from "../../src/modules/auth/tokens";

const staff = { id: "a0000000-0000-4000-8000-000000000002", role: "agent" as const };
const SECRET = process.env.JWT_SECRET!;
const CLAIMS = { subject: staff.id, issuer: "atencion-ia", audience: "atencion-ia-staff" };

describe("access tokens", () => {
  it("emite y verifica un token válido", () => {
    expect(verifyAccessToken(issueAccessToken(staff))).toMatchObject({ staffId: staff.id, role: "agent" });
  });

  it("rechaza un token cuyo contenido se alteró (agent → admin) conservando la firma original", () => {
    const [header, , signature] = issueAccessToken(staff).split(".");
    const payload = { ...(jwt.decode(issueAccessToken(staff)) as object), role: "admin" };
    const forged = `${header}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
    expect(verifyAccessToken(forged)).toBeNull();
  });

  it('rechaza "alg: none" (token sin firma)', () => {
    const unsigned = jwt.sign({ role: "admin" }, "", { ...CLAIMS, algorithm: "none" });
    expect(verifyAccessToken(unsigned)).toBeNull();
  });

  it("rechaza un token de otra audiencia (p. ej. un futuro token de cliente del widget)", () => {
    const other = jwt.sign({ role: "agent" }, SECRET, { ...CLAIMS, audience: "atencion-ia-widget" });
    expect(verifyAccessToken(other)).toBeNull();
  });

  it("rechaza un token expirado y uno con un rol inexistente", () => {
    expect(verifyAccessToken(jwt.sign({ role: "agent" }, SECRET, { ...CLAIMS, expiresIn: -10 }))).toBeNull();
    expect(verifyAccessToken(jwt.sign({ role: "superadmin" }, SECRET, CLAIMS))).toBeNull();
  });

  it("rechaza un token firmado con otro secreto", () => {
    expect(verifyAccessToken(jwt.sign({ role: "agent" }, "otro-secreto-de-32-caracteres-o-mas!", CLAIMS))).toBeNull();
  });
});
