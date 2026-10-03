import type { Request } from "express";
import type { ActorType, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { hashIp } from "../../utils/hash";

/**
 * Registro de auditoría (tabla audit_log): quién hizo qué, sobre qué y cuándo.
 *
 * NUNCA se registran datos sensibles: ni contraseñas, ni tokens, ni el correo
 * de un login fallido, ni el contenido de mensajes o transcripciones. Solo la
 * acción, la entidad, su id y metadatos no sensibles. La IP se guarda como HMAC.
 *
 * "Fire-and-forget": auditar nunca retrasa ni hace fallar la operación
 * auditada; un error al escribir el registro se loguea como advertencia.
 */

export type AuditAction =
  | "auth.login_success"
  | "auth.login_failure"
  | "auth.login_locked"
  | "auth.logout"
  | "auth.refresh_reuse_detected"
  | "auth.mfa_failure"
  | "auth.mfa_backup_code_used"
  | "auth.password_reset"
  | "mfa.enabled"
  | "mfa.disabled"
  | "mfa.backup_codes_regenerated"
  | "profile.update"
  | "profile.email_change_requested"
  | "profile.email_changed"
  | "profile.password_changed"
  | "profile.avatar_updated"
  | "profile.avatar_deleted"
  | "profile.export"
  | "session.revoke"
  | "session.revoke_others"
  | "staff.anonymize"
  | "conversation.reassign"
  | "canned.create"
  | "canned.update"
  | "canned.delete"
  | "staff.create"
  | "staff.update"
  | "staff.availability"
  | "kb.create"
  | "kb.update"
  | "kb.delete"
  | "conversation.view"
  | "conversation.take"
  | "conversation.close"
  | "conversation.message"
  | "call.start"
  | "call.join"
  | "call.leave"
  | "call.end"
  | "call.purge";

export type AuditEntity = "staff_user" | "session" | "kb_article" | "conversation" | "call" | "canned_response";

export interface AuditEntry {
  action: AuditAction;
  actorType?: ActorType;
  actorId?: string | null;
  entityType?: AuditEntity;
  entityId?: string | null;
  metadata?: Prisma.InputJsonObject;
}

const pending = new Set<Promise<unknown>>();

export function audit(req: Request | null, entry: AuditEntry): void {
  const actorId = entry.actorId !== undefined ? entry.actorId : (req?.user?.staffId ?? null);
  const write = prisma.auditLog
    .create({
      data: {
        actorType: entry.actorType ?? "staff",
        actorId,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        metadata: entry.metadata ?? {},
        ipHash: hashIp(req?.ip),
        userAgent: req?.get("user-agent")?.slice(0, 200) ?? null,
      },
    })
    .catch((err: unknown) =>
      logger.warn(
        { action: entry.action, err: err instanceof Error ? err.message : String(err) },
        "No se pudo escribir la auditoría"
      )
    )
    .finally(() => pending.delete(write));
  pending.add(write);
}

/** Espera a que se escriban los registros pendientes (tests y apagado ordenado). */
export async function flushAudit(): Promise<void> {
  await Promise.all([...pending]);
}
