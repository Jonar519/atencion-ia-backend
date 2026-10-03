/**
 * Validación del avatar SUBIDO (no se confía en el Content-Type ni en la
 * extensión que manda el navegador): se miran los "bytes mágicos" del archivo.
 * El recorte y el redimensionado se hacen en el cliente (canvas); el servidor
 * solo acepta PNG, JPEG o WebP de hasta MAX_AVATAR_BYTES.
 */
export const MAX_AVATAR_BYTES = 300 * 1024;

export type AvatarFormat = { ext: "png" | "jpg" | "webp"; contentType: string };

export function detectImage(data: Buffer): AvatarFormat | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: "png", contentType: "image/png" };
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { ext: "jpg", contentType: "image/jpeg" };
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { ext: "webp", contentType: "image/webp" };
  }
  return null;
}
