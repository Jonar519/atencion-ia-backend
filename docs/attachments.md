# Adjuntos en el chat de texto (Fase 7, bloque C)

El cliente (widget) y el asesor que atiende el caso (panel) pueden adjuntar **una imagen (PNG,
JPEG, WebP) o un documento PDF** por mensaje, de hasta **5 MB**, con un comentario opcional. El
archivo se guarda con el mismo proveedor de almacenamiento del avatar (`STORAGE_PROVIDER=local`
por defecto, o `s3`). Código: `src/modules/attachments/`. Base: migración 017.

## Lo que NUNCA llega a la IA

Un adjunto es un turno más del motor conversacional, pero **ni el contenido del archivo ni su
nombre** llegan al modelo: los dos los controla quien sube el archivo y pueden traer instrucciones
(un PDF con "ignora tus reglas…", o un archivo llamado así). La IA no analiza el archivo.

| Quién                                                    | Qué recibe de un turno con adjunto                                                                                                                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clasificador (intención, sentimiento)                    | Solo el **comentario** que escribió el cliente. Sin comentario, no se clasifica.                                                                                                                                                |
| Búsqueda en la base de conocimiento (RAG)                | Solo el comentario. Sin comentario, no se busca.                                                                                                                                                                                |
| Modelo que responde, y el historial de turnos siguientes | Una **señal fija** generada por el servidor con el tipo VALIDADO por los bytes, más el comentario: `[El cliente adjuntó un documento PDF. No puedes ver su contenido: si lo necesitas, pídele que te describa lo que muestra.]` |

La señal no va al clasificador a propósito: es texto del servidor y no debe disparar reglas (una
primera versión decía "un asesor lo revisará" y el clasificador lo leía como "pide un asesor":
lo detectó el test de integración).

Pruebas: `tests/integration/attachments.test.ts` espía TODO lo que recibe el proveedor
(clasificador, embeddings y respuesta con su historial) con un PDF cuyo contenido y nombre traen
instrucciones. **Mutaciones** (`npm run test:mutations`, grupo "ADJUNTOS→IA"): agregar el contenido
del archivo al turno, mandar el nombre al modelo, mandarle la señal al clasificador, perder la
señal en el turno o en el historial. Las cinco las detectan los tests.

## Validación del archivo

- **Tipo por los bytes** (firma del archivo), nunca por la extensión ni el `Content-Type`. Un SVG o
  un HTML con extensión `.png`/`.pdf` se rechazan (415). La base también restringe los tipos.
- **Tamaño**: `express.raw` corta a 5 MB antes de leer más (413); la base también lo impone.
- **PDF con contenido activo** (`/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`, `/RichMedia`,
  `/XFA`, también escritos con escapes `#xx`): se rechazan (422). **Es una heurística sobre el
  texto del archivo, no un antivirus**: un nombre dentro de un flujo comprimido pasaría. Por eso,
  además, el PDF se sirve **siempre como descarga** (`Content-Disposition: attachment`) y con
  `Content-Security-Policy: default-src 'none'; sandbox`; nunca se abre dentro de la app.
- **Metadatos de fotos**: el navegador vuelve a dibujar cada imagen en un canvas y la sube como JPEG
  de ≤ 1600 px (se pierden EXIF/GPS). El servidor, además, quita los segmentos EXIF/XMP/IPTC/COM de
  cualquier JPEG que reciba (por si llega por la API sin pasar por el navegador). PNG y WebP que
  lleguen por la API sin pasar por el navegador conservan sus metadatos (no medido / pendiente).
- **Nombre**: solo para mostrar. Sin rutas ni caracteres de control, ≤ 150 caracteres y con la
  extensión del contenido real. Se inserta siempre como texto (nunca HTML).
- **Clave de almacenamiento**: la genera el servidor (`attachments/<conversación>/<uuid>.<ext>`);
  la base exige ese formato.

## Quién puede ver un adjunto

- Cliente: solo los de sus conversaciones (si no, 404). `GET /api/widget/attachments/:id`.
- Staff: solo si puede ver la conversación (misma regla que la API y el WebSocket), y el adjunto
  debe ser de la conversación de la URL. `GET /api/conversations/:id/attachments/:attachmentId`.
- Subir: el cliente en su conversación abierta; el asesor solo en el caso que atiende (como responder).
- Límites: los mismos del mensaje correspondiente más 30 adjuntos por hora por sesión o asesor.

## Retención

Borrar un mensaje o un cliente borra sus adjuntos en cascada; un trigger encola cada archivo en
`storage_deletions` y el worker los borra del almacenamiento en su pasada horaria
(`npm run storage:purge` lo hace a mano). Un archivo cuyo mensaje no llegó a crearse (conversación
cerrada, tope de IA, reenvío duplicado) se borra en el acto.

## No medido / pendiente

- Análisis antivirus real de los PDF (la heurística de arriba no lo reemplaza).
- Metadatos de PNG/WebP subidos por la API sin pasar por el navegador.
- Imágenes HEIC (fotos de iPhone en su formato original): el navegador del cliente decide si las
  convierte; si llegan como HEIC, se rechazan.
