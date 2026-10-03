import fs from "fs/promises";
import path from "path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "../../config/env";

/**
 * Archivos (avatar del staff; en el bloque C, adjuntos del chat), detrás de una interfaz:
 *  - "local" (por defecto): una carpeta FUERA del repo (STORAGE_LOCAL_DIR,
 *    por defecto ../atencion-ia-storage). Es el "mock" y también sirve en un solo servidor.
 *  - "s3": cualquier servicio compatible con S3 (AWS, MinIO, R2…), con credenciales
 *    que se cargan en el cierre del curso. No hay despliegue en AWS en este proyecto.
 *
 * Las CLAVES las genera siempre el servidor (nunca el nombre que manda el
 * usuario) y se validan contra una expresión estricta: no hay forma de escribir
 * fuera de la carpeta ("../") ni de pisar el archivo de otro.
 */
export interface StoredFile {
  data: Buffer;
  contentType: string;
}

export interface StorageProvider {
  readonly provider: "local" | "s3";
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  delete(key: string): Promise<void>;
}

const KEY = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\.(png|jpg|webp|pdf)$/;
const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
};

export function assertValidKey(key: string): void {
  if (!KEY.test(key) || key.length > 300) throw new Error(`Clave de almacenamiento inválida: ${key}`);
}

export function createLocalStorage(baseDir: string): StorageProvider {
  const root = path.resolve(baseDir);
  const fileFor = (key: string) => {
    assertValidKey(key);
    const file = path.resolve(root, key);
    // Defensa en profundidad: aunque la expresión ya lo impide, nunca fuera de la raíz.
    if (!file.startsWith(root + path.sep)) throw new Error("Ruta fuera del almacenamiento");
    return file;
  };
  return {
    provider: "local",
    async put(key, data) {
      const file = fileFor(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, data);
    },
    async get(key) {
      try {
        const data = await fs.readFile(fileFor(key));
        return { data, contentType: CONTENT_TYPES[key.split(".").pop()!] ?? "application/octet-stream" };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async delete(key) {
      await fs.rm(fileFor(key), { force: true });
    },
  };
}

/** El cliente se inyecta: los tests prueban el adaptador con un doble, sin red ni credenciales. */
export function createS3Storage(options: { bucket: string; client: Pick<S3Client, "send"> }): StorageProvider {
  const { bucket, client } = options;
  return {
    provider: "s3",
    async put(key, data, contentType) {
      assertValidKey(key);
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ContentType: contentType }));
    },
    async get(key) {
      assertValidKey(key);
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const bytes = await res.Body!.transformToByteArray();
        return { data: Buffer.from(bytes), contentType: res.ContentType ?? "application/octet-stream" };
      } catch (err) {
        if ((err as { name?: string }).name === "NoSuchKey") return null;
        throw err;
      }
    },
    async delete(key) {
      assertValidKey(key);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

let current: StorageProvider | null = null;

export function getStorage(): StorageProvider {
  if (current) return current;
  const { provider, localDir, s3 } = env.storage;
  current =
    provider === "s3"
      ? createS3Storage({
          bucket: s3.bucket!,
          client: new S3Client({
            region: s3.region,
            endpoint: s3.endpoint,
            forcePathStyle: Boolean(s3.endpoint),
            credentials: { accessKeyId: s3.accessKeyId!, secretAccessKey: s3.secretAccessKey! },
          }),
        })
      : createLocalStorage(localDir);
  return current;
}

export function setStorageForTests(provider: StorageProvider | null) {
  current = provider;
}
