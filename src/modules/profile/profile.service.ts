import { randomBytes } from "crypto";
import bcrypt from "bcrypt";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { logger } from "../../config/logger";
import { ApiError } from "../../utils/apiError";
import { getEmail } from "../../services/email";
import { templates } from "../../services/email/templates";
import { getStorage } from "../../services/storage";
import { BCRYPT_COST } from "../auth/auth.service";
import { mfaService } from "../auth/mfa.service";
import { passwordProblems } from "../auth/passwordPolicy";
import { sessionsService } from "../auth/sessions.service";
import { consumeToken, issueToken } from "../auth/singleUseTokens";
import { MAX_AVATAR_BYTES, detectImage } from "./avatar";
import type { UpdateProfileInput } from "./profile.schema";

/**
 * Perfil PROPIO del staff (cualquier rol). Todo lo sensible pide la
 * contraseña actual: un access token robado (15 min) no alcanza para
 * cambiar el correo o la contraseña y quedarse con la cuenta.
 */
const PROFILE_FIELDS = {
  id: true,
  name: true,
  email: true,
  role: true,
  availability: true,
  phone: true,
  theme: true,
  avatarStorageKey: true,
  mfaEnabledAt: true,
  lastLoginAt: true,
  createdAt: true,
} satisfies Prisma.StaffUserSelect;

type ProfileRow = Prisma.StaffUserGetPayload<{ select: typeof PROFILE_FIELDS }>;

export const EMAIL_CHANGE_REQUESTED =
  "Si el correo está disponible, te enviamos un enlace para confirmarlo. El cambio se aplica al abrirlo.";

function toProfile(row: ProfileRow, backupCodesRemaining: number) {
  const { avatarStorageKey, mfaEnabledAt, ...rest } = row;
  return {
    ...rest,
    mfaEnabled: Boolean(mfaEnabledAt),
    mfaEnabledAt,
    // Para admin la verificación en dos pasos es obligatoria: la UI no ofrece desactivarla.
    mfaRequired: row.role === "admin",
    backupCodesRemaining,
    hasAvatar: Boolean(avatarStorageKey),
    // Cambia con cada avatar nuevo (la clave lleva un sufijo aleatorio): sirve para invalidar cachés del cliente.
    avatarVersion: avatarStorageKey?.match(/-([0-9a-f]{8})\.[a-z]+$/)?.[1] ?? null,
  };
}

async function loadWithPassword(staffId: string) {
  const staff = await prisma.staffUser.findUnique({
    where: { id: staffId },
    select: { id: true, name: true, email: true, passwordHash: true, isActive: true },
  });
  if (!staff || !staff.isActive) throw new ApiError(401, "Cuenta no disponible");
  return staff;
}

async function requirePassword(hash: string, password: string) {
  if (!(await bcrypt.compare(password, hash))) throw new ApiError(400, "La contraseña actual no es correcta");
}

