import { prisma } from "../config/prisma";
import { normalizeEmail } from "../modules/auth/auth.service";

/**
 * Quita la verificación en dos pasos de UNA cuenta, directo en la base a la
 * que apunta DATABASE_URL (no hay endpoint para esto, a propósito: ni otro
 * admin puede hacerlo desde la API). Para:
 *  - un admin que perdió el teléfono Y sus códigos de respaldo (procedimiento
 *    manual, con acceso al servidor; queda en la auditoría);
 *  - los entornos de prueba (E2E, carga), para que el admin del seed vuelva a
 *    enrolarse en cada corrida.
 * Un admin sin MFA debe activarla de nuevo en su próximo inicio de sesión.
 * También cierra sus sesiones.
 *
 * Uso en cmd.exe, desde atencion-ia-backend:  npm run staff:reset-mfa -- correo@ejemplo.com
 */
async function main() {
  const raw = process.argv[2];
  if (!raw) throw new Error("Uso: npm run staff:reset-mfa -- correo@ejemplo.com");
  const email = normalizeEmail(raw);
  const staff = await prisma.staffUser.findUnique({ where: { email }, select: { id: true, mfaEnabledAt: true } });
  if (!staff) throw new Error(`No existe una cuenta con el correo ${email}`);
  await prisma.$transaction([
    prisma.staffUser.update({
      where: { id: staff.id },
      data: { mfaEnabledAt: null, mfaSecretEncrypted: null, mfaLastUsedStep: null },
    }),
    prisma.mfaBackupCode.deleteMany({ where: { staffUserId: staff.id } }),
    prisma.staffToken.deleteMany({ where: { staffUserId: staff.id, usedAt: null } }),
    prisma.refreshToken.updateMany({
      where: { staffUserId: staff.id, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: "logout" },
    }),
    prisma.auditLog.create({
      data: {
        actorType: "system",
        actorId: null,
        action: "mfa.disabled",
        entityType: "staff_user",
        entityId: staff.id,
        metadata: { via: "cli:staff:reset-mfa" },
      },
    }),
  ]);
  console.log(
    staff.mfaEnabledAt
      ? `Verificación en dos pasos quitada a ${email}. Deberá activarla de nuevo si es admin.`
      : `${email} no tenía la verificación activa (se limpiaron sus pasos pendientes).`
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
