import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  base32Decode,
  base32Encode,
  generateSecret,
  hotp,
  otpauthUrl,
  stepAt,
  totp,
  verifyTotp,
} from "../../src/modules/auth/totp";
import { decryptSecret, encryptSecret } from "../../src/modules/auth/mfaCrypto";
import { isPrivateIp, truncateIp } from "../../src/utils/ip";
import { createDbipGeo, createMockGeo } from "../../src/services/geo";
import { createSmtpEmail } from "../../src/services/email";
import { templates } from "../../src/services/email/templates";
import { assertValidKey, createLocalStorage, createS3Storage } from "../../src/services/storage";
import { detectImage } from "../../src/modules/profile/avatar";

// Secreto de los vectores de prueba del RFC 6238 (apéndice B), SHA-1: "12345678901234567890".
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");
const RFC_SECRET_B32 = base32Encode(RFC_SECRET);

describe("TOTP (RFC 6238)", () => {
  // Vectores oficiales (8 dígitos) del apéndice B, SHA-1.
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  it.each(vectors)("t=%i s → %s (vector oficial, 8 dígitos)", (seconds, expected) => {
    expect(hotp(RFC_SECRET, Math.floor(seconds / 30), 8)).toBe(expected);
  });

  it("con 6 dígitos (lo que usan las apps) son los últimos 6 del vector", () => {
    for (const [seconds, expected] of vectors) expect(totp(RFC_SECRET_B32, seconds * 1000)).toBe(expected.slice(2));
  });

  it("RFC 4226 (HOTP), apéndice D: contadores 0 a 3", () => {
    expect([0, 1, 2, 3].map((c) => hotp(RFC_SECRET, c))).toEqual(["755224", "287082", "359152", "969429"]);
  });

  it("base32 ida y vuelta, y el secreto generado tiene 160 bits", () => {
    const bytes = randomBytes(20);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(base32Decode(generateSecret())).toHaveLength(20);
    expect(() => base32Decode("NO-VALIDO-1!")).toThrow();
  });

  it("acepta ±1 paso de desfase de reloj, no ±2", () => {
    const now = 1_700_000_000_000;
    const secret = generateSecret();
    const step = stepAt(now);
    expect(verifyTotp(secret, totp(secret, now - 30_000), { timeMs: now })).toBe(step - 1);
    expect(verifyTotp(secret, totp(secret, now + 30_000), { timeMs: now })).toBe(step + 1);
    expect(verifyTotp(secret, totp(secret, now - 60_000), { timeMs: now })).toBeNull();
    expect(verifyTotp(secret, totp(secret, now + 60_000), { timeMs: now })).toBeNull();
  });

  it("ANTI-REPLAY: un código de un paso ya usado (o anterior) se rechaza aunque sea correcto", () => {
    const now = 1_700_000_000_000;
    const secret = generateSecret();
    const code = totp(secret, now);
    const step = verifyTotp(secret, code, { timeMs: now });
    expect(step).toBe(stepAt(now));
    expect(verifyTotp(secret, code, { timeMs: now, lastUsedStep: step })).toBeNull();
    // El siguiente paso sí se acepta.
    expect(verifyTotp(secret, totp(secret, now + 30_000), { timeMs: now + 30_000, lastUsedStep: step })).toBe(
      step! + 1
    );
  });

  it("rechaza formatos que no son 6 dígitos", () => {
    const secret = generateSecret();
    for (const code of ["", "12345", "1234567", "12a456", " 123456"]) expect(verifyTotp(secret, code)).toBeNull();
  });

  it("la URL otpauth lleva emisor, algoritmo, dígitos y período", () => {
    const url = otpauthUrl("ana@banco.example", "JBSWY3DPEHPK3PXP");
    expect(url).toMatch(/^otpauth:\/\/totp\/Banco%20Cordillera%3Aana%40banco\.example\?/);
    const params = new URL(url).searchParams;
    expect(Object.fromEntries(params)).toMatchObject({
      secret: "JBSWY3DPEHPK3PXP",
      issuer: "Banco Cordillera",
      algorithm: "SHA1",
      digits: "6",
      period: "30",
    });
  });
});

