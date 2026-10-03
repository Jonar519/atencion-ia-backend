import { prisma } from "../config/prisma";
import { purgeStorageDeletions } from "../modules/attachments/attachments.service";

/**
 * Borra del almacenamiento los archivos de adjuntos ya eliminados de la base
 * (cola storage_deletions): lo mismo que hace el worker cada hora.
 * Uso en cmd.exe, desde atencion-ia-backend:  npm run storage:purge
 */
async function main() {
  let total = 0;
  for (let batch = await purgeStorageDeletions(); batch > 0; batch = await purgeStorageDeletions()) total += batch;
  const pending = await prisma.storageDeletion.count();
  console.log(
    `Archivos borrados: ${total}.${pending ? ` Quedan ${pending} que no se pudieron borrar (ver el log).` : ""}`
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
