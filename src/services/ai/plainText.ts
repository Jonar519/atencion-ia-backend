/**
 * Texto plano para el cliente (chat y voz). El frontend pinta los mensajes
 * como texto (createTextNode, sin renderizar Markdown: a propósito, sería una
 * puerta de XSS) y en una llamada la respuesta va al sintetizador de voz, que
 * leería los símbolos en voz alta. Por eso el prompt pide texto plano
 * (PLAIN_TEXT_RULE) y, como defensa por si el modelo igual usa Markdown, se
 * quitan los marcadores de énfasis antes de guardar, publicar y sintetizar.
 *
 * Solo asteriscos: `**negrita**` y `*cursiva*` pierden los marcadores, una
 * viñeta "* " pasa a "- ", y se borra cualquier `*` suelto que quede, salvo
 * el de una multiplicación ("2 * 3", "2*3"). No toca el resto del texto.
 * Nunca se usa con el clasificador: esa respuesta es JSON.
 */

export const PLAIN_TEXT_RULE =
  "Escribe en texto plano, sin Markdown: nada de asteriscos para negrita o cursiva, ni títulos con #, " +
  "ni tablas. Si necesitas una lista, usa guiones simples al inicio de cada línea.";

/** ¿Es un `*` de multiplicación? Un dígito a cada lado, con o sin espacios en medio. */
function isMultiplication(text: string, index: number): boolean {
  const before = text.slice(0, index).trimEnd();
  const after = text.slice(index + 1).trimStart();
  return /\d$/.test(before) && /^\d/.test(after);
}

export function stripMarkdownEmphasis(text: string): string {
  const cleaned = text
    // Viñetas "* " o "+ " al inicio de línea.
    .replace(/^([ \t]*)[*+][ \t]+/gm, "$1- ")
    // **negrita** (no cruza líneas).
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "$1")
    // *cursiva*, sin tocar multiplicaciones (no hay dígito pegado por fuera).
    .replace(/(^|[^*\w])\*(?=[^\s*\d])([^*\n]*?[^\s*])\*(?![*\w])/gm, "$1$2");
  // Lo que quede: asteriscos sueltos o sin pareja (p. ej. una respuesta cortada).
  let out = "";
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned.charAt(i);
    if (ch !== "*" || isMultiplication(cleaned, i)) out += ch;
  }
  return out;
}
