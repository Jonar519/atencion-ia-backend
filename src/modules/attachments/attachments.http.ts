import type { Request, Response } from "express";
import { z } from "zod";
import { cleanText, uuidSchema } from "../../utils/schemas";
import { ApiError } from "../../utils/apiError";
import { decodeFileName } from "./attachments.service";

/**
 * Lo que acompaña a un adjunto en la petición. El cuerpo es el archivo CRUDO
 * (express.raw), así que el resto va en encabezados, codificados con
 * encodeURIComponent: X-File-Name, X-Caption (comentario opcional) y
 * X-Client-Msg-Id (idempotencia, igual que un mensaje de texto).
 */
const metaSchema = z
  .object({
    caption: cleanText(1, 4000).optional(),
    clientMsgId: uuidSchema.optional(),
  })
  .strict();

export function readAttachmentMeta(req: Request) {
  const rawCaption = decodeFileName(req.get("x-caption"));
  const parsed = metaSchema.safeParse({
    caption: rawCaption?.trim() ? rawCaption : undefined,
    clientMsgId: req.get("x-client-msg-id") || undefined,
  });
  if (!parsed.success) {
    throw new ApiError(
      400,
      "Datos inválidos",
      parsed.error.issues.map((i) => ({ field: `headers.${i.path.join(".")}`, message: i.message }))
    );
  }
  return { ...parsed.data, fileName: decodeFileName(req.get("x-file-name")) };
}

/**
 * Envía un adjunto. Imágenes: inline (se muestran en el chat). PDF: SIEMPRE
 * como descarga, nunca se abre dentro de la app. CSP propia que no deja
 * ejecutar nada aunque el archivo lo intente; nosniff lo pone helmet.
 */
export function sendAttachment(
  res: Response,
  found: { attachment: { contentType: string; originalName: string }; file: { data: Buffer } }
) {
  const { contentType, originalName } = found.attachment;
  const disposition = contentType === "application/pdf" ? "attachment" : "inline";
  const asciiName = originalName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  res.set("Content-Type", contentType);
  res.set(
    "Content-Disposition",
    `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(originalName)}`
  );
  res.set("Content-Security-Policy", "default-src 'none'; sandbox");
  res.send(found.file.data);
}
