/**
 * Utilidades de texto en español para el proveedor "mock" (embeddings por
 * hashing y clasificación por reglas). No se usan con el proveedor real.
 */

const STOPWORDS = new Set(
  (
    "a al algo algun alguna algunas alguno algunos ante antes aqui asi aun cada como con contra cual cuando de del " +
    "desde donde dos el ella ellas ellos en entre era es esa ese eso esta estas este esto estos fue fueron ha han hay " +
    "la las le les lo los mas me mi mis mucho muy nada ni no nos nosotros o otra otro para pero poco por porque que " +
    "quien se ser si sin sobre solo son su sus tambien te tengo tiene tu tus un una uno unos usted ustedes y ya yo " +
    "hola buenas buenos dias tardes noches favor gracias quiero necesito puedo quisiera saber"
  ).split(" ")
);

/** Minúsculas, sin tildes ni signos. "¿Cómo BLOQUEO?" → "como bloqueo". */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Palabras con contenido (sin stopwords ni palabras de 1-2 letras). */
export function contentWords(text: string): string[] {
  return normalize(text)
    .split(" ")
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/** "Raíz" burda: primeras 5 letras ("tarjetas" y "tarjeta" → "tarje"). Suficiente para un mock. */
export function stem(word: string): string {
  return word.slice(0, 5);
}

/** FNV-1a de 32 bits: hash determinista y rápido. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Estimación de tokens (≈ 4 caracteres por token) para que el mock reporte consumo. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Divide en oraciones. Solo corta cuando lo que sigue empieza con mayúscula,
 * "¿" o "¡": así "8:00 a. m. y los sábados" o "Perfil > Seguridad" no se
 * parten en pedazos sin sentido (bug detectado en la prueba de punta a punta).
 */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/)
    .filter(Boolean);
}

/**
 * Las `max` oraciones de `text` más relacionadas con `query` (palabras en
 * común), en su orden original. `query` solo se usa para ELEGIR: el resultado
 * es siempre texto de `text`, nunca de la consulta.
 */
export function relevantSentences(text: string, query: string, max: number): string {
  const sentences = splitSentences(text);
  const queryStems = new Set(contentWords(query).map(stem));
  const scored = sentences.map((sentence, index) => ({
    index,
    score: contentWords(sentence).filter((word) => queryStems.has(stem(word))).length,
  }));
  const best = [...scored]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, max)
    .filter((item, i) => i === 0 || item.score > 0)
    .sort((a, b) => a.index - b.index);
  return best.map((item) => sentences[item.index]).join(" ");
}