describe("cifrado del secreto MFA (AES-256-GCM)", () => {
  const key = randomBytes(32);

  it("ida y vuelta, y el cifrado no contiene el secreto ni se repite (IV aleatorio)", () => {
    const secret = generateSecret();
    const a = encryptSecret(secret, key);
    const b = encryptSecret(secret, key);
    expect(a).toMatch(/^v1:/);
    expect(a).not.toContain(secret);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe(secret);
  });

  it("detecta alteraciones y una clave distinta (etiqueta GCM)", () => {
    const stored = encryptSecret(generateSecret(), key);
    const raw = Buffer.from(stored.slice(3), "base64");
    raw[raw.length - 1]! ^= 1;
    expect(() => decryptSecret(`v1:${raw.toString("base64")}`, key)).toThrow();
    expect(() => decryptSecret(stored, randomBytes(32))).toThrow();
    expect(() => decryptSecret("v0:abc", key)).toThrow(/Formato/);
  });
});

describe("IP truncada y ubicación aproximada", () => {
  it.each([
    ["190.25.34.117", "190.25.34.0"],
    ["::ffff:190.25.34.117", "190.25.34.0"],
    ["2800:e2:4180:12:abcd::1", "2800:e2:4180::"],
    ["2001:db8::1", "2001:db8:0::"],
    ["::1", "0:0:0::"],
    ["no-es-ip", null],
    [undefined, null],
  ])("%s → %s", (ip, expected) => {
    expect(truncateIp(ip)).toBe(expected);
  });

  it("la IP truncada cumple el CHECK de la base (migración 015)", () => {
    const check = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.0|[0-9a-f:]+::)$/;
    for (const ip of ["190.25.34.117", "2800:e2:4180:12::1", "::1", "fe80::1"]) {
      expect(truncateIp(ip)).toMatch(check);
    }
  });

  it("reconoce redes privadas y de loopback", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "172.16.5.4", "192.168.1.9", "::1", "::ffff:10.1.2.3", "fd00::1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "190.25.34.117", "2800:e2::1"]) expect(isPrivateIp(ip)).toBe(false);
  });

  it("mock: red local, rangos de documentación y desconocidas", async () => {
    const geo = createMockGeo();
    expect(await geo.lookup("127.0.0.1")).toBe("Red local");
    expect(await geo.lookup("192.0.2.44")).toBe("Bogotá, Colombia");
    expect(await geo.lookup("::ffff:198.51.100.7")).toBe("Medellín, Colombia");
    expect(await geo.lookup("8.8.8.8")).toBeNull();
  });

  it("adaptador DB-IP: usa el nombre en español, cae al inglés, y abre el archivo UNA vez", async () => {
    const get = vi.fn((ip: string) =>
      ip === "190.25.34.117"
        ? { city: { names: { es: "Bogotá", en: "Bogota" } }, country: { names: { es: "Colombia", en: "Colombia" } } }
        : ip === "81.2.69.160"
          ? { city: { names: { en: "London" } }, country: { names: { en: "United Kingdom" } } }
          : null
    );
    const open = vi.fn().mockResolvedValue({ get });
    const geo = createDbipGeo(open);
    expect(await geo.lookup("190.25.34.117")).toBe("Bogotá, Colombia");
    expect(await geo.lookup("81.2.69.160")).toBe("London, United Kingdom");
    expect(await geo.lookup("8.8.8.8")).toBeNull();
    expect(await geo.lookup("192.168.0.2")).toBe("Red local");
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("correo", () => {
  it("adaptador SMTP: envía remitente, destinatario, asunto y texto (doble del transporte, sin red)", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const email = createSmtpEmail({ from: "Soporte <no-reply@banco.example>", transport: { sendMail } });
    await email.send({ to: "ana@banco.example", subject: "Hola", text: "Cuerpo", template: "x" });
    expect(sendMail).toHaveBeenCalledWith({
      from: "Soporte <no-reply@banco.example>",
      to: "ana@banco.example",
      subject: "Hola",
      text: "Cuerpo",
    });
  });

  it("el enlace de recuperación lleva el token en el FRAGMENTO (#), no en la ruta ni en la query del servidor", () => {
    const message = templates.passwordReset("ana@banco.example", "id", "tok_en-123");
    const url = message.text.match(/https?:\/\/\S+/)![0];
    expect(url).toMatch(/\/#\/agente\/restablecer\?token=tok_en-123$/);
    expect(new URL(url).search).toBe("");
  });

  it("el aviso al correo anterior enmascara el correo nuevo", () => {
    const message = templates.emailChangeNotice("viejo@banco.example", "id", "nuevo.correo@otro.example");
    expect(message.text).toContain("n***@otro.example");
    expect(message.text).not.toContain("nuevo.correo");
  });
});

describe("almacenamiento", () => {
  it("claves: solo las que genera el servidor (sin ../, mayúsculas, rutas absolutas ni extensiones raras)", () => {
    expect(() => assertValidKey("avatars/abc-123.png")).not.toThrow();
    for (const bad of [
      "../x.png",
      "avatars/../../x.png",
      "/etc/passwd.png",
      "a\\b.png",
      "A.png",
      "x.exe",
      "x.svg",
      "",
    ]) {
      expect(() => assertValidKey(bad), bad).toThrow();
    }
  });

  it("local: guarda, lee, borra y no escribe fuera de su carpeta", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atencion-ia-storage-"));
    try {
      const storage = createLocalStorage(dir);
      await storage.put("avatars/uno.png", Buffer.from("datos"), "image/png");
      expect(fs.existsSync(path.join(dir, "avatars", "uno.png"))).toBe(true);
      expect(await storage.get("avatars/uno.png")).toEqual({ data: Buffer.from("datos"), contentType: "image/png" });
      await storage.delete("avatars/uno.png");
      expect(await storage.get("avatars/uno.png")).toBeNull();
      await expect(storage.put("../fuera.png", Buffer.from("x"), "image/png")).rejects.toThrow();
      expect(fs.existsSync(path.join(dir, "..", "fuera.png"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("S3: comandos correctos contra el bucket (doble del cliente, sin red ni credenciales)", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetObjectCommand) {
        if (command.input.Key === "avatars/no-existe.png") throw Object.assign(new Error("x"), { name: "NoSuchKey" });
        return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) }, ContentType: "image/png" };
      }
      return {};
    });
    const storage = createS3Storage({ bucket: "mi-bucket", client: { send } as never });
    await storage.put("avatars/a.png", Buffer.from([1, 2, 3]), "image/png");
    const put = send.mock.calls[0]![0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({ Bucket: "mi-bucket", Key: "avatars/a.png", ContentType: "image/png" });
    expect(await storage.get("avatars/a.png")).toEqual({ data: Buffer.from([1, 2, 3]), contentType: "image/png" });
    expect(await storage.get("avatars/no-existe.png")).toBeNull();
    await expect(storage.put("../x.png", Buffer.from("x"), "image/png")).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe("avatar: bytes mágicos", () => {
  it("reconoce PNG, JPEG y WebP por su contenido, no por el nombre", () => {
    expect(detectImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])))?.toMatchObject({
      ext: "png",
    });
    expect(detectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])))?.toMatchObject({ ext: "jpg" });
    expect(detectImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])))?.toMatchObject({
      ext: "webp",
    });
  });

  it("rechaza SVG, HTML, GIF y PDF aunque digan ser imagen", () => {
    for (const content of ['<svg xmlns="http://www.w3.org/2000/svg"/>', "<html><script>", "GIF89a", "%PDF-1.7"]) {
      expect(detectImage(Buffer.from(content)), content).toBeNull();
    }
  });
});
