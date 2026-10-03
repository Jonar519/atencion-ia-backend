import { isIP } from "net";

/**
 * La IP de una sesión se guarda TRUNCADA (docs/data-retention.md): suficiente
 * para reconocer "desde qué red" se entró, no para identificar un equipo.
 *  - IPv4: x.y.z.0 (se descarta el último octeto, /24).
 *  - IPv6: los primeros 48 bits (tres grupos) + "::".
 *  - IPv4 mapeada en IPv6 (::ffff:1.2.3.4): se trata como IPv4.
 * La base lo exige con un CHECK (migración 015).
 */
export function truncateIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const ip = raw.trim().replace(/^::ffff:/i, "");
  if (isIP(ip) === 4) return ip.replace(/\.\d{1,3}$/, ".0");
  if (isIP(ip) === 6) {
    const groups = expandIpv6(ip);
    return `${groups
      .slice(0, 3)
      .map((g) => g.replace(/^0+(?=.)/, ""))
      .join(":")}::`;
  }
  return null;
}

function expandIpv6(ip: string): string[] {
  const [head, tail] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  return [...left, ...new Array(Math.max(missing, 0)).fill("0"), ...right].map((g) => g.padStart(4, "0"));
}

/** Loopback y rangos privados: no tienen ubicación geográfica. */
export function isPrivateIp(raw: string): boolean {
  const ip = raw.trim().replace(/^::ffff:/i, "");
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
    );
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
  }
  return false;
}
