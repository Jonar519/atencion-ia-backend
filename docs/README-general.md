# Atención IA: atención al cliente omnicanal con IA

> **Copia del README general.** El original está en la carpeta raíz `atencion-ia/`, que contiene
> los tres repositorios y no es un repositorio git. Esta copia viaja con el código: si cambias uno,
> cambia el otro. Los enlaces están ajustados a esta ubicación (`atencion-ia-backend/docs/`).

Un cliente de **Banco Cordillera** (ficticio) escribe o **llama** desde el navegador. Un asistente
de IA le responde usando **solo** la base de conocimiento del banco (RAG).

Cuando no puede resolver (posible fraude, cliente molesto, pide un humano…), el **mismo motor**
escala el caso. Aparece en tiempo real en la cola de los asesores, que ven todo el historial antes
de tomarlo, responden por chat o se **unen a la llamada** (WebRTC) viendo la transcripción en vivo.

La **Fase 7** le dio identidad profesional: cuentas de asesor con recuperación de contraseña,
verificación en dos pasos, sesiones activas y perfil (foto); toda la app sigue el tema claro u oscuro del sistema operativo; administración por rol
(base de conocimiento, respuestas predefinidas, equipo y analítica); adjuntos en el chat (imagen y
PDF, que la IA nunca lee); la llamada "en vivo" (forma de onda y una sola animación) y estados de
carga, error, vacío y conectividad en todas las pantallas. Su bloque final (F) dejó el alta de
asesores **solo por invitación** (sin registro público), un menú de usuario con "Mi perfil" y
"Salir" en todas las pantallas del staff y una portada nueva.

El proyecto son **tres repositorios hermanos** en la misma carpeta. Esta carpeta raíz **no** es un
repositorio git.

```
atencion-ia/                    ← esta carpeta (este README)
├── atencion-ia-database/       # Esquema SQL, migraciones, seed y pruebas del esquema; Postgres + pgvector y Redis (Docker)
├── atencion-ia-backend/        # API REST + WebSocket de eventos y de voz + worker (Node.js, TypeScript, Express, Prisma, BullMQ)
└── atencion-ia-frontend/       # SPA sin framework (Vite): widget del cliente y panel de asesores
```

> Los tests del backend y el E2E del frontend leen `../atencion-ia-database/migrations`: **la
> estructura de carpetas importa**.

## Puertos

| Servicio                                                       | Puerto                             | Definido en                               |
| -------------------------------------------------------------- | ---------------------------------- | ----------------------------------------- |
| PostgreSQL 16 + pgvector                                       | **5434** (→ 5432 en el contenedor) | `atencion-ia-database/docker-compose.yml` |
| Redis 7                                                        | **6380**                           | `atencion-ia-database/docker-compose.yml` |
| API REST + `/ws` + `/ws/voice` + `/health` `/ready` `/metrics` | **4100**                           | `atencion-ia-backend/.env` (`PORT`)       |
| Sondas y métricas del worker                                   | **9465**                           | `WORKER_METRICS_PORT`                     |
| Frontend (Vite dev, con proxy de `/api` y `/ws` a la API)      | **5174**                           | `atencion-ia-frontend/vite.config.js`     |
| Frontend (build + `vite preview`, con CSP y Service Worker)    | **4174**                           | `npm run preview`                         |
| Entorno **aislado** del E2E: API · worker · frontend           | 4101 · 9466 · 4175                 | `atencion-ia-frontend/scripts/e2e.bat`    |

Los puertos no chocan con el Proyecto 1 (5433, 6379, 4000, 5173).

## Requisitos

- **Docker Desktop** (Postgres y Redis corren en contenedores).
- **Node.js 20** o superior (probado con 24).
- **Google Chrome** o Edge para usarlo, y Chrome para el E2E.
- **Sin API keys:** todo funciona con la IA, la voz, el correo, la ubicación y los archivos
  **simulados** (`AI_PROVIDER=mock`, `VOICE_PROVIDER=mock`, `EMAIL_PROVIDER=mock`, `GEO_PROVIDER=mock`,
  `STORAGE_PROVIDER=local`). Los adaptadores reales (Anthropic + Voyage para IA, Deepgram para voz) ya
  están implementados y se activan con sus keys.

## Primera vez (Windows, `cmd.exe`)

