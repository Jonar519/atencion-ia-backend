# Registros de decisiones de arquitectura (ADR)

Cada ADR explica una decisión: el contexto, lo que se decidió, las alternativas y sus
consecuencias. Las decisiones heredadas del Proyecto 1 se resumen aquí con su evidencia
en este proyecto; las nuevas se justifican completas.

| #                                                            | Decisión                                                                          | Estado   |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------- |
| [0001](0001-prisma-solo-como-cliente.md)                     | Prisma solo como cliente; el esquema vive en `atencion-ia-database`               | Aceptada |
| [0002](0002-esquema-de-sesion.md)                            | Access token en memoria + refresh token rotativo en cookie httpOnly               | Aceptada |
| [0003](0003-autorizacion-por-alcance.md)                     | Autorización por dueño con un único "alcance" por rol, y 404 en vez de 403        | Aceptada |
| [0004](0004-hora-de-la-base-de-datos.md)                     | Las marcas de tiempo de negocio se toman del reloj de Postgres                    | Aceptada |
| [0005](0005-proveedor-de-ia-intercambiable.md)               | Proveedor de IA intercambiable (Claude + Voyage), mock determinista por defecto   | Aceptada |
| [0006](0006-aislamiento-del-rag.md)                          | Aislamiento del RAG garantizado por la base (trigger), la búsqueda y el historial | Aceptada |
| [0007](0007-motor-conversacional-independiente-del-canal.md) | Un solo motor conversacional para texto y voz                                     | Aceptada |
| [0008](0008-tiempo-real-solo-recepcion.md)                   | WebSocket solo de recepción; destinatarios decididos por una función pura         | Aceptada |
| [0009](0009-sesion-del-widget-en-cookie.md)                  | La sesión del cliente del widget vive en una cookie httpOnly                      | Aceptada |
| [0010](0010-arquitectura-de-voz.md)                          | Voz: audio al STT por WebSocket propio, WebRTC solo entre personas, un solo motor | Aceptada |
| [0011](0011-proveedor-de-voz.md)                             | Proveedor de voz: Deepgram (Nova-3 + Aura-2), mock por defecto                    | Aceptada |

Formato: Contexto · Decisión · Alternativas consideradas · Consecuencias · Evidencia.
