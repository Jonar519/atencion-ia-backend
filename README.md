# Atención IA: atención al cliente con inteligencia artificial

**Producción:** aplicación en <https://atencion.jonarproyectos.com> · API en
<https://api-atencion.jonarproyectos.com> (estado: [`/ready`](https://api-atencion.jonarproyectos.com/ready)).

Este README es la guía para evaluar el proyecto completo sin ayuda. El proyecto vive en tres
repositorios; este (`atencion-ia-backend`) es el principal y tiene la guía de pruebas. Los otros dos
explican su parte y enlazan aquí:

| Repositorio            | Qué contiene                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `atencion-ia-backend`  | **Este.** API REST, WebSockets de chat y de voz, worker de colas, IA, voz, correo y archivos. |
| `atencion-ia-frontend` | La aplicación web: widget del cliente, panel de asesores y administración.                    |
| `atencion-ia-database` | El esquema de PostgreSQL (migraciones SQL), los datos de prueba y las pruebas del esquema.    |

## Contenido

1. [Qué es el proyecto](#1-qué-es-el-proyecto)
2. [Cómo funciona](#2-cómo-funciona)
3. [Tecnologías](#3-tecnologías)
4. [Qué necesita el profesor](#4-qué-necesita-el-profesor)
5. [Acceso y roles](#5-acceso-y-roles)

## 1. Qué es el proyecto

Un banco ficticio, **Banco Cordillera**, atiende a sus clientes desde el navegador. El cliente
escribe o **llama por voz** sin registrarse, y un asistente de IA le responde usando **solo** la
base de conocimiento del banco (la técnica se llama RAG: el asistente primero busca en esa base y
responde con lo que encontró). Cuando el asistente no debe o no puede resolver (posible fraude,
cliente molesto, pide una persona, no encuentra la respuesta), el sistema **escala** el caso:
aparece al instante en la cola de los asesores, que leen todo el historial antes de tomarlo y
siguen la conversación por chat o se unen a la llamada. Está pensado para un equipo de atención al
cliente (asesores y un administrador) y para clientes que no quieren instalar nada.

Capacidades principales:

- **Chat con IA** que responde con la base de conocimiento y no inventa datos de cuentas.
- **Escalamiento automático** a una persona, con prioridad (urgente, alta, normal) y motivo.
- **Panel de asesores en tiempo real**: cola priorizada, historial antes de tomar, responder y cerrar.
- **Llamadas de voz** desde el navegador: la IA escucha y responde con voz; el asesor puede unirse
  a la llamada (WebRTC) viendo la transcripción en vivo.
- **Adjuntos** (imagen o PDF) en el chat, que la IA nunca lee.
- **Cuentas del equipo** solo por invitación, con recuperación de contraseña, verificación en dos
  pasos, sesiones activas y perfil con foto.
- **Administración**: base de conocimiento, respuestas predefinidas, equipo y analítica.
- **Seguridad y privacidad** respaldadas por pruebas: aislamiento entre clientes y entre asesores,
  límites de uso, consentimiento de la llamada y retención de transcripciones.

## 2. Cómo funciona

### El recorrido de principio a fin

1. **El cliente abre el chat** (`#/chat`). Al pulsar **Iniciar chat**, el servidor crea una sesión
   anónima guardada en una cookie que el JavaScript de la página no puede leer (así un script
   malicioso no puede robarla).
2. **Escribe un mensaje.** La API lo guarda y lo pasa al **motor conversacional**, que hace dos cosas
   a la vez: clasifica la intención y el ánimo del cliente con la IA, y busca en la base de
   conocimiento los fragmentos más parecidos a la pregunta (búsqueda por significado con
   _embeddings_ en PostgreSQL + pgvector).
3. **El motor decide.** Si una regla de escalamiento aplica (fraude, pide un asesor, enojo, reclamos
   repetidos, sin respuesta en la base…), no gasta una respuesta de la IA: escala. Si no, la IA
   redacta la respuesta solo con esos fragmentos y el historial de esa conversación.
4. **El cliente ve la respuesta al instante** por un WebSocket (una conexión abierta que el servidor
   usa para enviar eventos al navegador sin que la página tenga que preguntar).
5. **Si escala**, la conversación pasa a la cola con su prioridad y el **worker** (un proceso aparte
   que atiende colas de trabajo guardadas en Redis) avisa a los asesores disponibles. El caso
   aparece en el panel sin recargar.
6. **Un asesor lo toma**, lee el historial (con la intención y el ánimo detectados), responde y lo
   cierra. Lo que escribe llega al cliente en tiempo real.
7. **Por voz es igual**: el audio del cliente viaja por otro WebSocket, un servicio de voz lo
   convierte en texto (STT) y ese texto entra al **mismo motor**. La respuesta vuelve convertida en
   voz (TTS). Si la llamada escala, el asesor se une y hablan de navegador a navegador (WebRTC).
8. **El administrador** mantiene la base de conocimiento. Al publicar un artículo, el worker lo
   divide en fragmentos y calcula sus embeddings para que el asistente pueda usarlo.

### Arquitectura

```mermaid
flowchart LR
  subgraph Navegador
    W["Widget del cliente<br/>(#/chat)"]
    P["Panel de asesores y<br/>administración"]
  end
  subgraph Vercel
    F["Frontend estático<br/>(Vite, JavaScript sin framework)"]
  end
  subgraph Railway
    A["API Node.js + Express<br/>REST · WebSocket /ws · /ws/voice"]
    K["Worker (BullMQ)<br/>avisos · índice del RAG · purga de voz"]
    D[("PostgreSQL 16 + pgvector")]
    R[("Redis 7<br/>colas · límites · pub/sub")]
  end
  IA["Anthropic Claude<br/>(respuestas y clasificación)"]
  V["Voyage AI<br/>(embeddings)"]
  DG["Deepgram<br/>(voz a texto y texto a voz)"]
  S3["Cloudflare R2<br/>(adjuntos y fotos)"]
  SES["Amazon SES<br/>(correo)"]

  F -- "descarga la app" --> W
  F -- "descarga la app" --> P
  W -- "HTTPS y WebSocket" --> A
  P -- "HTTPS y WebSocket" --> A
  P <-. "audio WebRTC" .-> W
  A <--> D
  A <--> R
  K <--> R
  K <--> D
  A --> IA
  A --> V
  A --> DG
  A --> S3
  A --> SES
  K --> V
```

El DNS del dominio está en Cloudflare. La aplicación (`atencion.`) y la API (`api-atencion.`) son
orígenes distintos del mismo sitio, por eso las cookies de sesión viajan entre ambos.

### Flujo principal: un mensaje que escala a un asesor

```mermaid
sequenceDiagram
  actor C as Cliente
  participant API
  participant M as Motor conversacional
  participant IA as Claude y Voyage
  participant Q as Redis y worker
  actor As as Asesor (panel)

  C->>API: Envía un mensaje desde el widget
  API->>M: Turno del cliente
  par En paralelo
    M->>IA: Clasificar intención y ánimo
  and
    M->>IA: Embeddings y búsqueda en la base de conocimiento
  end
  alt Una regla de escalamiento aplica
    M-->>API: Escalar con prioridad y motivo
    API-->>C: "Te estamos comunicando con un asesor…"
    API->>Q: Encola el aviso
    Q-->>As: El caso aparece en la cola (WebSocket)
    As->>API: Tomar caso y responder
    API-->>C: Respuesta del asesor (WebSocket)
  else La IA puede responder
    M->>IA: Redactar con los fragmentos encontrados
    API-->>C: Respuesta del asistente (WebSocket)
  end
```

Más detalle: las reglas de escalamiento y el aislamiento del RAG en [docs/rag.md](docs/rag.md), la
voz en [docs/adr/0010-arquitectura-de-voz.md](docs/adr/0010-arquitectura-de-voz.md) y todas las rutas
de la API en [docs/referencia-tecnica.md](docs/referencia-tecnica.md).

## 3. Tecnologías

Las versiones son los rangos declarados en el `package.json` de cada repositorio, el `Dockerfile` y
el `docker-compose.yml` de `atencion-ia-database`.

| Tecnología                                            | Versión                                   | Para qué se usa                                                                                                         | Por qué se eligió                                                                                                                 |
| ----------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js**                                           | 24 en la imagen y en la CI (mínimo 20)    | Ejecuta la API y el worker                                                                                              | Un solo lenguaje con el frontend y buen manejo de muchas conexiones abiertas (WebSockets).                                        |
| **TypeScript**                                        | ^5.9.3                                    | Lenguaje del backend                                                                                                    | Tipos en los contratos entre módulos; la CI revisa también los tests.                                                             |
| **Express**                                           | ^4.22.3                                   | API REST (rutas → controlador → servicio)                                                                               | Estándar conocido, con middlewares simples (helmet, CORS, compresión, límites).                                                   |
| **zod**                                               | ^3.25.76                                  | Valida cada entrada y la configuración al arrancar                                                                      | Errores en español por campo; si la configuración es insegura, el servidor no arranca.                                            |
| **ws**                                                | ^8.22.0                                   | WebSocket de eventos (`/ws`) y de voz (`/ws/voice`)                                                                     | Control fino de la autenticación, los cierres y el límite de audio.                                                               |
| **PostgreSQL + pgvector**                             | imagen `pgvector/pgvector:pg16`           | Datos, reglas garantizadas por la base y búsqueda por significado                                                       | Una sola base para datos y vectores; los CHECK, índices únicos parciales y triggers protegen las reglas aunque falle el código.   |
| **Prisma**                                            | ^6.19.3                                   | Cliente tipado de la base de datos                                                                                      | Solo como cliente: el esquema lo manda el SQL ([ADR 0001](docs/adr/0001-prisma-solo-como-cliente.md)).                            |
| **Redis** (ioredis)                                   | imagen `redis:7-alpine` · ioredis ^5.11.1 | Límites de uso, colas y difusión de eventos entre instancias (pub/sub)                                                  | Comparte el estado entre varias instancias de la API y el worker.                                                                 |
| **BullMQ**                                            | ^5.81.5                                   | Colas: avisos de escalamiento, índice del RAG, barrido y purga de llamadas                                              | Reintentos y trabajos sin duplicar; el cliente no espera estas tareas.                                                            |
| **Anthropic Claude** (`@anthropic-ai/sdk`)            | ^0.129.0                                  | Redacta las respuestas y clasifica intención y ánimo                                                                    | Detrás de una interfaz: `AI_PROVIDER=mock` en desarrollo y pruebas ([ADR 0005](docs/adr/0005-proveedor-de-ia-intercambiable.md)). |
| **Voyage AI**                                         | modelo `voyage-3.5` (configurable)        | Embeddings de 1024 dimensiones para el RAG                                                                              | Mismo adaptador intercambiable que la IA; se llama por HTTP.                                                                      |
| **Deepgram**                                          | STT `nova-3` · TTS `aura-2-celeste-es`    | Voz a texto y texto a voz en español                                                                                    | Transcripción en tiempo real y voz en español ([ADR 0011](docs/adr/0011-proveedor-de-voz.md)).                                    |
| **nodemailer** (con **Amazon SES** por SMTP)          | ^10.1.4                                   | Correos: invitaciones, recuperación de contraseña y cambio de correo                                                    | Sirve con cualquier SMTP; en desarrollo `EMAIL_PROVIDER=mock` guarda los correos en una tabla.                                    |
| **AWS SDK S3** (con **Cloudflare R2**)                | `@aws-sdk/client-s3` ^3.1143.0            | Guarda adjuntos y fotos de perfil                                                                                       | Compatible con cualquier S3; en desarrollo se usa una carpeta local.                                                              |
| **bcrypt** · **jsonwebtoken** · **qrcode**            | ^6.0.0 · ^9.0.3 · ^1.5.4                  | Contraseñas, tokens de acceso de 15 min y QR de la verificación en dos pasos                                            | Token en memoria y renovación por cookie httpOnly ([ADR 0002](docs/adr/0002-esquema-de-sesion.md)).                               |
| **helmet** · **cors** · **express-rate-limit**        | ^8.3.0 · ^2.8.6 · ^8.7.0                  | Cabeceras de seguridad, orígenes permitidos y límites de uso (guardados en Redis)                                       | Defensa en capas, documentada en el [modelo de amenazas](docs/threat-model.md).                                                   |
| **pino** · **prom-client**                            | ^10.3.1 · ^15.1.3                         | Logs estructurados (sin datos sensibles) y métricas Prometheus                                                          | Operación en producción: `/health`, `/ready` y `/metrics`.                                                                        |
| **Vite** (frontend)                                   | ^7.3.7                                    | Servidor de desarrollo y build                                                                                          | Sin framework: el curso evalúa DOM, eventos y asincronía de forma directa.                                                        |
| **Vitest** · **supertest** · **Playwright** · **axe** | ^4.1.12 · ^7.3.0 · ^1.63.0 · ^4.13.0      | Tests unitarios y de integración, E2E en Chromium y accesibilidad                                                       | Integración contra una base real con las migraciones reales; E2E contra el sistema completo.                                      |
| **ESLint** · **Prettier**                             | ^10.11.0 · ^3.9.9                         | Reglas y formato (en el frontend, por ejemplo, prohíben `innerHTML`)                                                    | La CI los exige antes de las pruebas.                                                                                             |
| **GitHub Actions** · **gitleaks**                     | gitleaks `v8.21.2`                        | CI en cada push: lint, tipos, tests (también en orden aleatorio), build, mutaciones, `npm audit` y búsqueda de secretos | Nada llega a `main` sin pasar las pruebas, y ningún secreto entra al historial.                                                   |
| **Docker**                                            | imagen `node:24-bookworm-slim`            | Una imagen para la API y el worker; Postgres y Redis en desarrollo                                                      | El mismo artefacto en local y en Railway, sin usuario root.                                                                       |
| **Railway** · **Vercel** · **Cloudflare**             | —                                         | API, worker, PostgreSQL y Redis en Railway; frontend en Vercel; DNS y R2 en Cloudflare                                  | Despliegue al hacer `push` a `main`, HTTPS automático y dominios propios.                                                         |

## 4. Qué necesita el profesor

### a) Opción recomendada: solo el navegador

- Un navegador actualizado: **Chrome, Edge o Firefox** de escritorio, con acceso a internet.
- La URL: <https://atencion.jonarproyectos.com>. No hay que instalar nada.
- **Para las llamadas de voz:** micrófono y altavoces (o audífonos con micrófono). El navegador pide
  permiso para usar el micrófono la primera vez que pulsas **Llamar**: elige **Permitir**. Si lo
  negaste, se reactiva en el candado de la barra de direcciones → **Micrófono → Permitir** y se
  recarga la página.
- **Para entrar como administrador:** una aplicación de códigos en el teléfono (Google
  Authenticator, Microsoft Authenticator o similar). La verificación en dos pasos es obligatoria para
  ese rol (ver [Acceso y roles](#5-acceso-y-roles)).
- **Para probar el tiempo real:** dos ventanas del navegador lado a lado, una como cliente y otra
  como asesor. Para probar el rol de asesor y el de administrador a la vez, usa una ventana normal y
  otra de incógnito (cada una guarda su propia sesión).
- Para los adjuntos: un PDF y una foto (JPEG, PNG o WebP) de menos de 5 MB.

Comprobación rápida de que todo está en línea: abre
<https://api-atencion.jonarproyectos.com/ready>. Debe mostrar
`{"status":"ready","checks":{"database":"ok","redis":"ok"}}`.

### b) Opción local (opcional)

Levanta todo en tu equipo con la IA, la voz, el correo y los archivos **simulados**: no hace falta
ninguna clave de servicios externos. Los comandos se probaron en Windows 11 con `cmd.exe`.

**Requisitos**

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) en ejecución (PostgreSQL y Redis
  corren en contenedores).
- [Node.js](https://nodejs.org/) **20 o superior** (la CI usa 24) con npm.
- [Git](https://git-scm.com/).
- Puertos libres: 5434 (PostgreSQL), 6380 (Redis), 4100 (API), 9465 (worker) y 5174 (frontend).
- En Linux o macOS, además, el cliente `psql` de PostgreSQL (los scripts `.sh` lo usan).

**1. Descarga los tres repositorios en la misma carpeta** (los tests y los scripts esperan que sean
carpetas hermanas):

```bat
mkdir atencion-ia
cd atencion-ia
git clone https://github.com/Jonar519/atencion-ia-database.git
git clone https://github.com/Jonar519/atencion-ia-backend.git
git clone https://github.com/Jonar519/atencion-ia-frontend.git
```

**2. Base de datos y Redis** (crea las tablas y carga los datos de prueba):

```bat
cd atencion-ia-database
docker compose up -d
scripts\migrate.bat
scripts\seed.bat
cd ..
```

En Linux o macOS:

```bash
cd atencion-ia-database
docker compose up -d
export DATABASE_URL="postgresql://postgres:postgres@localhost:5434/atencion_ia"
./scripts/migrate.sh
./scripts/seed.sh
cd ..
```

Esperado: `Listo: N migracion(es) nueva(s) aplicada(s).` y `Datos de prueba cargados correctamente.`
(si los repites, la migración dice `0 migracion(es)` y el seed no duplica nada).

**3. Backend** (API y worker):

```bat
cd atencion-ia-backend
npm install
npx prisma generate
copy .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Abre `.env` y reemplaza `JWT_SECRET` por el valor que imprimió el último comando. Vuelve a ejecutar
ese comando y pon el segundo valor (distinto) en `IP_HASH_SECRET`. El resto de `.env.example` ya
trae valores de desarrollo, por ejemplo:

```ini
DATABASE_URL=postgresql://postgres:postgres@localhost:5434/atencion_ia
REDIS_URL=redis://localhost:6380
PORT=4100
CORS_ORIGIN=http://localhost:5174
AI_PROVIDER=mock
VOICE_PROVIDER=mock
EMAIL_PROVIDER=mock
STORAGE_PROVIDER=local
```

Indexa la base de conocimiento de prueba (una vez) y arranca la API y el worker, **cada uno en su
propia ventana** de `cmd`:

```bat
npm run kb:reindex
npm run dev
```

```bat
cd atencion-ia\atencion-ia-backend
npm run worker
```

Esperado: `API escuchando en http://localhost:4100`, `WebSocket de voz en /ws/voice (proveedor: mock)`
y, en la otra ventana, `Worker iniciado`.

**4. Frontend** (en una tercera ventana):

```bat
cd atencion-ia\atencion-ia-frontend
npm install
npm run dev
```

Esperado: `Local: http://localhost:5174/`. La app usa por defecto la API en `http://localhost:4100`
(`VITE_API_URL` en `.env.example` del frontend; solo hace falta cambiarlo si usas otro puerto).

**5. Comprueba que funciona**

1. <http://localhost:4100/ready> → `{"status":"ready","checks":{"database":"ok","redis":"ok"}}`.
2. <http://localhost:5174> → la portada de Banco Cordillera.
3. Entra al panel con una cuenta de prueba del seed (por ejemplo `laura@cordillera.example`; las
   cuentas y su contraseña de prueba están en el
   [README de atencion-ia-database](https://github.com/Jonar519/atencion-ia-database#datos-de-prueba-seed)).
4. Sigue la [guía de pruebas](#6-guía-de-pruebas-función-por-función). Diferencias en local: la IA
   simulada responde con reglas fijas, los correos no se envían (se guardan en la tabla
   `email_outbox`, ver [Solución de problemas](#9-solución-de-problemas)) y el reconocimiento de voz
   simulado no entiende lo que dices: reconoce frases de un guion de prueba.

Para detener todo: **Ctrl+C** en cada ventana y `docker compose stop` en `atencion-ia-database`.

## 5. Acceso y roles

### Roles

| Quién             | Cómo entra                                                            | Qué puede hacer                                                                                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cliente**       | Sin cuenta: **Soy cliente → Iniciar chat** (nombre opcional)          | Chatear con la IA, llamar por voz, adjuntar archivos, ver solo **sus** conversaciones (máximo 3 abiertas a la vez).                                                                                                                                        |
| **Asesor**        | **Entrar al panel de asesores** con correo y contraseña               | Ver la cola y leer un caso antes de tomarlo, tomar, responder, adjuntar, usar respuestas predefinidas, cerrar, unirse a llamadas, cambiar su disponibilidad y gestionar su perfil. No ve los casos de otros asesores ni los que atiende la IA sin escalar. |
| **Administrador** | Igual que el asesor, más la **verificación en dos pasos obligatoria** | Todo lo del asesor, más: base de conocimiento, respuestas predefinidas, equipo (invitar, reenviar o cancelar invitaciones, reasignar casos, exportar datos y eliminar la cuenta de un asesor) y analítica.                                                 |

La interfaz oculta lo que tu rol no puede hacer, pero quien decide es siempre la API: si alguien
intenta entrar a una ruta de administrador con una cuenta de asesor, la pantalla lo devuelve al panel
y la API responde 403.

### Credenciales

Las credenciales **no** están en este README. El estudiante las entrega por un canal privado, o
envía una **invitación por correo** a la dirección del profesor:

<!-- ACCESO: lo completa el estudiante -->

- **Invitación por correo:** llega desde `no-responder@jonarproyectos.com` con un enlace a
  **Completa tu cuenta**, donde eliges tu propia contraseña (mínimo 12 caracteres, sin tu nombre ni
  tu correo). El enlace **vence a las 72 horas** y sirve una sola vez.
- **Si la invitación venció o no funciona:** la pantalla dice **Invitación no válida** (el mismo
  mensaje para un enlace vencido, usado, cancelado o mal copiado). Pide al estudiante que pulse
  **Reenviar** en **Equipo**: llega un enlace nuevo con otras 72 horas y el anterior deja de servir.
- **Si no llega el correo:** revisa la carpeta de spam. El servicio de correo está en modo de
  pruebas y solo entrega a direcciones verificadas por el estudiante (ver
  [Limitaciones](#8-limitaciones-conocidas-y-decisiones-de-diseño)); confírmale qué dirección usas.

### Verificación en dos pasos (MFA)

- **Administrador: obligatoria.** La primera vez que entras (o al completar una invitación de
  administrador) aparece **Activa la verificación en dos pasos** con un código QR. Escanéalo con la
  aplicación de códigos, escribe los 6 dígitos → **Activar y entrar**, guarda los **10 códigos de
  respaldo**, marca **Ya guardé mis códigos** → **Continuar**. Desde entonces, después de la
  contraseña se pide el código de la aplicación (o uno de respaldo, que sirve una sola vez).
- **Asesor: opcional.** Se activa en **Mi perfil → Verificación en dos pasos → Activar**.

### Si algo del acceso falla

| Situación                                      | Qué hacer                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Olvidaste la contraseña                        | En el inicio de sesión, **¿Olvidaste tu contraseña?** → escribe tu correo → **Enviar enlace**. El enlace vence en 15 minutos y sirve una vez.                       |
| "Credenciales inválidas"                       | Revisa mayúsculas y espacios. Tras 5 intentos fallidos, la cuenta se bloquea unos minutos (1, 2, 4… hasta 60): espera y vuelve a intentar.                          |
| "El código no es correcto"                     | Revisa que la hora del teléfono sea automática. Cinco códigos errados seguidos obligan a volver a escribir la contraseña. Puedes usar un código de respaldo.        |
| Perdiste el teléfono y los códigos de respaldo | No hay botón para eso, a propósito. El estudiante quita la verificación de tu cuenta con un comando del servidor y, al entrar, la activas de nuevo.                 |
| La sesión se cerró sola                        | El acceso dura 15 minutos y se renueva solo mientras usas la app; si pasas 7 días sin usarla, o si alguien cerró tus sesiones desde **Mi perfil**, vuelve a entrar. |
