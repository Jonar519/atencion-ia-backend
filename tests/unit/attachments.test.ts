import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_PLACEHOLDER,
  attachmentSignal,
  detectAttachment,
  displayName,
  pdfDangerousFeatures,
  stripJpegMetadata,
  textForAi,
} from "../../src/modules/attachments/fileChecks";

/** Segmento JPEG: FF <marcador> <largo de 2 bytes, incluye los 2 del largo> <datos>. */
function segment(marker: number, payload: Buffer | string) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "latin1");
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

/** JPEG mínimo con EXIF (que trae un "GPS"), XMP, IPTC y un comentario, más los segmentos de la imagen. */
export function jpegWithMetadata() {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, "JFIF\0\x01\x01\0\0\x01\0\x01\0\0"),
    segment(0xe1, "Exif\0\0GPS-SECRETO 4.6097,-74.0817"),
    segment(0xe1, "http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>XMP-SECRETO</x:xmpmeta>"),
    segment(0xed, "Photoshop 3.0\0IPTC-SECRETO"),
    segment(0xfe, "COMENTARIO-SECRETO"),
    segment(0xdb, Buffer.alloc(65, 1)),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6]),
    Buffer.from("datos-de-la-imagen", "latin1"),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const pdf = (body: string) => Buffer.from(`%PDF-1.7\n${body}\n%%EOF`, "latin1");

describe("tipo del adjunto: por los BYTES, no por el nombre ni el Content-Type", () => {
  it("reconoce PNG, JPEG, WebP y PDF", () => {
    expect(detectAttachment(PNG)?.contentType).toBe("image/png");
    expect(detectAttachment(jpegWithMetadata())?.contentType).toBe("image/jpeg");
    expect(detectAttachment(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))?.ext).toBe(
      "webp"
    );
    expect(detectAttachment(pdf("1 0 obj << >> endobj"))).toMatchObject({ ext: "pdf", label: "PDF" });
  });

  it("rechaza SVG, HTML, ejecutables, ZIP/DOCX y texto aunque se llamen .pdf o .png", () => {
    for (const content of [
      '<svg onload="alert(1)"/>',
      "<html><script>",
      "MZ\x90\0",
      "PK\x03\x04word/",
      "hola",
      "GIF89a",
    ]) {
      expect(detectAttachment(Buffer.from(content, "latin1")), content).toBeNull();
    }
  });
});

describe("PDF: contenido activo (heurística documentada)", () => {
  it("un PDF normal pasa", () => {
    expect(pdfDangerousFeatures(pdf("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj"))).toEqual([]);
  });

  it.each([
    ["/JavaScript", "<< /S /JavaScript /JS (app.alert(1)) >>", ["/javascript", "/js"]],
    ["/Launch", "<< /S /Launch /F (calc.exe) >>", ["/launch"]],
    ["/EmbeddedFile", "<< /Type /EmbeddedFile >>", ["/embeddedfile"]],
    ["nombre ofuscado con #xx", "<< /S /J#61vaScript >>", ["/javascript"]],
  ])("se rechaza: %s", (_name, body, expected) => {
    expect(pdfDangerousFeatures(pdf(body))).toEqual(expect.arrayContaining(expected));
  });

  it("no confunde /JSON ni /Jsomething con /JS", () => {
    expect(pdfDangerousFeatures(pdf("<< /JSON 1 /Jsomething 2 >>"))).toEqual([]);
  });
});

describe("JPEG: se quitan los metadatos (EXIF puede traer la ubicación GPS)", () => {
  it("quita EXIF, XMP, IPTC y comentarios; conserva la imagen", () => {
    const original = jpegWithMetadata();
    const clean = stripJpegMetadata(original).toString("latin1");
    for (const secret of ["GPS-SECRETO", "XMP-SECRETO", "IPTC-SECRETO", "COMENTARIO-SECRETO"]) {
      expect(clean).not.toContain(secret);
    }
    expect(clean).toContain("JFIF");
    expect(clean).toContain("datos-de-la-imagen");
    expect(clean.endsWith("\xff\xd9")).toBe(true);
  });

  it("un JPEG truncado o mal formado se rechaza (no se guarda a medias)", () => {
    expect(() => stripJpegMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1, 2]))).toThrow();
    expect(() => stripJpegMetadata(Buffer.from([0xff, 0xd8, 0x00, 0x00]))).toThrow();
  });
});

describe("nombre para mostrar", () => {
  it("sin rutas ni caracteres de control, con la extensión REAL del contenido", () => {
    const kind = detectAttachment(pdf("x"))!;
    expect(displayName("C:\\Users\\ana\\..\\factura de luz.exe", kind)).toBe("factura de luz.pdf");
    expect(displayName("../../etc/passwd", kind)).toBe("passwd.pdf");
    expect(displayName("a\u0000b\u001b[31mc.pdf", kind)).toBe("ab[31mc.pdf");
    expect(displayName("", kind)).toBe("documento.pdf");
    expect(displayName("x".repeat(400), kind).length).toBeLessThanOrEqual(150);
  });
});

describe("lo que ve la IA de un turno con adjunto", () => {
  it("solo la SEÑAL fija con el tipo; el comentario del cliente va aparte", () => {
    expect(textForAi(ATTACHMENT_PLACEHOLDER, "application/pdf")).toBe(attachmentSignal("application/pdf"));
    expect(textForAi("¿Me ayudas con esta factura?", "image/jpeg")).toBe(
      `${attachmentSignal("image/jpeg")}\n¿Me ayudas con esta factura?`
    );
    expect(attachmentSignal("application/pdf")).toMatch(/un documento PDF\. No puedes ver su contenido/);
    expect(attachmentSignal("image/png")).toMatch(/una imagen\. No puedes ver su contenido/);
  });

  it("sin adjunto, el texto pasa igual que siempre", () => {
    expect(textForAi("Hola", null)).toBe("Hola");
  });
});
