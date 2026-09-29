// Formato UUID genérico (8-4-4-4-12 hex). Los IDs del seed son v4 válidos,
// pero no se exige la versión: la base acepta cualquier UUID.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value);
}
