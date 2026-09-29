# atencion-ia-backend

API REST, WebSocket (mensajería en tiempo real y señalización WebRTC) y workers de IA de
**Atención al cliente omnicanal con IA**: un cliente escribe o llama desde el navegador,
una IA con RAG sobre la base de conocimiento de la empresa responde, y cuando no puede
resolver (fraude, cliente molesto, pide un humano…) la conversación se escala a un agente.

## Estado por fase

| Fase | Contenido                                                                                                   | Estado    |
| ---- | ----------------------------------------------------------------------------------------------------------- | --------- |
| 2    | Identidad del staff, autorización por rol y por dueño, base de conocimiento, conversaciones, observabilidad | ✅        |
| 3    | IA: proveedor intercambiable (`AI_PROVIDER=mock` por defecto), RAG, intención/sentimiento, escalamiento     | ✅        |
| 4    | WebSocket de tiempo real (solo recepción), sesión del widget en cookie httpOnly, frontend                   | ✅        |
| 5    | Voz: señalización WebRTC, STT/TTS (`VOICE_PROVIDER=mock`)                                                   | pendiente |

## Stack

Node.js 20+ · TypeScript · Express 4 · Prisma 6 (solo como cliente) · PostgreSQL 16 +
pgvector · Redis 7 (rate limiting, colas BullMQ y pub/sub de tiempo real) · zod ·
pino · prom-client · ws · Vitest + supertest.

## Relación con los otros repositorios

| Repositorio            | Relación                                                                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atencion-ia-database` | Dueño del esquema **y** del `docker-compose.yml` con Postgres (5434) y Redis (6380). Este repo lo **introspecciona** (`npx prisma db pull`); nunca crea ni altera tablas. Los tests aplican sus migraciones desde `../atencion-ia-database/migrations`, así que **las tres carpetas deben ser hermanas**. |
| `atencion-ia-frontend` | Cliente de esta API y del WebSocket (Fase 4). Su servidor de Vite reenvía `/api` y `/ws` aquí: mismo origen.                                                                                                                                                                                              |

## Primera vez (Windows, cmd.exe)

```bat
:: 1. Base de datos y Redis (en el repo hermano)
cd ..\atencion-ia-database
docker compose up -d
scripts\migrate.bat
scripts\seed.bat
cd ..\atencion-ia-backend

:: 2. Dependencias y cliente de Prisma
npm install
npx prisma generate

:: 3. Configuración: copia y pon secretos propios
copy .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
::    (pega un valor en JWT_SECRET y OTRO distinto en IP_HASH_SECRET, dentro de .env)

:: 4. Indexar la base de conocimiento del seed para el RAG (una vez; vienen sin embeddings)
npm run kb:reindex

:: 5. Arrancar en desarrollo (recarga al guardar), en DOS ventanas de cmd:
npm run dev
npm run worker
```

La API queda en `http://localhost:4100` y el worker expone `/health` en `:9465`. Para detenerla: **Ctrl+C** (hace el apagado
ordenado; cmd.exe envía SIGINT, que sigue el mismo camino que el SIGTERM de producción).

Producción local (compilado): `npm run build` y luego `npm start`.

## Scripts

| Comando                       | Qué hace                                                             |
| ----------------------------- | -------------------------------------------------------------------- |
| `npm run dev`                 | Servidor con recarga automática (tsx)                                |
| `npm run build` / `npm start` | Compila a `dist/` / ejecuta lo compilado                             |
| `npm test`                    | Tests unitarios y de integración (recrea la base `atencion_ia_test`) |
| `npm run lint`                | ESLint + Prettier (verificación, no modifica)                        |
| `npm run format`              | Aplica Prettier                                                      |
| `npm run typecheck`           | `tsc` del código y de los tests                                      |
| `npm run prisma:pull`         | Re-introspecciona el esquema tras una migración nueva                |
| `scripts\verify.bat`          | lint → typecheck → tests → build (lo mismo que la CI)                |
| `npm run worker`              | Worker de colas: indexación del RAG y avisos de escalamiento (tsx)   |
| `npm run worker:start`        | Worker compilado (tras `npm run build`)                              |
| `npm run kb:reindex`          | Re-indexa TODA la KB para el RAG, sin necesitar el worker            |
| `npm run rag:calibrate`       | Mide la calidad del RAG y ayuda a elegir `RAG_MIN_SCORE`             |
| `npm run test:shuffle`        | Tests en orden aleatorio (detecta dependencias entre tests)          |
| `npm run test:mutations`      | Rompe a propósito cada regla crítica y exige que los tests fallen    |

