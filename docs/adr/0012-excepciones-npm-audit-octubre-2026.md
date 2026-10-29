# 0012 — Excepciones temporales de `npm audit` (octubre 2026)

**Estado:** aceptada (auditoría de dependencias del 29-10-2026, aprobada por el usuario).
**Revisión:** nodemailer el **2026-11-01**; body-parser el **2026-11-05**; zod y autocannon el
**2026-11-13** (decisión explícita antes de la entrega del 17 de noviembre: migrar o entregar
con la excepción declarada).

## Contexto

La auditoría del 29-10-2026 (`npm audit`) encontró avisos que no se pueden corregir hoy sin
romper una de estas dos reglas:

- **Regla de 14 días:** toda versión nueva que entra al lockfile debe llevar al menos 14 días
  publicada en npm (también las transitivas).
- **Sin cambios mayores a ciegas:** una versión mayor de una dependencia de producción exige su
  propia migración y pruebas.

En la rama `chore/audit-oct` ya se corrigió lo que cumplía ambas reglas:

- `ip-address` 10.7.4, `qs` 6.16.1 y `source-map-js` 1.2.2 (solo lockfile).
- `vite` 8.3.4 por override, con sus transitivas (`rolldown` 1.2.14, `postcss` 8.5.30…), todas
  con 14 días o más.
- `vitest` 4.1.12, que quita el moderado de `@vitest/mocker`.

Quedan cuatro avisos, que se aceptan aquí de forma temporal.

## Decisión

### 1. nodemailer 10.0.13 — moderado, producción

Avisos: GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w y GHSA-85x2-q946-cp5h.

- **Aviso:** el `addressparser` interpreta mal comentarios, `;` o `>` dentro de comillas, y
  puede convertir texto en un destinatario extra.
- **Por qué no se corrige hoy:** la corrección, `10.1.4`, se publicó el 2026-10-18 y cumple 14
  días el **2026-11-01**.
- **Cómo se corregirá:** es una dependencia directa: subir a `^10.1.4`.
- **Mitigación mientras tanto:**
  - Todo destinatario sale de una dirección validada con `z.string().email().max(254)`
    (`auth.schema.ts`, `profile.schema.ts`, `staff.schema.ts`), que rechaza comillas,
    paréntesis, `;`, `<` y `>`.
  - La base lo vuelve a exigir con un `CHECK` (`004_staff_users.sql`, `015_staff_identity.sql`).
  - El proveedor por defecto es `mock`, que no usa nodemailer: SMTP solo se activa con
    credenciales reales.

### 2. body-parser 1.20.8 — alto, producción (GHSA-27r3-jxmh-p828)

- **Aviso:** denegación de servicio con bytes sobrantes después de un cuerpo comprimido.
- **Por qué no se corrige hoy:** la corrección, `1.20.9`, se publicó el 2026-10-22 y cumple 14
  días el **2026-11-05**.
- **Cómo se corregirá:** `express` 4.22.3 pide `~1.20.5`, así que basta con
  `npm update body-parser` (solo el lockfile, sin override).
- **Mitigación mientras tanto:** `express.json({ limit: "100kb" })` (`src/app.ts`) acota el
  tamaño del cuerpo, y el limitador global por IP (Redis) frena la repetición. Esto reduce el
  impacto, pero no lo elimina.

### 3. zod 3.25.76 — alto, producción (GHSA-mrhx-c7xc-m3w5)

- **Aviso:** validar colecciones muy grandes con restricciones puede agotar la memoria.
- **Por qué no se corrige hoy:** no hay corrección en zod 3. La primera versión corregida es
  `4.6.6` (versión mayor). `@anthropic-ai/sdk` ya acepta `^4.0.0`, pero hay 17 archivos con
  esquemas zod: es una migración aparte, no un parche.
- **Mitigación mientras tanto:**
  - Todo cuerpo JSON se corta en 100 KB.
  - Revisión de los arrays zod del código (29-10-2026). El único array que valida datos de un
    cliente HTTP es `tags` en `kb.schema.ts`, y tiene `.max(20)`. Los que no tienen `.max()`
    validan datos de confianza, no peticiones:
    - `src/config/env.ts`: `urls` dentro de `iceServers`. Viene de una variable de entorno, y
      el array externo sí tiene `.max(5)`.
    - `src/services/ai/voyage.provider.ts`: `data` y `embedding`. Es la respuesta de la API de
      Voyage por HTTPS, enviada en lotes de 64 textos como máximo.
- **Revisión (2026-11-13):** decisión explícita antes de la entrega del 17 de noviembre: migrar o
  entregar con la excepción declarada.

### 4. uuid 8.3.2 / hyperid 3.3.0 / autocannon 8.0.0 — moderado, solo desarrollo (GHSA-w5hq-g745-h8pq)

- **Aviso:** falta una comprobación de límites del buffer en uuid v3/v5/v6 cuando se pasa
  `buf`.
- **Por qué no se corrige:** `autocannon` solo se usa en las pruebas de carga (`loadtests/`) y
  no llega a producción. El "arreglo" de `npm audit fix --force` **bajaría** autocannon a 2.0.1,
  lo que no tiene sentido.
- **Revisión (2026-11-13):** comprobar si hay una versión de autocannon/hyperid que use
  `uuid >= 11.1.1`. Decisión explícita antes de la entrega del 17 de noviembre: migrar o
  entregar con la excepción declarada.

## Alternativas consideradas

- **Instalar las versiones nuevas ya:** rompe la regla de 14 días, cuyo fin es no ser de los
  primeros en instalar una versión comprometida.
- **`npm audit fix --force`:** sube zod a 4.x y baja autocannon a 2.0.1 sin revisión. Se
  descarta.

## Consecuencias

- Desde la rama `ci/security-informativo`, el paso de `npm audit` de producción del job `security`
  (`npm audit --omit=dev --audit-level=moderate`) es **informativo** (`continue-on-error: true`).
  El job queda en verde aunque el audit siga mostrando nodemailer, body-parser y zod.
- **El log del paso sigue siendo la evidencia:** ahí se ven los avisos en cada push.
- **Vuelve a ser bloqueante al cerrar body-parser y nodemailer (5-nov).** Desde entonces solo zod
  lo hará fallar, con decisión el 13-nov.
- Cada fecha de revisión obliga a cerrar la excepción o renovarla por escrito.

## Evidencia

- `src/app.ts` (`express.json({ limit: "100kb" })`).
- `src/services/email/index.ts` (mock por defecto).
- `src/modules/kb/kb.schema.ts` (`.max(20)`).
- [threat-model.md](../threat-model.md), sección 4.