export const profileService = {
  async get(staffId: string) {
    const row = await prisma.staffUser.findUnique({ where: { id: staffId }, select: PROFILE_FIELDS });
    if (!row) throw new ApiError(404, "Miembro del staff no encontrado");
    return toProfile(row, row.mfaEnabledAt ? await mfaService.remainingBackupCodes(staffId) : 0);
  },

  async update(staffId: string, input: UpdateProfileInput) {
    await prisma.staffUser.update({ where: { id: staffId }, data: input });
    return this.get(staffId);
  },

  /**
   * Cambio de correo en DOS pasos: aquí solo se envía un enlace al correo
   * NUEVO (prueba que es de la persona) y un aviso al ANTERIOR. Si el correo
   * ya lo usa otra cuenta, la respuesta es la misma y no se envía nada
   * (no se revela qué correos existen).
   */
  async requestEmailChange(staffId: string, input: { newEmail: string; currentPassword: string }) {
    const staff = await loadWithPassword(staffId);
    await requirePassword(staff.passwordHash, input.currentPassword);
    if (input.newEmail === staff.email) throw new ApiError(400, "Ese ya es tu correo");
    const taken = await prisma.staffUser.count({ where: { email: input.newEmail } });
    if (taken > 0) return;
    const token = await issueToken(staffId, "email_change", { newEmail: input.newEmail });
    await getEmail().send(templates.emailChangeVerify(input.newEmail, staffId, token));
    await getEmail().send(templates.emailChangeNotice(staff.email, staffId, input.newEmail));
  },

  /** Abre el enlace del correo nuevo. Un solo uso, 15 min. Devuelve el id del staff. */
  async confirmEmailChange(token: string): Promise<string> {
    try {
      return await prisma.$transaction(async (tx) => {
        const consumed = await consumeToken(token, "email_change", tx);
        if (!consumed?.newEmail) throw new ApiError(400, "El enlace no es válido, ya se usó o venció.");
        const staff = await tx.staffUser.findUniqueOrThrow({
          where: { id: consumed.staffUserId },
          select: { isActive: true },
        });
        if (!staff.isActive) throw new ApiError(400, "El enlace no es válido, ya se usó o venció.");
        await tx.staffUser.update({ where: { id: consumed.staffUserId }, data: { email: consumed.newEmail } });
        return consumed.staffUserId;
      });
    } catch (err) {
      // Otra cuenta tomó ese correo entre la solicitud y la confirmación.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ApiError(409, "Ese correo ya lo usa otra cuenta.");
      }
      throw err;
    }
  },

  /** Cambia la contraseña y cierra las DEMÁS sesiones (la actual sigue). */
  async changePassword(
    staffId: string,
    currentSessionId: string | undefined,
    input: { currentPassword: string; newPassword: string }
  ) {
    const staff = await loadWithPassword(staffId);
    await requirePassword(staff.passwordHash, input.currentPassword);
    const problems = passwordProblems(input.newPassword, { email: staff.email, name: staff.name });
    if (problems.length) throw new ApiError(400, "La contraseña no cumple la política", problems);
    if (await bcrypt.compare(input.newPassword, staff.passwordHash)) {
      throw new ApiError(400, "La contraseña nueva debe ser distinta de la actual");
    }
    await prisma.staffUser.update({
      where: { id: staffId },
      data: { passwordHash: await bcrypt.hash(input.newPassword, BCRYPT_COST) },
    });
    const closed = await sessionsService.revokeOthers(staffId, currentSessionId, "password_changed");
    await getEmail().send(templates.passwordChanged(staff.email, staffId));
    return { otherSessionsClosed: closed };
  },

  async setAvatar(staffId: string, data: Buffer) {
    // Sin un Content-Type de imagen, express.raw no lee el cuerpo (llega {}): 415.
    if (!Buffer.isBuffer(data)) throw new ApiError(415, "Envía la imagen como image/png, image/jpeg o image/webp");
    if (data.length === 0) throw new ApiError(400, "Falta la imagen");
    if (data.length > MAX_AVATAR_BYTES) throw new ApiError(413, "La imagen supera 300 KB");
    const format = detectImage(data);
    if (!format) throw new ApiError(415, "Solo se aceptan imágenes PNG, JPEG o WebP");
    // Clave generada por el servidor; el sufijo aleatorio cambia la URL con cada avatar.
    const key = `avatars/${staffId}-${randomBytes(4).toString("hex")}.${format.ext}`;
    const storage = getStorage();
    await storage.put(key, data, format.contentType);
    const previous = await prisma.staffUser.findUniqueOrThrow({
      where: { id: staffId },
      select: { avatarStorageKey: true },
    });
    await prisma.staffUser.update({ where: { id: staffId }, data: { avatarStorageKey: key } });
    if (previous.avatarStorageKey) await deleteQuietly(previous.avatarStorageKey);
    return this.get(staffId);
  },

  async deleteAvatar(staffId: string) {
    const previous = await prisma.staffUser.findUniqueOrThrow({
      where: { id: staffId },
      select: { avatarStorageKey: true },
    });
    await prisma.staffUser.update({ where: { id: staffId }, data: { avatarStorageKey: null } });
    if (previous.avatarStorageKey) await deleteQuietly(previous.avatarStorageKey);
    return this.get(staffId);
  },

  /** Avatar de cualquier miembro del staff (lo ven sus compañeros en el panel). */
  async getAvatar(staffId: string) {
    const staff = await prisma.staffUser.findUnique({ where: { id: staffId }, select: { avatarStorageKey: true } });
    if (!staff?.avatarStorageKey) throw new ApiError(404, "Sin avatar");
    const file = await getStorage().get(staff.avatarStorageKey);
    if (!file) throw new ApiError(404, "Sin avatar");
    return file;
  },

  /**
   * Exportación de los datos PERSONALES de un miembro del staff (derecho de
   * acceso, docs/data-retention.md). Incluye su perfil, sus sesiones y su
   * actividad; NO incluye datos de clientes (no son suyos): de las
   * conversaciones que atendió solo van los ids, estados y fechas.
   */
  async export(staffId: string) {
    const profile = await this.get(staffId);
    const [sessions, activity, conversations, sentMessages, calls] = await Promise.all([
      prisma.refreshToken.findMany({
        where: { staffUserId: staffId },
        select: {
          familyId: true,
          createdAt: true,
          revokedAt: true,
          revokeReason: true,
          userAgent: true,
          ipAddress: true,
          locationLabel: true,
        },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
      prisma.auditLog.findMany({
        where: { actorId: staffId },
        select: { action: true, entityType: true, entityId: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 1000,
      }),
      prisma.conversation.findMany({
        where: { assignedAgentId: staffId },
        select: { id: true, status: true, createdAt: true, closedAt: true, closeReason: true },
        orderBy: { createdAt: "desc" },
        take: 1000,
      }),
      prisma.message.count({ where: { senderAgentId: staffId } }),
      prisma.callParticipant.findMany({
        where: { agentId: staffId },
        select: { callId: true, joinedAt: true, leftAt: true },
        orderBy: { joinedAt: "desc" },
        take: 500,
      }),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      format: "atencion-ia/staff-export@1",
      profile,
      sessions,
      activity,
      conversationsHandled: conversations,
      messagesSentCount: sentMessages,
      callParticipations: calls,
      notes: [
        "Las IP de las sesiones están truncadas (x.y.z.0) y la ubicación es aproximada.",
        "No se incluye el contenido de las conversaciones: pertenece a los clientes del banco.",
        "Los registros de auditoría se limitan a los 1000 más recientes.",
      ],
    };
  },
};

async function deleteQuietly(key: string) {
  try {
    await getStorage().delete(key);
  } catch (err) {
    // Un archivo huérfano no rompe nada (nadie lo referencia); se registra para limpiarlo.
    logger.warn({ key, err: err instanceof Error ? err.message : String(err) }, "No se pudo borrar un archivo");
  }
}