## Configuración (`.env`)

Se valida con zod al arrancar: si algo falta o es inseguro, **el servidor no arranca** y
dice qué corregir. Ver `.env.example` (comentado).

| Variable                                          | Por defecto                       | Nota                                                                                     |
| ------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                    | — (obligatoria)                   | `postgresql://postgres:postgres@localhost:5434/atencion_ia`                              |
| `REDIS_URL`                                       | `redis://localhost:6380`          |                                                                                          |
| `PORT`                                            | `4100`                            | 4000 lo usa el Proyecto 1                                                                |
| `JWT_SECRET`, `IP_HASH_SECRET`                    | — (obligatorias)                  | ≥ 32 caracteres, distintas entre sí                                                      |
| `JWT_EXPIRES_IN` / `REFRESH_TOKEN_TTL_DAYS`       | `15m` / `7`                       |                                                                                          |
| `CORS_ORIGIN`                                     | `http://localhost:5174`           | Obligatoria en producción                                                                |
| `TRUST_PROXY`                                     | `0`                               | `1` detrás de un balanceador                                                             |
| `METRICS_TOKEN`                                   | vacío (= `/metrics` responde 404) | ≥ 16 caracteres                                                                          |
| `SHUTDOWN_TIMEOUT_MS` / `SHUTDOWN_DRAIN_DELAY_MS` | `10000` / `0`                     |                                                                                          |
| `RATE_LIMIT_SCALE`                                | `1`                               | Solo pruebas de carga; prohibido en producción                                           |
| `AI_PROVIDER`                                     | `mock`                            | `anthropic` exige `ANTHROPIC_API_KEY` y `VOYAGE_API_KEY`; `mock` prohibido en producción |
| `ANTHROPIC_MODEL` / `ANTHROPIC_CLASSIFIER_MODEL`  | `claude-opus-5-5`                 | Ver [ADR 0005](docs/adr/0005-proveedor-de-ia-intercambiable.md)                          |
| `VOYAGE_MODEL`                                    | `voyage-3.5`                      | Embeddings de 1024 dimensiones                                                           |
| `RAG_TOP_K` / `RAG_MIN_SCORE`                     | `4` / 0.2 (mock), 0.45 (Voyage)   | El de Voyage está **sin calibrar** ([docs/rag.md](docs/rag.md))                          |
| `AI_DAILY_TOKEN_BUDGET_PER_CUSTOMER`              | `60000`                           | Tope diario de tokens por cliente                                                        |
| `WORKER_CONCURRENCY` / `WORKER_METRICS_PORT`      | `2` / `9465`                      |                                                                                          |

## API

Todas las rutas bajo `/api` exigen `Authorization: Bearer <accessToken>`, salvo
`/api/auth/login`, `/refresh` y `/logout`. Errores: `{ error, details? }`; los de
validación traen `details: [{ field, message }]` en español.

