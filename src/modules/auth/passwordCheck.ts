import bcrypt from "bcrypt";

/**
 * Único lugar donde se decide cómo se guarda y se compara una contraseña
 * (bcrypt, costo 10). Sin dependencias de la configuración (env, prisma): lo
 * usa también el alta del primer admin (npm run admin:crear), que solo lee
 * DATABASE_URL.
 */
export const BCRYPT_COST = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

// Hash de una contraseña aleatoria: cuando no hay contra qué comparar (correo
// que no existe, invitación pendiente) se compara igual contra este hash, para
// que la respuesta tarde lo mismo (si no, el tiempo revelaría qué cuentas existen).
const DUMMY_HASH = bcrypt.hashSync(`dummy-${Math.random()}`, BCRYPT_COST);

/**
 * ¿Coincide la contraseña? Una cuenta SIN contraseña (invitación pendiente,
 * migración 018) nunca coincide, y tarda lo mismo que una que sí la tiene.
 */
export async function passwordMatches(plain: string, hash: string | null | undefined): Promise<boolean> {
  const ok = await bcrypt.compare(plain, hash ?? DUMMY_HASH);
  return ok && hash != null;
}