```bat
:: Base de datos y Redis
cd atencion-ia-database
docker compose up -d
scripts\migrate.bat
scripts\seed.bat
cd ..

:: Backend
cd atencion-ia-backend
npm install
copy .env.example .env
npx prisma generate
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
::   pega un valor en JWT_SECRET y OTRO distinto en IP_HASH_SECRET, dentro de .env
npm run kb:reindex
cd ..

:: Frontend
cd atencion-ia-frontend
npm install
cd ..
```

## Día a día: orden de arranque

| #   | Qué                    | Dónde                  | Comando                | Listo cuando ves                                                            |
| --- | ---------------------- | ---------------------- | ---------------------- | --------------------------------------------------------------------------- |
| 1   | Postgres y Redis       | `atencion-ia-database` | `docker compose up -d` | los dos contenedores `(healthy)` en `docker ps`                             |
| 2   | Migraciones pendientes | `atencion-ia-database` | `scripts\migrate.bat`  | `Listo: N migracion(es) nueva(s) aplicada(s).`                              |
| 3   | API                    | `atencion-ia-backend`  | `npm run dev`          | `API escuchando en http://localhost:4100` y `WebSocket de voz en /ws/voice` |
| 4   | Worker                 | `atencion-ia-backend`  | `npm run worker`       | `Worker iniciado`                                                           |
| 5   | Frontend               | `atencion-ia-frontend` | `npm run dev`          | `Local: http://localhost:5174/`                                             |

Abre `http://localhost:5174` y elige **Soy cliente** o **Soy asesor**.

## Cuentas de prueba (seed)

| Correo                     | Rol                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `admin@cordillera.example` | administrador (staff, base de conocimiento, ve todo). Al entrar la primera vez **debe activar la verificación en dos pasos** |
| `laura@cordillera.example` | asesora                                                                                                                      |
| `diego@cordillera.example` | asesor                                                                                                                       |
| `sofia@cordillera.example` | asesora **desactivada** (no puede entrar)                                                                                    |

Contraseña de todas: `Password123!` (datos de prueba públicos). El cliente del widget es anónimo:
se crea al pulsar "Iniciar chat". Las cuentas **nuevas** del staff solo se crean por **invitación**
(admin → Equipo → Invitar asesor; el enlace llega al correo simulado, `email_outbox`).

## Guías paso a paso (para probarlo a mano)

| Qué                                                                                                                                          | Guía                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Conversación por API (curl) con escalamiento                                                                                                 | `atencion-ia-backend/docs/demo-fase3.md`          |
| Chat en tiempo real en dos pestañas (cliente y asesor)                                                                                       | `atencion-ia-frontend/docs/fase4-verificacion.md` |
| Llamada de voz por consola (sin micrófono)                                                                                                   | `atencion-ia-backend/docs/demo-fase5.md`          |
| **Llamada con tu micrófono y WebRTC entre dos pestañas**                                                                                     | `atencion-ia-frontend/docs/prueba-voz.md`         |
| **Fase 7 completa** (identidad, administración, adjuntos, llamada en vivo, estados de la interfaz, invitaciones, portada y tema del sistema) | `atencion-ia-backend/docs/demo-fase7.md`          |

## Tests, carga y E2E

| Repo                   | Comandos (cmd.exe)                                                                                          | Resultado actual                                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `atencion-ia-database` | `scripts\migrate.bat` (dos veces: la segunda no aplica nada) · `scripts\test.bat`                           | 112 pruebas del esquema: 38 de reglas, 6 de aislamiento del RAG, 13 de voz, 18 de identidad, 10 de respuestas predefinidas, 9 de adjuntos y 18 de invitaciones (en una base desechable: `test.bat` usa por defecto la de desarrollo) |
| `atencion-ia-backend`  | `scripts\verify.bat` (lint → typecheck → tests → build) · `npm run test:shuffle` · `npm run test:mutations` | **429 tests** en 35 archivos · **99/99 mutaciones** detectadas                                                                                                                                                                       |
| `atencion-ia-frontend` | `scripts\verify.bat` · `npm run test:mutations` · **`scripts\e2e.bat`**                                     | **388 tests** en 22 archivos · **109/109 mutaciones** · **5 E2E** (texto, voz, adjuntos, invitación y tema del sistema)                                                                                                              |
| Carga                  | `atencion-ia-backend/loadtests/README.md` (`npm run loadtest:*`)                                            | `atencion-ia-backend/docs/load-test-report.md`                                                                                                                                                                                       |