| Método y ruta                                                 | Quién                                    | Qué hace                                                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/auth/login`                                        | público                                  | `{ email, password }` → `{ accessToken, staff }` + cookie de refresh                                                                             |
| `POST /api/auth/refresh`                                      | cookie + `X-Requested-With: atencion-ia` | Rota el refresh y entrega un access token nuevo                                                                                                  |
| `POST /api/auth/logout`                                       | cookie + `X-Requested-With: atencion-ia` | Revoca la sesión                                                                                                                                 |
| `GET /api/auth/me`                                            | staff                                    | Datos propios                                                                                                                                    |
| `PATCH /api/staff/me/availability`                            | staff                                    | `{ availability: offline\|available\|busy\|away }`                                                                                               |
| `GET /api/staff` · `POST /api/staff` · `PATCH /api/staff/:id` | **admin**                                | Gestión de cuentas (política de contraseñas; desactivar cierra sesiones)                                                                         |
| `GET /api/kb/articles` · `GET /api/kb/articles/:id`           | staff                                    | Base de conocimiento (filtros `status`, `category`, `q`; cursor)                                                                                 |
| `POST` · `PATCH` · `DELETE /api/kb/articles/:id`              | **admin**                                | Crear/editar/borrar artículos (la versión sube si cambia título o cuerpo)                                                                        |
| `GET /api/conversations?scope=mine\|queue\|all`               | staff (`all` solo admin)                 | Listado (cola: por prioridad; resto: por último mensaje, con cursor)                                                                             |
| `GET /api/conversations/:id`                                  | dueño o cola                             | Detalle: cliente, escalamientos, llamadas                                                                                                        |
| `GET /api/conversations/:id/messages`                         | dueño o cola                             | Historial, del más reciente hacia atrás, con cursor                                                                                              |
| `POST /api/conversations/:id/take`                            | staff                                    | Tomar de la cola (atómico; respeta `max_concurrent`)                                                                                             |
| `POST /api/conversations/:id/close`                           | asignado o admin                         | `{ reason?, note? }`; resuelve el escalamiento                                                                                                   |
| `POST /api/conversations/:id/messages`                        | el asignado                              | `{ content, clientMsgId? }`; idempotente por `clientMsgId`                                                                                       |
| `POST /api/widget/sessions`                                   | público (cliente)                        | Sesión anónima `{ displayName? }`. Con `X-Requested-With`: cookie httpOnly y **sin** token en el cuerpo; sin él (API/curl): `{ token: "wgt_…" }` |
| `GET /api/widget/session` · `POST /api/widget/session/end`    | cliente                                  | Datos de la sesión actual · cerrarla (revoca el token y borra la cookie)                                                                         |
| `GET` · `POST /api/widget/conversations`                      | cliente (cookie o `Bearer wgt_…`)        | Sus conversaciones (máx. 3 abiertas)                                                                                                             |
| `GET /api/widget/conversations/:id/messages`                  | el cliente dueño                         | Historial (sin el análisis de IA ni datos internos)                                                                                              |
| `POST /api/widget/conversations/:id/messages`                 | el cliente dueño                         | `{ content, clientMsgId? }` → motor conversacional: respuesta o traspaso                                                                         |
| `GET /ws` (upgrade)                                           | staff o cliente                          | Tiempo real, solo recepción (ver abajo)                                                                                                          |
| `GET /health` · `GET /ready`                                  | sondas                                   | Liveness / readiness (Postgres + Redis)                                                                                                          |
| `GET /metrics`                                                | `Bearer METRICS_TOKEN`                   | Prometheus                                                                                                                                       |

### Quién ve qué (autorización por dueño)

Una sola regla en `src/modules/conversations/conversations.access.ts` (ver
[ADR 0003](docs/adr/0003-autorizacion-por-alcance.md)):

- **admin**: todas las conversaciones.
- **agent**: las asignadas a él (en curso o cerradas) y la **cola general** (en espera y
  sin asignar), para leer el historial antes de tomar el caso. No ve las que atiende la
  IA sin escalar ni las de otros agentes: esas responden **404**.

### Sesión del cliente del widget

La sesión es una cookie `atencion_ia_widget` (httpOnly, `SameSite=Strict`, `Path=/`): el token
`wgt_…` nunca llega al JavaScript del navegador, así que un XSS no puede robarlo. Las escrituras
autenticadas **por cookie** exigen `X-Requested-With: atencion-ia` (CSRF, como el refresh del
staff). `Authorization: Bearer wgt_…` sigue funcionando para curl y la demo de la Fase 3. Ver
[ADR 0009](docs/adr/0009-sesion-del-widget-en-cookie.md).

## Tiempo real (WebSocket `/ws`)

Mismo puerto que la API. **Solo recepción**: enviar sigue siendo por REST (validación,
idempotencia, rate limit y tope de IA en un solo lugar). Ver
[ADR 0008](docs/adr/0008-tiempo-real-solo-recepcion.md).

- **Autenticación en el primer mensaje** (`{ "type": "auth", "accessToken" }` para el staff;
  `{ "type": "auth" }` para el widget, que usa la cookie del upgrade). Nunca en la URL.
- **Origin** debe estar en `CORS_ORIGIN` (evita cross-site WebSocket hijacking).
- Cierres: `4401` credencial inválida · `4408` no se autenticó en 5 s · `4409` venció el token o
  la sesión (el cliente renueva y reconecta) · `4429` más de 20 mensajes en 10 s. Heartbeat cada 30 s.
- **Quién recibe qué** (`src/realtime/audience.ts`, función pura): el cliente, solo eventos de
  **sus** conversaciones, sin el análisis de la IA (intención/sentimiento) y con el asesor solo por
  su nombre de pila; el staff, solo lo que `canViewConversation` le permite. Cuando un caso sale
  del alcance de un agente (otro lo tomó), le llega `conversation.updated` con `visible: false`.
- Los eventos se publican **después del commit** en Redis (canal `atencion-ia:realtime`), así
  varias instancias de la API y el worker entregan a todos los sockets.
- Lo publicado mientras un cliente estaba desconectado **no** se reenvía: al reconectar, el
  frontend vuelve a pedir el historial por REST.

### Rate limiting (Redis)

| Límite              | Clave                       | Cupo                                               |
| ------------------- | --------------------------- | -------------------------------------------------- |
| Global `/api`       | IP                          | 600 / 15 min                                       |
| Login               | IP (solo fallos)            | 10 / 15 min                                        |
| Bloqueo progresivo  | cuenta (SHA-256 del correo) | libre hasta 5 fallos; luego 1, 2, 4… min (máx. 60) |
| Refresh / logout    | IP                          | 60 / 15 min                                        |
| Mensajes de agente  | usuario                     | 60 / min                                           |
| Escrituras de admin | usuario                     | 120 / 15 min                                       |

| Sesiones del widget | IP | 20 / hora |
| Mensajes a la IA | sesión del widget | 12 / min |
| Tokens de IA | cliente | `AI_DAILY_TOKEN_BUDGET_PER_CUSTOMER` en 24 h |

## IA: RAG, intención y escalamiento

Demo paso a paso en cmd.exe con los datos del seed: [docs/demo-fase3.md](docs/demo-fase3.md).
Detalle completo en [docs/rag.md](docs/rag.md): flujo de un turno, las 7 reglas de
escalamiento, las capas de aislamiento del RAG, las pruebas de mutación y la calibración.

- **Proveedor** intercambiable (`AI_PROVIDER`): `mock` determinista por defecto; `anthropic`
  (Claude + Voyage) implementado y probado con clientes simulados, **no contra el proveedor real**.
- **Motor único** para texto y voz (`handleCustomerTurn`, [ADR 0007](docs/adr/0007-motor-conversacional-independiente-del-canal.md)).
- **Aislamiento del RAG** garantizado también por la base (trigger de la migración 013,
  [ADR 0006](docs/adr/0006-aislamiento-del-rag.md)).
- **Escalamiento** sin duplicados (índice único parcial + `ON CONFLICT DO NOTHING`), con aviso a
  los agentes disponibles por Redis pub/sub (canal `atencion-ia:realtime`).

## Observabilidad

- **Logs** estructurados (pino): una línea por petición con `requestId` (también en el
  header `X-Request-Id`), método, ruta, estado, duración e id del staff. Se redactan
  credenciales, cookies, secretos y **el contenido de los mensajes**. En desarrollo se
  ven con colores; en producción, JSON.
- **Métricas** Prometheus en `/metrics` (con token): duración HTTP por ruta como patrón
  (nunca ids), eventos de autenticación y de conversaciones, conexiones WebSocket abiertas por tipo, latencia y tokens de IA por
  proveedor y operación, escalamientos por motivo, similitud del RAG, trabajos por cola.
  El worker expone las suyas en `WORKER_METRICS_PORT`.
- **Sondas**: `/health` no consulta dependencias; `/ready` sí, y responde 503 durante el
  apagado.
- **Apagado ordenado** (SIGTERM/SIGINT): readiness 503 → drenaje → cierre de WebSockets → cierre HTTP esperando
  lo que está en curso → auditoría pendiente → Redis → Postgres. Tiempo máximo
  configurable.
- **Auditoría** (`audit_log`): login (éxito/fallo/bloqueo), reutilización de refresh,
  cambios de staff y KB, ver/tomar/cerrar/responder conversaciones. Sin correos de
  logins fallidos ni contenido de mensajes; IP como HMAC.

## Tests

```bat
npm test
```

Recrean una base `atencion_ia_test` aplicando las migraciones **reales** del repo hermano
(con sus CHECKs e índices parciales). Redis y las colas se simulan. 224 tests en 25 archivos: unitarios (política de
contraseñas, bloqueo, tokens, acceso, versionado de la KB, paginación, redacción de logs,
apagado, reglas de escalamiento, proveedor mock, adaptadores de Claude y Voyage con clientes
simulados, prompt injection, fragmentación) y de integración (sesión completa, CSRF, rate limit,
aislamiento entre agentes y entre clientes, carreras, idempotencia, KB, staff, motor
conversacional, aislamiento del RAG, indexación, avisos, sondas, métricas, sesión del widget
por cookie con CSRF y WebSocket real: Origin, autenticación, qué recibe cada destinatario y cierre al vencer).

Además: `npm run test:shuffle` (orden aleatorio: sin dependencias ocultas entre tests) y
`npm run test:mutations` (22/22 reglas críticas rotas a propósito son detectadas).

## Probarlo a mano (cmd.exe, con el seed cargado)

```bat
curl -s -c %TEMP%\laura-cookies.txt -H "Content-Type: application/json" -d "{\"email\":\"laura@cordillera.example\",\"password\":\"Password123!\"}" http://localhost:4100/api/auth/login
```

Copia el `accessToken` de la respuesta y:

```bat
set TOKEN=pega_aqui_el_token
:: Su conversación (200) y la de Diego (404)
curl -s -H "Authorization: Bearer %TOKEN%" http://localhost:4100/api/conversations/c0000000-0000-4000-8000-000000000003
curl -s -H "Authorization: Bearer %TOKEN%" http://localhost:4100/api/conversations/c0000000-0000-4000-8000-000000000007
```

Cuentas del seed: `admin@`, `laura@`, `diego@cordillera.example` (contraseña
`Password123!`; ver el README de `atencion-ia-database`).

## Prisma: lo que no está en `schema.prisma`

`schema.prisma` se obtiene con `db pull` y los modelos se renombraron a PascalCase con
`@@map`/`@map`. Un nuevo `db pull` conserva esos renombres y los comentarios `///`, pero
**borra** los `//` (medido), por eso lo importante está aquí:

- CHECKs, índices únicos **parciales**, FKs compuestas y triggers viven solo en la base.
- `calls.duration_seconds` es una columna calculada: solo lectura.
- `kb_chunks.embedding` (`vector(1024)`) se usa con SQL crudo.
- **Nunca** `prisma migrate` ni `prisma db push` (ver [ADR 0001](docs/adr/0001-prisma-solo-como-cliente.md)).

## Decisiones

Ver [`docs/adr/`](docs/adr/README.md).
