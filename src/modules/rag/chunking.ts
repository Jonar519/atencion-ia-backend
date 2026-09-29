/**
 * Divide el cuerpo de un artículo en fragmentos para indexar.
 *
 * Contrato (lo exige la base, migración 013_kb_chunks_provenance): cada
 * fragmento es una SUBCADENA EXACTA del cuerpo. Por eso se corta por
 * posiciones (párrafos y, si un párrafo es muy largo, oraciones) en vez de
 * reescribir el texto. El título se agrega aparte, solo al texto que se envía
 * al modelo de embeddings (embeddingInput), no al contenido guardado.
 *
 * Los artículos de soporte son cortos: fragmentos de hasta ~700 caracteres
 * (un párrafo o dos) mantienen cada idea completa y la respuesta precisa.
 */

export const TARGET_CHUNK_CHARS = 700;
export const MAX_CHUNK_CHARS = 1_000;

interface Span {
  start: number;
  end: number;
}

/** Posiciones [start, end) de los párrafos (separados por líneas en blanco). */
function paragraphSpans(body: string): Span[] {
  const spans: Span[] = [];
  const pattern = /[^\n]+(?:\n(?!\s*\n)[^\n]*)*/g; // bloques sin línea en blanco en medio
  for (const match of body.matchAll(pattern)) {
    if (match[0].trim()) spans.push({ start: match.index!, end: match.index! + match[0].length });
  }
  return spans;
}

/** Parte un tramo largo por oraciones, sin pasar de MAX_CHUNK_CHARS (corte duro si una oración es enorme). */
function splitLong(body: string, span: Span): Span[] {
  const text = body.slice(span.start, span.end);
  const sentences = [...text.matchAll(/[^.!?]+[.!?]*\s*/g)].map((m) => ({
    start: span.start + m.index!,
    end: span.start + m.index! + m[0].length,
  }));
  const result: Span[] = [];
  let current: Span | null = null;
  for (const sentence of sentences.length ? sentences : [span]) {
    for (let start = sentence.start; start < sentence.end; start += MAX_CHUNK_CHARS) {
      const piece = { start, end: Math.min(sentence.end, start + MAX_CHUNK_CHARS) };
      if (current && piece.end - current.start <= TARGET_CHUNK_CHARS) current.end = piece.end;
      else {
        if (current) result.push(current);
        current = { ...piece };
      }
    }
  }
  if (current) result.push(current);
  return result;
}

export function chunkArticleBody(body: string): string[] {
  const spans = paragraphSpans(body).flatMap((span) =>
    span.end - span.start > MAX_CHUNK_CHARS ? splitLong(body, span) : [span]
  );

  // Junta párrafos consecutivos mientras quepan en el tamaño objetivo.
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.end - last.start <= TARGET_CHUNK_CHARS) last.end = span.end;
    else merged.push({ ...span });
  }

  return merged.map((span) => body.slice(span.start, span.end).trim()).filter((chunk) => chunk.length > 0);
}

/** Texto que se envía al modelo de embeddings: título + fragmento (el título da contexto). */
export function embeddingInput(title: string, chunk: string): string {
  return `${title}\n\n${chunk}`;
}
