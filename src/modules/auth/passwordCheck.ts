import bcrypt from "bcrypt";

export const BCRYPT_COST = 10;

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
