import type { Prisma } from "@prisma/client";

/**
 * "Ahora" según el reloj de POSTGRES (now() = inicio de la transacción), no
 * el de Node.
 *
 * Las columnas created_at se llenan con now() en la base, y los CHECKs exigen
 * assigned_at >= created_at, resolved_at >= created_at, closed_at >= created_at.
 * Si la API usara new Date() y su reloj estuviera unos milisegundos atrasado
 * respecto al de la base (API y RDS son máquinas distintas), esas escrituras
 * fallarían de forma intermitente. Tomando la hora de la base DENTRO de la
 * transacción, todo lo confirmado antes tiene una hora ≤ a esta.
 * (Lo detectó el CHECK chk_escalations_assigned_after_created en los tests.)
 */
export async function dbNow(tx: Prisma.TransactionClient): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return row!.now;
}
