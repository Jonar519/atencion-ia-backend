import { prisma } from "../config/prisma";
import { callsService } from "../modules/voice/calls.service";
import { flushAudit } from "../services/audit/audit.service";

/**
 * Purga manual de transcripciones vencidas (lo mismo que hace el worker cada
 * hora). Uso en cmd.exe, desde atencion-ia-backend:  npm run voice:purge
 */
async function main() {
  let total = 0;
  for (
    let batch = await callsService.purgeExpiredTranscripts();
    batch > 0;
    batch = await callsService.purgeExpiredTranscripts()
  ) {
    total += batch;
  }
  await flushAudit();
  console.log(total ? `Transcripciones purgadas: ${total} llamada(s).` : "No hay transcripciones vencidas.");
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
