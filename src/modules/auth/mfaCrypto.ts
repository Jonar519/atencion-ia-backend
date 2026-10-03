import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { env } from "../../config/env";

/**
 * Cifrado del secreto TOTP en la base: AES-256-GCM (confidencialidad e
 * integridad). Quien lea la tabla staff_users no obtiene secretos útiles sin
 * la clave, que vive fuera de la base (MFA_ENCRYPTION_KEY).
 * Formato: "v1:" + base64(iv[12] | tag[16] | cifrado).
 */
const VERSION = "v1:";

export function encryptSecret(plain: string, key: Buffer = env.identity.mfaEncryptionKey): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return VERSION + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

/** Lanza si el valor fue alterado o se cifró con otra clave (GCM verifica la etiqueta). */
export function decryptSecret(stored: string, key: Buffer = env.identity.mfaEncryptionKey): string {
  if (!stored.startsWith(VERSION)) throw new Error("Formato de secreto cifrado desconocido");
  const raw = Buffer.from(stored.slice(VERSION.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
