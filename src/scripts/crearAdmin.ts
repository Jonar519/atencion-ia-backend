/**
 * npm run admin:crear -- --correo <correo> --nombre "<nombre>" [--stdin]
 *
 * Crea el PRIMER administrador de Atención en la base de DATABASE_URL (reglas
 * en src/modules/staff/firstAdmin.ts). Pensado para correr desde tu máquina
 * contra el TCP proxy público de Railway, una sola vez; volver a correrlo no
 * cambia nada. Compilado: npm run admin:crear:start (node dist/scripts/crearAdmin.js).
 *
 * La contraseña NUNCA va en un argumento ni en una variable de entorno (quedaría
 * en el historial o en la lista de procesos):
 *  - por defecto se pide dos veces en la terminal, sin eco;
 *  - con --stdin se lee la primera línea de la entrada estándar (un archivo
 *    redirigido o un gestor de contraseñas), sin confirmación.
 * Ni la contraseña ni su hash se imprimen. Solo usa DATABASE_URL: no lee el
 * .env ni necesita el resto de la configuración de la API.
 *
 * Códigos de salida: 0 creado o nada que hacer (el correo ya existe / ya hay
 * un admin), 1 error, 2 uso incorrecto.
 */
import type { Prisma } from "@prisma/client";
import {
  createFirstAdmin,
  firstAdminPasswordProblems,
  firstAdminState,
  FirstAdminInputError,
  parseFirstAdminInput,
  type FirstAdminResult,
} from "../modules/staff/firstAdmin";

export const USAGE = 'Uso: npm run admin:crear -- --correo <correo> --nombre "<nombre>" [--stdin]';

export interface CliIo {
  env: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
  /** Lee una línea sin eco desde la terminal; null si no hay terminal interactiva. */
  readHidden: ((prompt: string) => Promise<string>) | null;
  /** Toda la entrada estándar (modo --stdin). */
  readStdin(): Promise<string>;
}

export interface CliDb {
  $transaction<R>(fn: (tx: Prisma.TransactionClient) => Promise<R>): Promise<R>;
  $disconnect(): Promise<void>;
}

interface Args {
  email?: string;
  name?: string;
  stdin: boolean;
  help: boolean;
}

class UsageError extends Error {}

/** El usuario canceló con Ctrl+C mientras escribía la contraseña. */
export class PromptAbortedError extends Error {}

export function parseArgs(argv: string[]): Args {
  const args: Args = { stdin: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? "";
    const [flag, inline] =
      raw.startsWith("--") && raw.includes("=")
        ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)]
        : [raw, undefined];
    const value = () => {
      const next = inline ?? argv[++i];
      if (next === undefined || (inline === undefined && next.startsWith("--")))
        throw new UsageError(`Falta el valor de ${flag}`);
      return next;
    };
    switch (flag) {
      case "--correo":
        args.email = value();
        break;
      case "--nombre":
        args.name = value();
        break;
      case "--stdin":
        args.stdin = true;
        break;
      case "--ayuda":
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--contrasena":
      case "--contraseña":
      case "--password":
        throw new UsageError("La contraseña no se pasa por argumento: se pide sin eco en la terminal (o con --stdin).");
      default:
        throw new UsageError(`Argumento desconocido: ${flag}`);
    }
  }
  return args;
}

/**
 * Procesa lo tecleado en modo crudo. Enter (o Ctrl+D) termina, Ctrl+C cancela,
 * Retroceso borra; las secuencias de escape (flechas) y otros controles se ignoran.
 */
export function consumeHiddenInput(value: string, chunk: string): { value: string; done: boolean; aborted: boolean } {
  if (chunk.startsWith("\u001b")) return { value, done: false, aborted: false };
  let current = value;
  for (const ch of chunk) {
    if (ch === "\r" || ch === "\n" || ch === "\u0004") return { value: current, done: true, aborted: false };
    if (ch === "\u0003") return { value: "", done: true, aborted: true };
    if (ch === "\u007f" || ch === "\b") {
      current = Array.from(current).slice(0, -1).join("");
      continue;
    }
    if (ch < " ") continue;
    current += ch;
  }
  return { value: current, done: false, aborted: false };
}

const BOM = String.fromCharCode(0xfeff);

/** Primera línea de la entrada estándar, sin BOM ni salto de línea. */
export function firstLine(text: string): string {
  return ((text.startsWith(BOM) ? text.slice(1) : text).split(/\r?\n/)[0] ?? "").trimEnd();
}

function report(io: CliIo, email: string, result: FirstAdminResult): number {
  switch (result.kind) {
    case "created":
      io.out(`Administrador creado: ${email} (id ${result.staffId}).`);
      io.out(
        "Al iniciar sesión, la aplicación le pedirá activar la verificación en dos pasos (obligatoria para admin)."
      );
      return 0;
    case "email_exists":
      io.out(
        `El correo ${email} ya tiene una cuenta (rol ${result.role}, ${result.state}). No se cambió nada: ni el rol ni la contraseña.`
      );
      return 0;
    case "admin_exists":
      io.out(
        `Ya hay ${result.count === 1 ? "un administrador activo" : `${result.count} administradores activos`}. ` +
          'No se creó otro: los demás se invitan desde "Equipo".'
      );
      return 0;
  }
}

