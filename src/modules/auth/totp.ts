import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * TOTP (RFC 6238) sobre HOTP (RFC 4226), con HMAC-SHA1, 6 dígitos y pasos de
 * 30 s: lo que entienden Google Authenticator, Microsoft Authenticator, Authy…
 * Criptografía LOCAL: no hay proveedor externo. Probado con los vectores
 * oficiales del RFC 6238 (tests/unit/totp.test.ts).
 */
export const STEP_SECONDS = 30;
export const DIGITS = 6;
/** Tolerancia de reloj: se acepta el paso anterior y el siguiente (±30 s). */
export const WINDOW = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("Secreto base32 inválido");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226 §5.3): truncamiento dinámico del HMAC. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS, algorithm = "sha1"): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(algorithm, secret).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function stepAt(timeMs: number): number {
  return Math.floor(timeMs / 1000 / STEP_SECONDS);
}

export function totp(secretBase32: string, timeMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), stepAt(timeMs));
}

function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Verifica un código y devuelve el PASO que coincidió (para guardarlo), o null.
 * ANTI-REPLAY: un paso igual o anterior al último aceptado se rechaza aunque el
 * código sea correcto (quien lo vio por encima del hombro no puede reusarlo).
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: { timeMs?: number; lastUsedStep?: number | null } = {}
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = stepAt(options.timeMs ?? Date.now());
  for (let delta = -WINDOW; delta <= WINDOW; delta += 1) {
    const step = current + delta;
    if (options.lastUsedStep !== undefined && options.lastUsedStep !== null && step <= options.lastUsedStep) continue;
    if (sameCode(hotp(secret, step), code)) return step;
  }
  return null;
}

/** Secreto nuevo: 20 bytes aleatorios (160 bits, lo que recomienda el RFC 4226). */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** URL que entienden las apps de autenticación (se muestra como QR). */
export function otpauthUrl(account: string, secretBase32: string, issuer = "Banco Cordillera"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params}`;
}
