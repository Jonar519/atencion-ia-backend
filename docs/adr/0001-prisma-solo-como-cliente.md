# 0001 · Prisma solo como cliente

**Contexto.** El esquema tiene reglas que Prisma no sabe expresar y que son parte del
diseño: CHECKs de coherencia de estados, índices únicos PARCIALES (un escalamiento
abierto por conversación, una llamada activa por conversación), FKs compuestas, una
columna calculada (`calls.duration_seconds`), el tipo `vector` de pgvector y triggers.

**Decisión.** Igual que en el Proyecto 1: el esquema vive en `atencion-ia-database`
(migraciones SQL numeradas). Este repo lo lee con `npx prisma db pull` y **nunca** usa
`prisma migrate` ni `prisma db push`. Los modelos se renombran a PascalCase/camelCase con
`@@map`/`@map`.

**Alternativas.** `prisma migrate` como dueño del esquema: perdería los índices
parciales y los CHECKs (o obligaría a editarlos a mano en cada migración generada).

**Consecuencias.**

- Los tests de integración aplican las migraciones REALES del repo hermano
  (`tests/globalSetup.ts`), así que prueban contra las mismas restricciones que
  producción: por ejemplo, un CHECK de la base detectó el problema de la ADR 0004.
- `kb_chunks.embedding` se lee y escribe con SQL crudo (Fase 3).
- `calls.duration_seconds` aparece en Prisma como un campo con "default": es de solo
  lectura y nunca se escribe.

**Evidencia (medida).** Un nuevo `db pull` sobre el esquema renombrado **conserva** los
renombres de modelos, campos y enums y los comentarios `///`, pero **borra** los
comentarios `//`. Por eso la explicación de lo que Prisma no representa está en el README
y no en `schema.prisma`.
