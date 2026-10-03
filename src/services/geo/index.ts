import maxmind, { type CityResponse, type Reader } from "maxmind";
import { env } from "../../config/env";
import { isPrivateIp } from "../../utils/ip";

/**
 * Ubicación APROXIMADA de una sesión, solo por rango de IP y con una base de
 * datos LOCAL (sin llamar a ningún servicio): la IP no sale del servidor.
 *  - "mock" (por defecto): redes locales → "Red local"; los rangos de
 *    documentación (RFC 5737) → ciudades fijas, para probar; el resto → sin ubicación.
 *  - "dbip": lee un archivo .mmdb local (p. ej. "IP to City Lite" de DB-IP,
 *    gratuito, licencia CC BY 4.0) con el lector de maxmind. Solo hace falta
 *    descargar el archivo (GEO_DB_PATH); no hay API key.
 * Siempre se muestra como "ubicación aproximada": una IP no ubica a una persona.
 */
export interface GeoProvider {
  readonly provider: "mock" | "dbip";
  /** Etiqueta legible ("Bogotá, Colombia") o null si no se sabe. */
  lookup(ip: string): Promise<string | null>;
}

const LOCAL = "Red local";

const MOCK_RANGES: [RegExp, string][] = [
  [/^192\.0\.2\./, "Bogotá, Colombia"],
  [/^198\.51\.100\./, "Medellín, Colombia"],
  [/^203\.0\.113\./, "Ciudad de México, México"],
];

export function createMockGeo(): GeoProvider {
  return {
    provider: "mock",
    async lookup(ip) {
      if (isPrivateIp(ip)) return LOCAL;
      const clean = ip.replace(/^::ffff:/i, "");
      return MOCK_RANGES.find(([range]) => range.test(clean))?.[1] ?? null;
    },
  };
}

type CityReader = Pick<Reader<CityResponse>, "get">;

/** El lector se inyecta: los tests prueban el adaptador sin el archivo real. */
export function createDbipGeo(openReader: () => Promise<CityReader>): GeoProvider {
  let reader: Promise<CityReader> | null = null;
  return {
    provider: "dbip",
    async lookup(ip) {
      if (isPrivateIp(ip)) return LOCAL;
      reader ??= openReader();
      const record = (await reader).get(ip.replace(/^::ffff:/i, ""));
      if (!record) return null;
      const city = record.city?.names?.es ?? record.city?.names?.en;
      const country = record.country?.names?.es ?? record.country?.names?.en;
      return [city, country].filter(Boolean).join(", ") || null;
    },
  };
}

let current: GeoProvider | null = null;

export function getGeo(): GeoProvider {
  current ??=
    env.geo.provider === "dbip" ? createDbipGeo(() => maxmind.open<CityResponse>(env.geo.dbPath!)) : createMockGeo();
  return current;
}

export function setGeoForTests(provider: GeoProvider | null) {
  current = provider;
}