/** Mensaje seguro para un error inesperado: los de Prisma pueden traer los argumentos de la consulta. */
function safeErrorMessage(err: unknown): string {
  if (err instanceof Error && err.name === "PrismaClientInitializationError") return err.message.trim();
  const code = (err as { code?: unknown })?.code;
  const name = err instanceof Error ? err.name : "Error";
  return typeof code === "string" ? `${name} (${code})` : name;
}

async function readPassword(io: CliIo, fromStdin: boolean): Promise<string | null> {
  if (fromStdin) return firstLine(await io.readStdin());
  if (!io.readHidden) {
    io.err(
      "No hay una terminal interactiva para pedir la contraseña sin eco. Corre el comando en PowerShell o cmd " +
        "(en Git Bash, antepón winpty) o pásala con --stdin."
    );
    return null;
  }
  const first = await io.readHidden("Contraseña del administrador: ");
  const second = await io.readHidden("Repite la contraseña: ");
  if (first !== second) {
    io.err("Las contraseñas no coinciden. No se creó nada.");
    return null;
  }
  return first;
}

export async function run(argv: string[], io: CliIo, openDb: (url: string) => Promise<CliDb>): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(err.message);
    io.err(USAGE);
    return 2;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }
  if (!args.email || !args.name) {
    io.err("Faltan --correo y/o --nombre.");
    io.err(USAGE);
    return 2;
  }

  let input;
  try {
    input = parseFirstAdminInput({ email: args.email, name: args.name });
  } catch (err) {
    if (!(err instanceof FirstAdminInputError)) throw err;
    for (const problem of err.problems) io.err(`Dato inválido: ${problem}`);
    return 1;
  }

  const url = io.env.DATABASE_URL;
  if (!url) {
    io.err(
      "Falta la variable de entorno DATABASE_URL: la URL pública del Postgres (en la plantilla pgvector de " +
        "Railway, la variable DATABASE_URL del servicio Postgres; no la privada, que solo funciona dentro de Railway)."
    );
    return 1;
  }

  const db = await openDb(url);
  try {
    // Antes de pedir la contraseña: si no hay nada que hacer, no se pide.
    const state = await db.$transaction((tx) => firstAdminState(tx, input.email));
    if (state.kind !== "ready") return report(io, input.email, state);

    const password = await readPassword(io, args.stdin);
    if (password === null) return 1;
    const problems = firstAdminPasswordProblems(input, password);
    if (problems.length) {
      io.err("La contraseña no cumple la política (la misma del registro):");
      for (const problem of problems) io.err(`  - ${problem}`);
      return 1;
    }

    const result = await db.$transaction((tx) => createFirstAdmin(tx, input, password));
    return report(io, input.email, result);
  } catch (err) {
    if (err instanceof PromptAbortedError) {
      io.err("Cancelado. No se creó nada.");
      return 1;
    }
    if (err instanceof FirstAdminInputError) {
      for (const problem of err.problems) io.err(`  - ${problem}`);
      return 1;
    }
    // Carrera con otra corrida que creó el mismo correo entre la lectura y el alta.
    if ((err as { code?: unknown })?.code === "P2002") {
      io.out(`El correo ${input.email} ya tiene una cuenta. No se cambió nada.`);
      return 0;
    }
    io.err(`No se pudo crear el administrador: ${safeErrorMessage(err)}`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}

function hiddenPrompt(stdin: NodeJS.ReadStream, prompt: NodeJS.WriteStream) {
  return (text: string) =>
    new Promise<string>((resolve, reject) => {
      let value = "";
      const finish = () => {
        stdin.off("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
        prompt.write("\n");
      };
      const onData = (chunk: Buffer | string) => {
        const step = consumeHiddenInput(value, chunk.toString("utf8"));
        value = step.value;
        if (!step.done) return;
        finish();
        if (step.aborted) reject(new PromptAbortedError());
        else resolve(value);
      };
      prompt.write(text);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
    });
}

function readAll(stdin: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stdin.on("error", reject);
  });
}

async function main() {
  const io: CliIo = {
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    // Las preguntas van a stderr: stdout queda solo con el resultado.
    readHidden: process.stdin.isTTY ? hiddenPrompt(process.stdin, process.stderr) : null,
    readStdin: () => readAll(process.stdin),
  };
  const openDb = async (url: string): Promise<CliDb> => {
    // Import diferido y URL explícita: la base es SIEMPRE la de DATABASE_URL de la
    // sesión, nunca la del .env que el cliente de Prisma cargaría si faltara.
    const { PrismaClient } = await import("@prisma/client");
    return new PrismaClient({ datasourceUrl: url, log: [] });
  };
  process.exitCode = await run(process.argv.slice(2), io, openDb);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`Error inesperado: ${safeErrorMessage(err)}\n`);
    process.exitCode = 1;
  });
}
