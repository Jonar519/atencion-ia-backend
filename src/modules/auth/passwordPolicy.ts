/**
 * Política mínima de contraseñas (en la línea de NIST SP 800-63B):
 *  - Largo: de 12 a 72 caracteres (bcrypt solo usa los primeros 72 bytes).
 *    12 y no 10 como en el Proyecto 1: aquí todas las cuentas son de staff
 *    con acceso a datos de clientes de un banco.
 *  - Sin reglas de composición arbitrarias ("una mayúscula, un símbolo…"),
 *    que empujan a patrones predecibles. En su lugar se rechazan las
 *    contraseñas muy comunes o triviales y las que contienen el correo o el
 *    nombre de la persona.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 72;

// Contraseñas y bases muy frecuentes en filtraciones públicas (se comparan en
// minúsculas y sin dígitos/símbolos al final), más palabras del dominio.
const COMMON = new Set([
  "password",
  "contraseña",
  "contrasena",
  "123456789012",
  "qwerty",
  "qwertyuiop",
  "abc123",
  "iloveyou",
  "admin",
  "administrador",
  "welcome",
  "bienvenido",
  "colombia",
  "letmein",
  "dragon",
  "football",
  "monkey",
  "sunshine",
  "princess",
  "teamo",
  "tequiero",
  "clave",
  "secreto",
  "passw0rd",
  "soporte",
  "agente",
  "cordillera",
  "banco",
  "atencion",
  "atencionia",
]);

/** Parte "base" de una contraseña: minúsculas, sin dígitos ni símbolos al final. */
const base = (password: string) => password.toLowerCase().replace(/[\d\W_]+$/u, "");

export function passwordProblems(password: string, context: { email?: string; name?: string } = {}): string[] {
  const problems: string[] = [];
  // Largo en BYTES para el máximo: bcrypt corta a 72 bytes y "ñ" ocupa 2.
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`Debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`);
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_LENGTH) {
    problems.push(`Debe tener como máximo ${PASSWORD_MAX_LENGTH} bytes`);
  }
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(base(password)) || /^(.)\1+$/.test(password) || /^\d+$/.test(password)) {
    problems.push("Es demasiado común o fácil de adivinar");
  }
  const localPart = context.email?.split("@")[0]?.toLowerCase();
  if (localPart && localPart.length >= 4 && lower.includes(localPart)) problems.push("No debe contener tu correo");
  const firstName = context.name?.trim().split(/\s+/)[0]?.toLowerCase();
  if (firstName && firstName.length >= 4 && lower.includes(firstName)) problems.push("No debe contener tu nombre");
  return problems;
}
