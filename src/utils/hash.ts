import { createHash, createHmac } from "crypto";
import { env } from "../config/env";

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * HMAC-SHA256 de una IP con IP_HASH_SECRET: permite agrupar/detectar abuso
 * por IP sin guardarla en claro. Sin el secreto, el hash de una IPv4 se
 * revertiría por fuerza bruta en segundos (solo hay 2^32).
 */
export function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHmac("sha256", env.ipHashSecret).update(ip).digest("hex");
}
