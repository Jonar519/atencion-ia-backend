/**
 * Los correos se guardan y se buscan siempre en minúsculas (la base lo exige con un CHECK).
 *
 * Módulo aparte, sin dependencias: lo usa también el alta del primer admin,
 * que no carga la configuración de la API.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
