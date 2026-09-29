import { PrismaClient } from "@prisma/client";
import { env } from "./env";
import { logger } from "./logger";

// Prisma NO imprime sus errores por consola: el mensaje de una consulta
// fallida puede incluir sus argumentos (un passwordHash, el texto de un
// mensaje). Los errores se lanzan igual y error.middleware.ts decide qué se
// loguea. Los warnings sí van al logger estructurado.
export const prisma = new PrismaClient({
  datasourceUrl: env.databaseUrl,
  log: [{ emit: "event", level: "warn" }],
});

prisma.$on("warn", (event) => logger.warn({ target: event.target }, event.message));
