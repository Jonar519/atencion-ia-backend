import { createHash, randomUUID } from "crypto";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { ApiError } from "../../utils/apiError";
import { getStorage } from "../../services/storage";
import { canViewConversation } from "../conversations/conversations.access";
import type { AuthUser } from "../../middlewares/auth.middleware";
import {
  MAX_ATTACHMENT_BYTES,
  detectAttachment,
  displayName,
  pdfDangerousFeatures,
  stripJpegMetadata,
} from "./fileChecks";

/**
 * Adjuntos del chat: validar, guardar en el almacenamiento y servir SOLO a
 * quien puede ver la conversación. Reglas y límites: docs/attachments.md.
 */
export interface StoredAttachment {
  id: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  originalName: string;
  sha256: string;
}

/** Valida los bytes y los guarda. El llamador crea el mensaje; si falla, debe llamar a discard(). */
export async function storeAttachment(input: {
  conversationId: string;
  data: unknown;
  declaredName?: string;
}): Promise<StoredAttachment> {
  // Sin un Content-Type aceptado, express.raw no lee el cuerpo (llega {}): 415.
  if (!Buffer.isBuffer(input.data)) {
    throw new ApiError(415, "Envía el archivo como image/png, image/jpeg, image/webp o application/pdf");
  }
  let data: Buffer = input.data;
  if (data.length === 0) throw new ApiError(400, "Falta el archivo");
  if (data.length > MAX_ATTACHMENT_BYTES) throw new ApiError(413, "El archivo supera 5 MB");
  const kind = detectAttachment(data);
  if (!kind) throw new ApiError(415, "Solo se aceptan imágenes PNG, JPEG o WebP y documentos PDF");
  if (kind.ext === "pdf") {
    const found = pdfDangerousFeatures(data);
    if (found.length) {
      throw new ApiError(
        422,
        "Este PDF trae contenido activo (scripts o archivos incrustados) y no se puede adjuntar.",
        {
          features: found,
        }
      );
    }
  }
  if (kind.ext === "jpg") {
    try {
      data = stripJpegMetadata(data);
    } catch {
      throw new ApiError(415, "La imagen JPEG está dañada");
    }
  }
  const id = randomUUID();
  const storageKey = `attachments/${input.conversationId}/${id}.${kind.ext}`;
  await getStorage().put(storageKey, data, kind.contentType);
  return {
    id,
    storageKey,
    contentType: kind.contentType,
    sizeBytes: data.length,
    originalName: displayName(input.declaredName, kind),
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

/** Borra un archivo guardado cuyo mensaje no llegó a crearse (no deja huérfanos). */
export async function discardAttachment(stored: StoredAttachment) {
  try {
    await getStorage().delete(stored.storageKey);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "No se pudo borrar un adjunto descartado");
  }
}

/** "nombre.pdf" decodificado del header X-File-Name (el navegador lo manda con encodeURIComponent). */
export function decodeFileName(header: string | undefined): string | undefined {
  if (!header) return undefined;
  try {
    return decodeURIComponent(header).slice(0, 300);
  } catch {
    return undefined;
  }
}

async function load(attachmentId: string) {
  const attachment = await prisma.messageAttachment.findUnique({
    where: { id: attachmentId },
    select: {
      id: true,
      conversationId: true,
      storageKey: true,
      contentType: true,
      originalName: true,
      message: { select: { conversation: { select: { customerId: true, status: true, assignedAgentId: true } } } },
    },
  });
  if (!attachment) return null;
  const file = await getStorage().get(attachment.storageKey);
  if (!file) return null;
  return { attachment, conversation: attachment.message.conversation, file };
}

const NOT_FOUND = "Adjunto no encontrado";

/** Cliente: solo los adjuntos de SUS conversaciones (si no, 404: no revela que existe). */
export async function attachmentForCustomer(customerId: string, attachmentId: string) {
  const found = await load(attachmentId);
  if (!found || found.conversation.customerId !== customerId) throw new ApiError(404, NOT_FOUND);
  return found;
}

/** Staff: solo si puede ver la conversación (misma regla que la API y el WebSocket). */
export async function attachmentForStaff(user: AuthUser, conversationId: string, attachmentId: string) {
  const found = await load(attachmentId);
  if (!found || found.attachment.conversationId !== conversationId) throw new ApiError(404, NOT_FOUND);
  if (!canViewConversation(user, found.conversation)) throw new ApiError(404, NOT_FOUND);
  return found;
}

/**
 * Vacía la cola storage_deletions (la llenan los triggers de la base al borrar
 * adjuntos, p. ej. al suprimir un cliente). Idempotente: borrar un archivo que
 * ya no existe no es error. Devuelve cuántos se borraron.
 */
export async function purgeStorageDeletions(batch = 100): Promise<number> {
  const rows = await prisma.storageDeletion.findMany({ take: batch, orderBy: { requestedAt: "asc" } });
  let done = 0;
  for (const row of rows) {
    try {
      await getStorage().delete(row.storageKey);
      await prisma.storageDeletion.delete({ where: { storageKey: row.storageKey } });
      done += 1;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "No se pudo borrar un archivo pendiente");
    }
  }
  return done;
}