Las **pruebas de mutación** rompen a propósito cada regla crítica (aislamiento del RAG, permisos,
consentimiento, micrófono que no se apaga, que la IA lea un adjunto, MFA sin anti-replay…) y exigen
que algún test falle. Así se demuestra que
los tests protegen algo.

Todas las pruebas en vivo usan bases aparte (`atencion_ia_e2e`, `atencion_ia_load`), otras bases
lógicas de Redis y su propia carpeta de archivos: **nunca la base ni los archivos de desarrollo**.

## Cómo demostrar cada tema de la materia

| Tema                                                           | Dónde está                                                                                                                                                                                                          | Evidencia                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arquitectura cliente-servidor, REST y códigos HTTP             | `atencion-ia-backend/src/modules/*` (routes → controller → service)                                                                                                                                                 | Tabla de rutas del README del backend; tests de integración (400, 401, 403, 404, 409, 429)                                                                                                                                                                                                                                                               |
| Validación de entrada                                          | `src/middlewares/validate.middleware.ts`, `src/modules/*/*.schema.ts` (zod)                                                                                                                                         | `widget.test.ts` (vacío, largo, campos extra, texto mal codificado), `voiceProviders.test.ts` (señalización WebRTC)                                                                                                                                                                                                                                      |
| DOM, eventos y SPA sin framework                               | `atencion-ia-frontend/src/router.js`, `src/views/`, `src/lib/dom.js`                                                                                                                                                | `tests/customerChat.test.js`, `tests/agentPanel.test.js`                                                                                                                                                                                                                                                                                                 |
| Asincronía, `fetch`, timeouts y reintentos                     | frontend `src/api/http.js`, `src/chat/messageStore.js`                                                                                                                                                              | `tests/session.test.js`, `tests/customerChat.test.js` (reintento con el mismo `clientMsgId`)                                                                                                                                                                                                                                                             |
| Autenticación, sesión y cookies                                | backend `src/modules/auth/`, frontend `src/auth/session.js` (token en memoria + refresh rotativo en cookie httpOnly); widget con cookie httpOnly                                                                    | `auth.test.ts`, `widget.test.ts`, frontend `tests/session.test.js`; [ADR 0002](../docs/adr/0002-esquema-de-sesion.md), [0009](../docs/adr/0009-sesion-del-widget-en-cookie.md)                                                                                                                                                                           |
| **Gestión de cuentas: recuperación, MFA y sesiones** (Fase 7)  | backend `src/modules/auth/` (`totp.ts`, `mfa.service.ts`, `singleUseTokens.ts`, `password.service.ts`, `sessions.service.ts`); frontend `views/agent/recovery.view.js`, `profile.view.js`                           | `recoveryAndMfa.test.ts`, `profile.test.ts`, `tests/004_identity.sql`; mutaciones backend 40–61; demo §1–3                                                                                                                                                                                                                                               |
| **Alta de cuentas solo por invitación** (Fase 7, F)            | backend `src/modules/staff/invitations.service.ts`, migración 018 (cuenta pendiente sin contraseña, trigger invitación ⇔ pendiente); frontend `views/agent/invitation.view.js`, `views/admin/team.view.js`          | `invitations.test.ts`, `tests/007_invitations.sql`, frontend `invitations.test.js`, E2E de invitación (correo simulado → completar la cuenta → el enlace no sirve dos veces); mutaciones backend 91–99, frontend 84–89; demo §14                                                                                                                         |
| Autorización por rol y por dueño                               | `src/modules/conversations/conversations.access.ts` (una sola regla, 404 en vez de 403); Fase 7: `requireRole("admin")` en la administración y guardas de ruta en el frontend (`router.js`)                         | `authorization.test.ts` (todas las combinaciones), `adminTools.test.ts`, mutaciones 4, 5, 15 y 66–69, frontend 42–43; [ADR 0003](../docs/adr/0003-autorizacion-por-alcance.md); demo §6                                                                                                                                                                  |
| Seguridad web (XSS, CSRF, CORS, CSP, cabeceras)                | frontend `src/lib/dom.js` + ESLint sin `innerHTML`; `csrf.middleware.ts`; `app.ts` (helmet, CORS); `vite.config.js` (CSP)                                                                                           | `tests/render.test.js` (ataque real), E2E sin violaciones de CSP, `docs/threat-model.md`                                                                                                                                                                                                                                                                 |
| Seguridad de IA (prompt injection, aislamiento del RAG, costo) | `src/services/ai/untrusted.ts`; trigger 013 de la base; `engine/budget.service.ts`; Fase 7: la IA solo recibe una **señal** de que hay un adjunto, nunca su contenido ni su nombre                                  | `ragIsolation.test.ts` (secreto sembrado), `tests/002_rag_provenance.sql`, `attachments.test.ts`, mutaciones 1–3, 6, 10 y 77–81; [ADR 0006](../docs/adr/0006-aislamiento-del-rag.md)                                                                                                                                                                     |
| **Subida de archivos** (Fase 7)                                | backend `src/modules/attachments/` (bytes mágicos, PDF sin contenido activo, 5 MB), `src/services/storage/` (local o S3, intercambiable); frontend `lib/attachments.js` (re-codifica la foto sin EXIF en un canvas) | `attachments.test.ts`, `tests/006_attachments.sql`, E2E de adjuntos; mutaciones backend 82–90, frontend 53–58; [docs/attachments.md](../docs/attachments.md); demo §11                                                                                                                                                                                   |
| Modelo de amenazas (STRIDE)                                    | `atencion-ia-backend/docs/threat-model.md` (con la sección 2.7 de la Fase 7)                                                                                                                                        | Cada amenaza con su mitigación, su test o mutación y el riesgo residual                                                                                                                                                                                                                                                                                  |
| Tiempo real (WebSocket)                                        | backend `src/realtime/wsServer.ts` + `audience.ts` (quién recibe qué) + Redis pub/sub; frontend `src/realtime/socket.js`                                                                                            | `websocket.test.ts`, `audience.test.ts`, frontend `tests/socket.test.js` (reconexión y resincronización), E2E (la cola cambia sin recargar); [ADR 0008](../docs/adr/0008-tiempo-real-solo-recepcion.md)                                                                                                                                                  |
| **WebRTC y audio en el navegador**                             | frontend `src/voice/` (AudioWorklet a 16 kHz, reproducción, `peerLink.js`, `voiceSession.js`); backend `src/realtime/voiceServer.ts` (señalización por Redis)                                                       | `voice.test.ts` (33 tests, incluida la señalización entre instancias), frontend `tests/voiceSession.test.js`, E2E de voz (WebRTC conectado); [ADR 0010](../docs/adr/0010-arquitectura-de-voz.md)                                                                                                                                                         |
| Web Workers                                                    | frontend `src/workers/urgency.worker.js` (urgencia local al escribir), `src/voice/capture.worklet.js` (hilo de audio)                                                                                               | `tests/urgency.test.js`, `tests/voiceAudio.test.js`                                                                                                                                                                                                                                                                                                      |
| Service Worker y caché                                         | frontend `src/sw/` (shell offline; nunca `/api` ni `/ws`), backend `Cache-Control: no-store`                                                                                                                        | `tests/serviceWorker.test.js` (carga el SW generado), mutación frontend 10                                                                                                                                                                                                                                                                               |
| Almacenamiento en el navegador                                 | **Deliberadamente mínimo**: el shell en Cache Storage; ningún token ni conversación en `localStorage`                                                                                                               | E2E ("ningún token en el almacenamiento"), mutación frontend 1                                                                                                                                                                                                                                                                                           |
| Accesibilidad                                                  | `atencion-ia-frontend/docs/design-system.md` (contraste medido, foco, `aria-live`, el color nunca es la única pista, movimiento reducido)                                                                           | E2E con **axe** (0 violaciones serious/critical) en el widget, el panel y los adjuntos; `tests/contrast.test.js` mide WCAG sobre los tokens reales; mutaciones frontend 39, 41, 52, 57, 83 y, del bloque F, 90–104 (avisos que no bloquean clics, menú de usuario con teclado, portada); E2E del tema con axe en las 13 pantallas × 2 temas              |
| **CSS: sistema de diseño y tema del sistema** (Fase 7)         | frontend `src/styles/tokens.css` (custom properties; oscuro en `@media (prefers-color-scheme: dark)`, sin JavaScript)                                                                                               | `tests/contrast.test.js` (contraste de cada par en los dos temas, también la portada, **una sola** `@keyframes`, acento en vivo solo en la llamada); `tests/systemTheme.test.js` (sin selector de tema, ninguna pantalla se sale); E2E `system-theme.spec.js` (13 pantallas × claro/oscuro y cambio en vivo); mutaciones frontend 105–109; demo §4 y §16 |
| **Canvas 2D y animación** (Fase 7)                             | frontend `src/components/waveform.js` (forma de onda con `requestAnimationFrame`, nada con la pestaña oculta), `styles/voice.css` (la única animación, con `prefers-reduced-motion`)                                | `tests/liveCall.test.js`, E2E de voz (píxeles pintados, la animación corre una vez); mutaciones frontend 59–70; demo §12                                                                                                                                                                                                                                 |
| **Visualización de datos (SVG)** (Fase 7)                      | frontend `src/components/barChart.js` (barras enfocables con su valor y tabla de datos), backend `src/modules/analytics/`                                                                                           | `tests/admin.test.js`, `csat.test.ts`, `adminTools.test.ts`; mutaciones backend 70–75; [docs/analytics.md](../docs/analytics.md); demo §7                                                                                                                                                                                                                |
| **Estados de la interfaz y resiliencia de red** (Fase 7)       | frontend `src/components/states.js` (cargando, error con Reintentar sin recargar, vacío) y `connectivity.js` (eventos `online`/`offline` + estado del WebSocket)                                                    | `tests/uiStates.test.js`; mutaciones frontend 71–83; demo §13                                                                                                                                                                                                                                                                                            |
| Base de datos, migraciones y ORM                               | `atencion-ia-database/migrations/` (SQL puro), `atencion-ia-backend/prisma/schema.prisma` (Prisma solo como cliente)                                                                                                | CI de la base (base limpia, migraciones repetibles, seed idempotente, 57 pruebas del esquema); [ADR 0001](../docs/adr/0001-prisma-solo-como-cliente.md)                                                                                                                                                                                                  |
| Búsqueda semántica (pgvector) y RAG                            | `src/modules/rag/`, índice HNSW                                                                                                                                                                                     | `ragIsolation.test.ts`, `indexing.test.ts`, `docs/rag.md`                                                                                                                                                                                                                                                                                                |
| Procesamiento asíncrono (colas)                                | `src/queues/`, `src/workers/` (avisos de escalamiento, índice, barrido y purga de voz)                                                                                                                              | `engine.test.ts`, `voice.test.ts` (barrido y purga), `docs/load-test-report.md` (ráfaga de 199 escalamientos)                                                                                                                                                                                                                                            |
| Concurrencia y consistencia                                    | Índices únicos parciales (un escalamiento abierto y una llamada activa por conversación), tomas atómicas                                                                                                            | `conversations.test.ts` y `voice.test.ts` (carreras: gana exactamente uno), ráfaga de carga (0 duplicados)                                                                                                                                                                                                                                               |
| Privacidad y consentimiento                                    | `src/modules/voice/consent.ts`, retención y purga, migración 014; Fase 7: IP truncada, exportar y anonimizar cuentas, fotos sin EXIF                                                                                | `docs/privacy-voice.md`, `docs/data-retention.md`, `tests/003_voice.sql`, `tests/004_identity.sql`, mutaciones 30, 34, 35, 61–64 y 85                                                                                                                                                                                                                    |
| **Proveedores externos intercambiables** (regla de oro)        | backend `src/services/email/`, `src/services/geo/`, `src/services/storage/` (y antes `services/ai/`, `services/voice/`): una interfaz, modo `mock` por defecto                                                      | `identity.test.ts` (correo, ubicación, almacenamiento local y S3 con dobles); el correo simulado se lee en `email_outbox` (demo §0)                                                                                                                                                                                                                      |
| Observabilidad y operación                                     | `src/observability/` (pino con redacción, prom-client, `/health` `/ready`), `src/lifecycle/shutdown.ts`                                                                                                             | `observability.test.ts`, `shutdown.test.ts`, `logRedaction.test.ts`                                                                                                                                                                                                                                                                                      |
| Pruebas de carga                                               | `atencion-ia-backend/loadtests/`                                                                                                                                                                                    | `docs/load-test-report.md`: con IA a 300 ms, el turno bajó de ~1050 a ~732 ms (+48 % throughput) tras un perfil de CPU y el log de SQL                                                                                                                                                                                                                   |
| Pruebas (unitarias, integración, mutación, E2E)                | `*/tests/`, `atencion-ia-frontend/e2e/`                                                                                                                                                                             | 429 backend + 388 frontend + 112 del esquema + 5 E2E; 99 + 109 mutaciones                                                                                                                                                                                                                                                                                |
| Integración continua                                           | `.github/workflows/ci.yml` de cada repo                                                                                                                                                                             | lint, typecheck, tests, build, mutaciones, npm audit, gitleaks, migraciones sobre una base limpia, E2E                                                                                                                                                                                                                                                   |
| Decisiones de arquitectura                                     | `atencion-ia-backend/docs/adr/` (0001–0011)                                                                                                                                                                         | Cada ADR con contexto, alternativas, consecuencias y evidencia                                                                                                                                                                                                                                                                                           |

