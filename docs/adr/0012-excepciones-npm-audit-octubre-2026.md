# 0012 — Excepciones temporales de `npm audit` (octubre 2026)

**Estado:** aceptada (auditoría de dependencias del 29-10-2026, aprobada por el usuario).
**Revisión:** nodemailer el **2026-11-01** (**cerrada el 2026-11-04**, ver abajo); body-parser el **2026-11-05**; zod y autocannon el
**2026-11-13** (decisión explícita antes de la entrega del 17 de noviembre: migrar o entregar
con la excepción declarada); minimatch el **2026-11-13**, o antes si eslint pide `minimatch` 11
(sección 5).

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

Quedaban cuatro avisos, que se aceptan aquí de forma temporal. El de nodemailer se cerró el
2026-11-04 (sección 1). El 2026-11-04 apareció un aviso nuevo, solo de desarrollo (`minimatch`,
sección 5), que el usuario aceptó ese mismo día como excepción documentada.

## Decisión

### 1. nodemailer 10.0.13 — moderado, producción — **CERRADA el 2026-11-04**

> **Cierre (2026-11-04, rama `chore/nodemailer`):** `nodemailer` sube a `^10.1.4`. Esa versión
> se publicó el 2026-10-18T11:59:56Z (`npm view nodemailer time`), así que tenía 17 días al
> instalarse. No tiene dependencias, así que no entra ninguna transitiva nueva. El lockfile
> cambia solo en el rango de la raíz y en la entrada `node_modules/nodemailer` (versión,
> `resolved`, `integrity`). Sin `npm audit fix`. `npm audit --omit=dev` ya no muestra
> nodemailer. Pasó el CI local (Windows y una réplica en Linux: Ubuntu 24.04 con Node 24):
> lint, typecheck, 429 tests (también en orden aleatorio), build y 99/99 mutaciones. Las
> mitigaciones de abajo se quedan como defensa aparte.

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

### 5. minimatch 10.2.6 — moderado, solo desarrollo (GHSA-g3hv-75wg-m249) — **excepción aceptada el 2026-11-04**

- **Aviso** (publicado el 2026-10-30, visto en el `npm audit` del 2026-11-04): denegación de
  servicio por amplificación de `globparts`. Afecta a `>=7.0.0 <11.0.1`.
- **Dónde:** solo en desarrollo, por `eslint` 10.11.0 (`^10.2.5`), `@eslint/config-array`
  (`^10.2.4`) y `@typescript-eslint/typescript-estree` 8.71.0 (`^10.2.2`). Ya estaba en `main`
  antes de este cambio (10.2.6), y el paso de producción del CI (`--omit=dev`) no lo ve.
  Explica 10 de los 13 avisos moderados del `npm audit` completo (los otros 3 son la sección 4),
  porque se propaga a eslint y typescript-eslint.
- **Por qué no se corrige hoy:**
  - la única corrección es `11.0.1`, de una versión mayor que la que piden eslint y
    typescript-eslint. Haría falta un override a través de esa versión mayor;
  - además, `11.0.1` se publicó el 2026-10-27 y cumple 14 días el **2026-11-10**.
  - El "arreglo" de `npm audit fix --force` **bajaría** eslint a 9.39.5 y typescript-eslint a
    8.36.0. Se descarta.
- **Exposición:** `minimatch` solo procesa los globs de la configuración de eslint, que son del
  propio repo, no entradas de usuarios.
- **Decisión (2026-11-04, aprobada por el usuario):** se acepta como **excepción documentada**:
  moderado, solo de desarrollo y **sin overrides**. No se fuerza `minimatch` 11 por encima de
  lo que piden eslint y typescript-eslint.
- **Revisión (2026-11-13), o antes** si eslint pasa a pedir `minimatch` 11 y la versión
  corregida ya cumple 14 días (11.0.1, desde el 2026-11-10). La nueva versión de eslint también
  tiene que cumplir los 14 días, y sus transitivas igual.

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
- **Sigue informativo hasta el 13-nov** (decisión del 2026-11-04). Cerrar body-parser el 5-nov
  no basta para volverlo bloqueante: zod sigue siendo un aviso alto de producción y lo dejaría
  en rojo. Se decide el 13-nov, junto con zod. minimatch no cuenta para este paso, que usa
  `--omit=dev`.
- Cada fecha de revisión obliga a cerrar la excepción o renovarla por escrito.

## Evidencia

- `src/app.ts` (`express.json({ limit: "100kb" })`).
- `src/services/email/index.ts` (mock por defecto).
- `src/modules/kb/kb.schema.ts` (`.max(20)`).
- [threat-model.md](../threat-model.md), sección 4.
