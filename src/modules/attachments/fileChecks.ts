/**
 * Validación de ADJUNTOS del chat (Fase 7, bloque C). Funciones puras: se
 * prueban sin red ni base (tests/unit/attachments.test.ts).
 *
 *  - El tipo se decide por los BYTES (firma del archivo), nunca por la
 *    extensión ni por el Content-Type que manda el navegador.
 *  - Solo PNG, JPEG, WebP y PDF; máximo MAX_ATTACHMENT_BYTES (la base también lo impone).
 *  - PDF: se rechazan los que traen JavaScript, acciones de lanzamiento o
 *    archivos incrustados. Es una HEURÍSTICA sobre el texto del archivo (un PDF
 *    con esas palabras dentro de un flujo comprimido pasaría): no es un
 *    antivirus (docs/attachments.md). Por eso además el PDF se sirve SIEMPRE
 *    como descarga y con CSP sandbox, nunca se abre dentro de la app.
 *  - JPEG: se quitan los metadatos (EXIF/XMP/IPTC). Una foto de teléfono
 *    puede llevar la ubicación GPS de la casa del cliente.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export type AttachmentKind = { ext: "png" | "jpg" | "webp" | "pdf"; contentType: string; label: "imagen" | "PDF" };

export function detectAttachment(data: Buffer): AttachmentKind | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: "png", contentType: "image/png", label: "imagen" };
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { ext: "jpg", contentType: "image/jpeg", label: "imagen" };
  }
  if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") {
    return { ext: "webp", contentType: "image/webp", label: "imagen" };
  }
  if (data.length >= 5 && data.toString("latin1", 0, 5) === "%PDF-") {
    return { ext: "pdf", contentType: "application/pdf", label: "PDF" };
  }
  return null;
}

// Nombres de PDF que ejecutan código o abren otros archivos. En un PDF, un
// nombre puede escribirse con escapes #xx (p. ej. /J#61vaScript): se normaliza antes.
const DANGEROUS_PDF_NAMES = ["/javascript", "/js", "/launch", "/embeddedfile", "/richmedia", "/xfa"];

export function pdfDangerousFeatures(data: Buffer): string[] {
  const text = data
    .toString("latin1")
    .replace(/#([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .toLowerCase();
  return DANGEROUS_PDF_NAMES.filter((name) => new RegExp(`${name.replace("/", "\\/")}(?![a-z])`).test(text));
}

/**
 * Quita de un JPEG los segmentos de metadatos APP1 (EXIF, XMP), APP13 (IPTC)
 * y COM. Recorre la estructura de segmentos hasta el inicio de la imagen (SOS);
 * de ahí en adelante copia los bytes tal cual. Si el archivo está mal formado,
 * lanza (y el adjunto se rechaza).
 */
export function stripJpegMetadata(data: Buffer): Buffer {
  const out: Buffer[] = [data.subarray(0, 2)]; // SOI
  let offset = 2;
  while (offset < data.length) {
    if (data[offset] !== 0xff) throw new Error("JPEG mal formado");
    const marker = data[offset + 1]!;
    if (marker === 0xda) {
      out.push(data.subarray(offset)); // SOS: datos de la imagen hasta el final
      return Buffer.concat(out);
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(data.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (offset + 4 > data.length) throw new Error("JPEG mal formado");
    const length = data.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > data.length) throw new Error("JPEG mal formado");
    const isMetadata = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!isMetadata) out.push(data.subarray(offset, end));
    offset = end;
  }
  throw new Error("JPEG sin datos de imagen");
}

/**
 * Nombre para MOSTRAR: sin rutas, sin caracteres de control, ≤ 150 caracteres
 * y con la extensión REAL (la del contenido, no la que dijo el usuario).
 */
export function displayName(raw: string | undefined, kind: AttachmentKind): string {
  const fallback = kind.label === "PDF" ? "documento" : "imagen";
  let name = (raw ?? "").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").trim();
  name =
    name
      .replace(/\.[A-Za-z0-9]{1,5}$/, "")
      .slice(0, 140)
      .trim() || fallback;
  return `${name}.${kind.ext}`;
}

/**
 * Texto que ve la IA de un turno con adjunto: SOLO una señal fija, generada
 * aquí con el tipo VALIDADO, más el comentario que escribió el cliente (si lo
 * hay, que es texto suyo como cualquier mensaje). Ni el contenido del archivo
 * ni su nombre llegan al modelo: los dos los controla quien sube el archivo
 * y podrían traer instrucciones (prompt injection).
 */
export function attachmentSignal(contentType: string): string {
  const kind = contentType === "application/pdf" ? "un documento PDF" : "una imagen";
  return `[El cliente adjuntó ${kind}. No puedes ver su contenido: si lo necesitas, pídele que te describa lo que muestra.]`;
}

/** Texto guardado cuando el cliente no escribió comentario (la base exige contenido). */
export const ATTACHMENT_PLACEHOLDER = "📎 Archivo adjunto";

/**
 * Lo que el cliente ESCRIBIÓ en el turno (su comentario), sin la señal. Es lo
 * único que se clasifica (intención, sentimiento) y se busca en la KB: la señal
 * es texto del servidor y no debe disparar reglas ("pidió un asesor"…).
 * Vacío si el adjunto vino sin comentario.
 */
export function customerWrittenText(content: string, hasAttachment: boolean): string {
  return hasAttachment && content === ATTACHMENT_PLACEHOLDER ? "" : content;
}

/** Lo que el modelo que RESPONDE lee del turno: con adjunto, la señal + el comentario. */
export function textForAi(content: string, attachmentContentType: string | null | undefined): string {
  if (!attachmentContentType) return content;
  const caption = customerWrittenText(content, true).trim();
  return caption ? `${attachmentSignal(attachmentContentType)}\n${caption}` : attachmentSignal(attachmentContentType);
}