## Pruebas manuales pendientes (necesitan credenciales reales)

Hoy todo corre con proveedores **simulados**. Al cerrar los tres proyectos, con las keys:

1. **Anthropic + Voyage** (`AI_PROVIDER=anthropic`):
   - respuestas reales;
   - calibrar el umbral del RAG (`npm run rag:calibrate`; el valor 0.45 está **sin calibrar**);
   - verificar la clasificación de intención.
2. **Deepgram** (`VOICE_PROVIDER=deepgram`):
   - que Nova-3 en español y la voz `aura-2-celeste-es` respondan;
   - que se acepte `mip_opt_out`;
   - la latencia real de un turno de voz ([ADR 0011](../docs/adr/0011-proveedor-de-voz.md)).
3. **WebRTC entre dos equipos** distintos: requiere HTTPS y probablemente un servidor TURN
   (`ICE_SERVERS`).
4. **Fase 7** (sin key, pero sin probar con el servicio real):
   - correo real con `EMAIL_PROVIDER=smtp` y `SMTP_URL`;
   - ubicación con el archivo de DB-IP (`GEO_PROVIDER=dbip`, `GEO_DB_PATH`);
   - almacenamiento en un S3 o compatible (`STORAGE_PROVIDER=s3`).

## Problemas frecuentes

