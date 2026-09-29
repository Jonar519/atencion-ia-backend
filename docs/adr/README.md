# Registros de decisiones de arquitectura (ADR)

Cada ADR explica una decisión: el contexto, lo que se decidió, las alternativas y sus
consecuencias. Las decisiones heredadas del Proyecto 1 se resumen aquí con su evidencia
en este proyecto; las nuevas se justifican completas.

| #                                        | Decisión                                                                   | Estado   |
| ---------------------------------------- | -------------------------------------------------------------------------- | -------- |
| [0001](0001-prisma-solo-como-cliente.md) | Prisma solo como cliente; el esquema vive en `atencion-ia-database`        | Aceptada |
| [0002](0002-esquema-de-sesion.md)        | Access token en memoria + refresh token rotativo en cookie httpOnly        | Aceptada |
| [0003](0003-autorizacion-por-alcance.md) | Autorización por dueño con un único "alcance" por rol, y 404 en vez de 403 | Aceptada |
| [0004](0004-hora-de-la-base-de-datos.md) | Las marcas de tiempo de negocio se toman del reloj de Postgres             | Aceptada |

Formato: Contexto · Decisión · Alternativas consideradas · Consecuencias · Evidencia.