| Síntoma                                                                           | Causa probable                                                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| La API no arranca: `Can't reach database server at localhost:5434`                | Postgres no está corriendo (paso 1)                                                                                |
| La API no arranca: `Configuración inválida`                                       | Falta o sobra algo en `.env`: el mensaje dice qué (por ejemplo `JWT_SECRET` con menos de 32 caracteres)            |
| El asistente responde "No encontré información sobre eso…" a todo                 | La base de conocimiento no está indexada: `npm run kb:reindex`                                                     |
| "Desconectado" en el widget o el panel                                            | La API no corre, o el frontend no apunta a ella (`VITE_BACKEND_URL`)                                               |
| El caso escalado no aparece en la cola                                            | El worker (paso 4) no corre, o Redis está caído (`curl http://localhost:4100/ready` lo dice)                       |
| No se puede llamar: permiso del micrófono                                         | Actívalo en el candado de la barra de direcciones → Micrófono → Permitir                                           |
| "Ya atiendes 3 conversaciones, tu máximo"                                         | Cierra un caso en "Mis casos"                                                                                      |
| `prisma generate` falla con `EPERM`                                               | La API o el worker tienen abierta la DLL de Prisma: detenlos primero                                               |
| `429`                                                                             | Límites de uso: por IP, sesión o cliente (tabla en el README del backend)                                          |
| El admin no puede entrar: perdió el teléfono y los códigos de respaldo            | Con acceso al servidor: `npm run staff:reset-mfa -- correo` (backend)                                              |
| "¿Olvidaste tu contraseña?" no llega ningún correo                                | Con `EMAIL_PROVIDER=mock` no se envía nada: se lee en la tabla `email_outbox` (demo §0)                            |
| Los mensajes no cargan tras actualizar el código, o la API falla al leer el staff | Falta una migración (015–019): `scripts\migrate.bat`, `npx prisma generate` con la API detenida, y reinicia la API |

## Documentación de cada repo

| Repo                   | Empieza por                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atencion-ia-database` | `README.md` · `docs/domain-model.md` (modelo de datos y reglas garantizadas por la base)                                                                                                                                  |
| `atencion-ia-backend`  | `README.md` · `docs/demo-fase7.md` · `docs/adr/` · `docs/threat-model.md` · `docs/load-test-report.md` · `docs/privacy-voice.md` · `docs/rag.md` · `docs/attachments.md` · `docs/analytics.md` · `docs/data-retention.md` |
| `atencion-ia-frontend` | `README.md` · `docs/design-system.md` · `docs/prueba-voz.md` · `e2e/README.md`                                                                                                                                            |
