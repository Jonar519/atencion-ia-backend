# Atención IA: atención al cliente con inteligencia artificial

**Producción:** aplicación en <https://atencion.jonarproyectos.com> · API en
`api-atencion.jonarproyectos.com` (estado: [`/ready`](https://api-atencion.jonarproyectos.com/ready)).

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
6. [Guía de pruebas función por función](#6-guía-de-pruebas-función-por-función)
7. [Pruebas automatizadas](#7-pruebas-automatizadas)
8. [Limitaciones conocidas y decisiones de diseño](#8-limitaciones-conocidas-y-decisiones-de-diseño)
9. [Solución de problemas](#9-solución-de-problemas)
10. [Estructura del repositorio](#10-estructura-del-repositorio)
11. [Glosario](#11-glosario)

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
   cuentas y su contraseña de prueba están en la
   [referencia técnica de atencion-ia-database](https://github.com/Jonar519/atencion-ia-database/blob/main/docs/referencia-tecnica.md#datos-de-prueba-seed); solo existen en local).
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

## 6. Guía de pruebas función por función

Un recorrido de unos **25 minutos** en producción, en este orden. La columna **Depende de** indica
si la función usa un servicio externo (si ese servicio falla, la función puede fallar sin que sea
un error del proyecto); "No" significa que solo usa la API y la base de datos propias.

**Preparación:** ventana A (normal) para el **cliente** y ventana B (incógnito) para el **panel**,
lado a lado. Necesitas una cuenta de administrador (y, si el estudiante la entregó, una de asesor;
si no, el administrador hace todo lo del asesor).

> **Antes de empezar, carga contenido en la base de conocimiento (paso F1).** La base de producción
> no trae los datos de prueba: si nadie publicó artículos, el asistente responde que no tiene la
> información y ofrece un asesor (es el comportamiento correcto, pero no muestra el RAG). Con un
> artículo publicado, la pregunta del paso B3 obtiene una respuesta basada en él.

### A. Portada y apariencia (1 min)

| Función              | Qué hace                                                       | Pasos para probarla                                                                                                     | Resultado esperado                                                                                                                           | Depende de |
| -------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A1. Portada          | Presenta el servicio y las dos entradas                        | Abre <https://atencion.jonarproyectos.com>                                                                              | "Banco Cordillera · Atención al cliente, a cualquier hora", un ejemplo de conversación, **Soy cliente** y **Entrar al panel de asesores →**. | No         |
| A2. Tema del sistema | Toda la app sigue el modo claro u oscuro del sistema operativo | Cambia el modo de tu sistema (en Windows: Configuración → Personalización → Colores → Elige tu modo) con la app abierta | La página cambia de tema al instante, sin recargar. No hay selector de tema en la app, a propósito.                                          | No         |

### F. Administración, parte 1: contenido para el asistente (3 min)

Inicia sesión como administrador en la ventana B (**Entrar al panel de asesores →**; ver
[Verificación en dos pasos](#verificación-en-dos-pasos-mfa)).

| Función                     | Qué hace                                                      | Pasos para probarla                                                                                                                                                                                                                                                                                                                                                                      | Resultado esperado                                                                                                                                                                                                | Depende de              |
| --------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| F1. Base de conocimiento    | El admin crea, edita, publica, archiva o borra artículos      | Barra superior → **Base de conocimiento** → **Nuevo artículo** → **Título** "Horarios de atención" (el **Identificador** se sugiere solo), **Categoría** "oficinas", **Contenido** "Las oficinas atienden de lunes a viernes de 8:00 a 4:00 y los sábados de 9:00 a 12:00.", **Estado** **Publicado** → **Crear artículo**. Para editar, archivar o borrar, abre el artículo de la lista | El artículo aparece en la lista como **Publicado**. Solo lo publicado llega al asistente; el worker lo indexa en segundos. Un borrador o un archivado no se usa, y al cambiar título o contenido sube su versión. | IA (Voyage, embeddings) |
| F2. Respuestas predefinidas | Textos listos para los asesores, con `{cliente}` y `{asesor}` | **Respuestas** → **Nueva respuesta** → título "Saludo", texto `Hola {cliente}, soy {asesor}. ¿En qué te puedo ayudar?`, atajo `saludo`, deja marcada **Activa** → **Crear**                                                                                                                                                                                                              | Aparece en la lista. La usarás en C5.                                                                                                                                                                             | No                      |
| F3. Guardas por rol         | La administración es solo para el admin                       | Si tienes cuenta de asesor: entra con ella y escribe en la barra de direcciones `https://atencion.jonarproyectos.com/#/admin/analytics`                                                                                                                                                                                                                                                  | Vuelves al panel con el aviso "Esa sección es solo para administradores". Con la cuenta de admin, la barra muestra **Base de conocimiento · Respuestas · Equipo · Analítica**.                                    | No                      |

### B. El cliente y el asistente de IA (5 min)

En la ventana A: **Soy cliente** → **Iniciar chat** (el nombre es opcional).

| Función                                         | Qué hace                                                      | Pasos para probarla                                                                                          | Resultado esperado                                                                                                                                                                      | Depende de          |
| ----------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| B1. Sesión anónima                              | El cliente chatea sin registrarse                             | Pulsa **Iniciar chat**                                                                                       | Arriba dice **En línea**, con **Llamar** y **Salir**, y "¿En qué te podemos ayudar?" con tres preguntas de ejemplo.                                                                     | No                  |
| B2. Preguntas de ejemplo                        | Ayudan a empezar sin enviar nada solo                         | Haz clic en "¿Cuál es el horario de las oficinas?"                                                           | El texto se **escribe** en la caja de mensaje, pero no se envía hasta que pulses **Enviar**.                                                                                            | No                  |
| B3. Respuesta con la base de conocimiento (RAG) | La IA responde solo con lo publicado                          | Pulsa **Enviar** con la pregunta del horario                                                                 | En unos segundos responde el **Asistente virtual** con el horario del artículo de F1. Sin ese artículo, dice que no tiene el dato y ofrece un asesor: no inventa.                       | IA (Claude, Voyage) |
| B4. Sin datos de cuentas                        | La IA no tiene acceso a saldos ni movimientos                 | Escribe "¿cuál es mi saldo?"                                                                                 | Explica que no puede ver cuentas y orienta (o, si insistes varias veces sin apoyo en la base, escala a un asesor).                                                                      | IA (Claude)         |
| B5. Aviso local de urgencia                     | Mientras escribes, un Web Worker detecta palabras de urgencia | Escribe, **sin enviar**, "No reconozco un cargo de $450.000 en mi tarjeta"                                   | Aparece "Esto se ve urgente: si hay un cargo que no reconoces, te conectamos más rápido con un asesor." Es solo un aviso en tu navegador: quien decide es el servidor.                  | No                  |
| B6. Escalamiento por posible fraude             | El motor escala con prioridad urgente                         | Pulsa **Enviar** con ese mensaje                                                                             | Un mensaje de seguridad (bloquear la tarjeta) y que te comunica con un asesor; arriba: "Te estamos comunicando con un asesor…". En la ventana B el caso aparece **sin recargar** (C2).  | IA (Claude)         |
| B7. Adjuntar un archivo                         | El cliente envía una imagen o un PDF                          | **Adjuntar** → elige un PDF → escribe "¿me explicas este cargo?" → **Enviar**. Luego **Adjuntar** → una foto | Antes de enviar ves la vista previa con nombre, tamaño y **Quitar**. Se envía como una tarjeta con **Descargar**; la foto se ve en el chat (se sube reducida y sin datos de ubicación). | Archivos (R2)       |
| B8. Archivo no permitido                        | Solo imágenes PNG, JPEG o WebP y PDF de hasta 5 MB            | **Adjuntar** → elige un `.txt` o un `.gif`                                                                   | "Solo puedes adjuntar imágenes (PNG, JPEG, WebP) o documentos PDF." y no se envía nada.                                                                                                 | No                  |

La IA nunca lee los adjuntos: solo recibe la señal de que el cliente adjuntó un archivo y de qué
tipo. Si envías un PDF sin comentario a una conversación que atiende la IA, te pedirá que describas lo
que muestra.

### C. El panel del asesor y el tiempo real (5 min)

En la ventana B (como asesor, o como admin si no tienes cuenta de asesor).

| Función                                   | Qué hace                                                                 | Pasos para probarla                                                                                           | Resultado esperado                                                                                                                                                                                    | Depende de    |
| ----------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| C1. Disponibilidad                        | El asesor indica si recibe casos                                         | Arriba, **Mi disponibilidad** → **Disponible**                                                                | Queda marcada. Los avisos de casos nuevos van a los asesores disponibles y con cupo.                                                                                                                  | No            |
| C2. Cola en tiempo real con prioridad     | Los casos escalados llegan sin recargar, el más urgente primero          | Mira la pestaña **Cola** después de B6                                                                        | **Cola (1)** con el cliente, la prioridad legible (un posible fraude suele quedar **Urgente · 90**; pedir un asesor, **Alta · 60**), el motivo y el último mensaje; un aviso "Nuevo caso en la cola". | No            |
| C3. Leer antes de tomar                   | El asesor ve el historial completo antes de comprometerse                | Haz clic en el caso                                                                                           | Se abre con estado **En espera de asesor**, la intención y el ánimo de cada mensaje del cliente (por ejemplo "Posible fraude · Negativo") y el botón **Tomar caso**. Aún no puedes responder.         | No            |
| C4. Tomar el caso                         | Asignación atómica: si dos asesores lo toman a la vez, gana uno          | **Tomar caso**                                                                                                | Pasa a **Mis casos (1)**, estado **En atención** · "Lo atiendes tú". En la ventana A: "Te atiende un asesor de Banco Cordillera" y "… se unió a la conversación".                                     | No            |
| C5. Responder y respuestas predefinidas   | Mensajes del asesor al cliente; plantillas con nombres                   | Botón **Respuestas** → busca `saludo` → haz clic. Revisa el texto y pulsa **Enviar** (o Enter)                | La plantilla se escribe con los nombres reemplazados **sin enviarse sola**. Al enviar, aparece al instante en la ventana A como "… · Asesor".                                                         | No            |
| C6. El cliente responde en vivo           | Tiempo real en los dos sentidos                                          | En la ventana A escribe "gracias, ¿qué hago con la tarjeta?" → **Enviar**                                     | Aparece en el panel sin recargar, con su intención y ánimo.                                                                                                                                           | IA (Claude)   |
| C7. Adjuntos del asesor y descarga        | El asesor ve y descarga lo del cliente y adjunta lo suyo                 | En el caso, **Descargar** en la tarjeta del PDF de B7; luego **Adjuntar** junto a **Respuestas** → un archivo | El PDF se descarga. El adjunto del asesor aparece en la ventana A.                                                                                                                                    | Archivos (R2) |
| C8. Cerrar el caso                        | Termina la conversación y resuelve el escalamiento                       | **Cerrar caso**                                                                                               | El caso queda **Cerrada** y sale de **Mis casos**. En la ventana A: "La conversación terminó" y **Nueva conversación**.                                                                               | No            |
| C9. Cupo por asesor                       | Un asesor atiende como máximo 3 casos a la vez (configurable por cuenta) | Con 3 casos en **Mis casos**, intenta tomar un cuarto                                                         | "Ya atiendes 3 conversaciones, tu máximo. Cierra una antes de tomar otra."                                                                                                                            | No            |
| C10. Máximo de conversaciones del cliente | Un cliente tiene como máximo 3 abiertas                                  | En la ventana A, con 3 conversaciones abiertas, pulsa **Nueva conversación**                                  | "Ya tienes 3 conversaciones abiertas. Continúa en una de ellas."                                                                                                                                      | No            |

### D. Llamada de voz (5 min)

Necesitas micrófono y altavoces. En la ventana A, con una conversación nueva:

| Función                           | Qué hace                                                                          | Pasos para probarla                                                                                 | Resultado esperado                                                                                                                                                                      | Depende de         |
| --------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| D1. Consentimiento                | Sin aceptar el aviso de privacidad no hay llamada                                 | **Llamar**                                                                                          | Aparece el aviso (qué se transcribe, que no se graba el audio, cuánto tiempo se guarda). **Aceptar y llamar** está deshabilitado hasta marcar **Leí y acepto**.                         | No                 |
| D2. Permiso del micrófono         | Sin micrófono no se crea la llamada                                               | Marca **Leí y acepto** → **Aceptar y llamar** → el navegador pide el micrófono → **Permitir**       | Barra de llamada oscura con **LLAMADA EN CURSO**. Si niegas el permiso: "No diste permiso para usar el micrófono…" y no se crea ninguna llamada.                                        | No                 |
| D3. Hablar con la IA por voz      | El audio pasa a texto, entra al mismo motor del chat y la respuesta vuelve en voz | Di despacio "¿Cuál es el horario de atención de las oficinas?" y espera                             | Tu frase aparece transcrita en el chat como turno de voz y escuchas la respuesta del asistente; la **forma de onda** se mueve con tu voz. **Interrumpir** corta la respuesta hablada.   | Voz (Deepgram), IA |
| D4. Silenciar                     | Deja de enviar audio                                                              | **Silenciar**                                                                                       | La forma de onda queda plana y atenuada; lo que digas no se transcribe hasta que vuelvas a activar el micrófono.                                                                        | No                 |
| D5. Escalar por voz               | Las mismas reglas que el texto                                                    | Di "Quiero hablar con un asesor"                                                                    | La llamada queda **en espera de asesor**: el borde de la barra se llena de color menta una sola vez. En la ventana B el caso aparece en la cola con la llamada activa.                  | Voz (Deepgram), IA |
| D6. El asesor se une a la llamada | Toma el caso y habla con el cliente por WebRTC, con la transcripción en vivo      | En la ventana B abre el caso → **Unirse a la llamada** (el navegador pide el micrófono también ahí) | Las dos barras muestran **ASESOR CONECTADO**; lo que dice el cliente aparece transcrito en vivo en el panel. Usa audífonos si las dos ventanas están en el mismo equipo (evita el eco). | Voz (Deepgram)     |
| D7. Salir o colgar                | El asesor deja la llamada o la termina; el cliente cuelga                         | En el panel **Salir de la llamada**, o en la ventana A **Colgar**                                   | La llamada termina en las dos ventanas y el micrófono se apaga (el indicador del navegador desaparece). La transcripción queda en la conversación.                                      | No                 |

### E. Cuenta del asesor (4 min)

En la ventana B, clic en tu nombre (arriba a la derecha) → **Mi perfil**.

| Función                       | Qué hace                                                             | Pasos para probarla                                                                                   | Resultado esperado                                                                                                                                                         | Depende de    |
| ----------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| E1. Menú de usuario           | Acceso a **Mi perfil** y **Salir** en todas las pantallas del equipo | Clic en tu nombre; prueba también con el teclado (Tab hasta el botón, Enter, Escape)                  | Muestra tu rol y correo, **Mi perfil** y **Salir**. Escape lo cierra y devuelve el foco al botón.                                                                          | No            |
| E2. Datos y foto de perfil    | Nombre, teléfono y foto recortada                                    | Cambia el teléfono → **Guardar**. **Elegir una foto** → acerca y encuadra → **Guardar foto**          | Se guarda; la foto aparece en el menú. Solo se sube el recorte de 256 × 256 px.                                                                                            | Archivos (R2) |
| E3. Sesiones activas          | Ver y cerrar sesiones abiertas en otros dispositivos                 | Entra con la misma cuenta en otro navegador. En el primero: **Sesiones activas**                      | Cada sesión con navegador, sistema, **ubicación aproximada** y fechas; la tuya dice **Esta sesión**. **Cerrar sesión en los demás dispositivos** saca al otro navegador.   | No            |
| E4. Verificación en dos pasos | Activar o desactivar la MFA y regenerar códigos de respaldo          | Como asesor: **Verificación en dos pasos → Activar** y sigue el QR. Luego **Salir** y vuelve a entrar | Tras la contraseña se pide el código. "El código no es correcto" con un código errado; un código de respaldo funciona una sola vez.                                        | No            |
| E5. Cambiar la contraseña     | Pide la actual y aplica la política                                  | **Contraseña** → actual, nueva de 12+ caracteres dos veces → **Cambiar contraseña**                   | Confirmación. Con una contraseña que contiene tu nombre o es muy común, explica qué falla. Las demás sesiones se cierran.                                                  | No            |
| E6. Cambiar el correo         | Confirma la dirección nueva con un enlace                            | **Correo** → correo nuevo y tu contraseña → **Enviar enlace de confirmación**                         | Llega un enlace al correo nuevo (vence en 15 minutos) y un aviso al anterior; el cambio aplica al abrir el enlace.                                                         | Correo (SES)  |
| E7. Recuperar la contraseña   | Enlace de un solo uso por correo, sin revelar si la cuenta existe    | **Salir** → **¿Olvidaste tu contraseña?** → tu correo → **Enviar enlace**                             | El mismo mensaje exista o no la cuenta. El correo trae un enlace (vence en 15 minutos) para elegir la contraseña nueva; usado una vez, el mismo enlace dice que ya se usó. | Correo (SES)  |
| E8. Descargar mis datos       | Exporta lo que el sistema guarda de ti                               | **Tus datos personales → Descargar mis datos**                                                        | Se descarga un JSON con perfil, sesiones y actividad, sin secretos ni contenido de clientes.                                                                               | No            |
| E9. Salir                     | Cierra la sesión, también en las otras pestañas                      | Abre el panel en dos pestañas y pulsa **Salir** en una                                                | Las dos quedan en el inicio de sesión.                                                                                                                                     | No            |

### F. Administración, parte 2 (3 min)

Como administrador:

| Función                                        | Qué hace                                                             | Pasos para probarla                                                                                                                                    | Resultado esperado                                                                                                                                                                                              | Depende de   |
| ---------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| F4. Invitar a un asesor                        | La única forma de crear cuentas del equipo (no hay registro público) | **Equipo** → **Invitar asesor** → nombre, un correo tuyo verificado por el estudiante y rol **Asesor** → **Enviar invitación**                         | Aparece **Invitación pendiente · vence …** (72 horas) con **Reenviar** y **Cancelar**. El enlace no se muestra en pantalla: solo llega por correo.                                                              | Correo (SES) |
| F5. Completar la cuenta invitada               | La persona invitada elige su contraseña                              | Abre el enlace del correo en una ventana de incógnito → **Completa tu cuenta** → contraseña de 12+ caracteres                                          | "Tu cuenta está lista" y entra al panel. Si abres el mismo enlace otra vez: **Invitación no válida**. Una invitación de administrador pasa obligatoriamente a activar la MFA.                                   | Correo (SES) |
| F6. Reenviar o cancelar una invitación         | Invalida el enlace anterior / borra la cuenta pendiente              | En una invitación pendiente: **Reenviar**, o **Cancelar** (pide confirmación)                                                                          | Reenviar: llega un enlace nuevo y el anterior deja de servir. Cancelar: la fila desaparece.                                                                                                                     | Correo (SES) |
| F7. Reasignar casos                            | Pasa los casos en curso de un asesor a otro                          | Con un caso tomado por un asesor: en **Equipo**, su fila muestra "1 caso(s) en curso" → **Reasignar 1 caso(s)** → elige a otra persona → **Reasignar** | El caso pasa al otro asesor y en el chat del cliente aparece que la otra persona continúa la conversación.                                                                                                      | No           |
| F8. Exportar y eliminar la cuenta de un asesor | Derecho de acceso y de supresión de datos personales                 | En la fila de un asesor de prueba: **Exportar datos**; luego **Eliminar cuenta** (si tiene casos, primero hay que reasignarlos) → confirma             | Se descarga su JSON. Tras confirmar, la fila queda como cuenta eliminada (anonimizada): se borran sus datos personales y se conservan los registros de los casos. **No lo hagas con una cuenta que necesites.** | No           |
| F9. Analítica                                  | Métricas del servicio con su tabla de datos                          | **Analítica** → cambia el **Periodo** (Últimas 24 h, 7, 30 o 90 días) → **Ver datos**                                                                  | Tiempo medio y mediana de resolución, tasa de escalamiento, CSAT con el rótulo **SIMULADO** y conversaciones por hora del día (hora de Bogotá). Cada barra se enfoca con Tab y dice su valor.                   | No           |
| F10. Desactivar una respuesta predefinida      | Las inactivas no las ven los asesores                                | **Respuestas** → abre "Saludo" → desmarca **Activa** → guarda. En el panel, **Respuestas** → busca `saludo`                                            | Ya no aparece para los asesores; en la administración figura como **Desactivada**.                                                                                                                              | No           |

### G. Robustez, seguridad y operación (2 min, opcional)

| Función                          | Qué hace                                                | Pasos para probarla                                                                                                            | Resultado esperado                                                                                                                                                                                    | Depende de |
| -------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| G1. Sin conexión y reintento     | Avisos de conectividad y mensajes que no se pierden     | En el chat, F12 → **Network** → **Offline**. Envía un mensaje. Vuelve a **No throttling** y pulsa **Reintentar** en el mensaje | "Sin conexión a internet…"; el mensaje queda "No se envió." con **Reintentar**; al volver: "Conexión restablecida." y el mensaje se envía una sola vez.                                               | No         |
| G2. Página sin conexión          | El Service Worker sirve una página propia si no hay red | Con la red en **Offline**, recarga la portada                                                                                  | La portada carga igual desde la caché del Service Worker (si la caché está vacía, una página propia de "sin conexión"), en vez del error del navegador. Las conversaciones nunca se guardan en caché. | No         |
| G3. Ningún token en el navegador | Las sesiones viven en cookies httpOnly y en memoria     | F12 → **Application** → Local Storage y Session Storage                                                                        | Ningún token de sesión guardado: viven en cookies httpOnly de la API y, el del asesor, solo en memoria.                                                                                               | No         |
| G4. Tiempo real por WebSocket    | La app recibe eventos por `wss://api-atencion…`         | F12 → **Network** → filtro **WS** con el panel abierto                                                                         | Una conexión a `wss://api-atencion.jonarproyectos.com/ws` que recibe mensajes cuando cambia la cola.                                                                                                  | No         |
| G5. Salud del servicio           | Sondas para la plataforma de despliegue                 | Abre <https://api-atencion.jonarproyectos.com/health> y `/ready`                                                               | `/health`: `{"status":"ok",…}`. `/ready`: base de datos y Redis en `ok`.                                                                                                                              | No         |
| G6. Aislamiento entre clientes   | Un cliente no ve conversaciones de otro                 | Abre el chat en otro navegador (otra sesión anónima)                                                                           | No aparece nada de la conversación anterior. (El aislamiento entre asesores y entre clientes lo prueban `authorization.test.ts` y `widget.test.ts`.)                                                  | No         |

### Funciones sin pantalla (se evalúan por los tests o la documentación)

| Función                                                                                       | Dónde está                                                                              | Cómo se comprueba                                                                                          |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Desactivar una cuenta o cambiar su rol (cierra sus sesiones)                                  | `PATCH /api/staff/:id` (solo admin)                                                     | `tests/integration/kbAndStaff.test.ts`                                                                     |
| Ver todas las conversaciones (admin)                                                          | `GET /api/conversations?scope=all`                                                      | `tests/integration/authorization.test.ts`                                                                  |
| Barrido de llamadas abandonadas (cada minuto) y purga de transcripciones vencidas (cada hora) | Worker, cola `voice-maintenance`                                                        | `tests/integration/voice.test.ts` · [docs/privacy-voice.md](docs/privacy-voice.md)                         |
| Límites de uso (por IP, sesión, usuario, tokens de IA y segundos de voz)                      | Redis; tabla en la [referencia técnica](docs/referencia-tecnica.md#rate-limiting-redis) | `tests/integration/auth.test.ts`, `widget.test.ts`, `engine.test.ts` y `voice.test.ts`                     |
| Métricas Prometheus                                                                           | `GET /metrics` con token                                                                | `tests/integration/observability.test.ts`                                                                  |
| Auditoría (inicios de sesión, cambios del equipo y de la base, acciones sobre casos)          | Tabla `audit_log`                                                                       | Tests de integración de cada módulo                                                                        |
| Scripts de operación: primer admin, quitar la MFA, reindexar el RAG, purgas                   | `npm run admin:crear`, `staff:reset-mfa`, `kb:reindex`, `voice:purge`, `storage:purge`  | [Referencia técnica: scripts](docs/referencia-tecnica.md#scripts) · `tests/integration/crearAdmin.test.ts` |
| Apagado ordenado (termina lo que está en curso antes de salir)                                | `src/lifecycle/shutdown.ts`, `VoiceServer.close()`                                      | `tests/unit/shutdown.test.ts`, `tests/integration/voice.test.ts`                                           |

## 7. Pruebas automatizadas

Necesitan la opción local (Docker en marcha con PostgreSQL y Redis de `atencion-ia-database`). Las
pruebas del backend crean su propia base desechable (`atencion_ia_test`) aplicando las migraciones
reales, así que no tocan los datos de desarrollo.

| Repositorio            | Comando                                                   | Qué cubre                                                                                                                                                                                                                                                                                                          | Resultado esperado                                                                |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `atencion-ia-backend`  | `scripts\verify.bat` (Windows) o `bash scripts/verify.sh` | Lint, tipos, tests unitarios y de integración y build. Integración contra la base real: sesión completa, CSRF, límites de uso, aislamiento entre asesores y entre clientes, carreras, motor de IA y escalamiento, aislamiento del RAG, WebSocket real, voz completa, MFA, invitaciones, adjuntos y administración. | `Tests 467 passed (467)` en 39 archivos y `Verificación completa: todo en orden.` |
| `atencion-ia-backend`  | `npm run test:shuffle`                                    | Los mismos tests en orden aleatorio (detecta dependencias ocultas entre tests)                                                                                                                                                                                                                                     | Todos pasan con cualquier semilla.                                                |
| `atencion-ia-backend`  | `npm run test:mutations`                                  | Rompe a propósito 99 reglas críticas (aislamiento del RAG, permisos, consentimiento, MFA, adjuntos…) y exige que algún test falle                                                                                                                                                                                  | `99/99 mutaciones detectadas.`                                                    |
| `atencion-ia-frontend` | `npm test`                                                | Render seguro (XSS), sesión, WebSocket con reconexión, chat, panel, voz, Service Worker, administración, estados de la interfaz y contraste de colores medido (WCAG)                                                                                                                                               | `Tests 416 passed (416)` en 24 archivos.                                          |
| `atencion-ia-frontend` | `npm run test:mutations`                                  | 124 reglas críticas del frontend rotas a propósito                                                                                                                                                                                                                                                                 | `124/124 mutaciones detectadas.`                                                  |
| `atencion-ia-frontend` | `scripts\e2e.bat`                                         | Playwright contra el sistema completo en un entorno aislado: flujo de texto, llamada de voz con WebRTC, adjuntos, invitación, tema del sistema y API en otro origen; incluye accesibilidad con axe                                                                                                                 | Todos los escenarios en verde.                                                    |
| `atencion-ia-database` | `scripts\migrate.bat` y `scripts\test.bat` (o sus `.sh`)  | Migraciones repetibles y 7 archivos de pruebas del esquema: reglas de la base, aislamiento del RAG, voz, identidad, respuestas predefinidas, adjuntos e invitaciones                                                                                                                                               | `Todas las pruebas del esquema pasaron.`                                          |

La **CI** (GitHub Actions) corre todo esto en cada `push` de los tres repositorios, más `npm audit` y
gitleaks (búsqueda de secretos en todo el historial). Las excepciones vigentes de `npm audit` están
justificadas en el [ADR 0012](docs/adr/0012-excepciones-npm-audit-octubre-2026.md). Hay además
pruebas de carga con su informe: [docs/load-test-report.md](docs/load-test-report.md).

## 8. Limitaciones conocidas y decisiones de diseño

- **Correo en modo de pruebas.** Amazon SES está en modo _sandbox_: solo entrega a direcciones
  verificadas por el estudiante. Las invitaciones, la recuperación de contraseña y el cambio de
  correo solo llegan a esas direcciones.
- **Base de conocimiento de producción.** Los datos de prueba (seed) no se cargan en producción. Sin
  artículos publicados, el asistente responde que no tiene la información y ofrece un asesor. El
  umbral de similitud del RAG con Voyage (`RAG_MIN_SCORE`, 0,45 por defecto) no está calibrado con
  datos reales ([docs/rag.md](docs/rag.md)).
- **Respuestas de la IA no deterministas.** En producción las redacta Claude: el texto exacto cambia
  de una vez a otra. Lo que no cambia son las reglas (qué escala, qué datos ve la IA). En local, la IA
  simulada siempre responde igual.
- **Cuotas de uso.** Cada cliente tiene un tope diario de tokens de IA (60 000 por defecto) y de
  segundos de voz (1 800 por día, 900 por llamada); una sesión del chat envía hasta 12 mensajes por
  minuto y crea hasta 6 llamadas por hora. Al pasar el tope aparece "Alcanzaste el límite diario de
  consultas al asistente…" (o "…de llamadas…"): la conversación puede seguir con un asesor o por
  chat.
- **Voz entre redes distintas.** No hay servidor TURN configurado (`ICE_SERVERS=[]`). La llamada con
  la IA funciona desde cualquier red porque el audio pasa por el servidor, pero el audio directo
  entre el cliente y el asesor (WebRTC) solo conecta si los dos navegadores están en el mismo equipo
  o en la misma red.
- **CSAT simulado.** No existe una encuesta de satisfacción: la analítica muestra un CSAT calculado
  con una regla fija y lo rotula **SIMULADO** ([docs/analytics.md](docs/analytics.md)).
- **Ubicación de las sesiones.** Se calcula solo con una base de datos local de rangos de IP (la IP
  nunca sale del servidor). Sin esa base configurada, las sesiones remotas aparecen sin ciudad.
- **Sin registro público ni selector de tema.** Las cuentas del equipo solo nacen por invitación, y el
  tema lo decide el sistema operativo: ambas son decisiones de diseño, no faltantes.
- **Mensajes no reenviados.** Lo que llega por WebSocket mientras el navegador está desconectado no se
  reenvía; al reconectar, la app vuelve a pedir el historial por REST.

## 9. Solución de problemas

| Síntoma                                                        | Qué hacer                                                                                                                                                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| La página no carga                                             | Abre <https://api-atencion.jonarproyectos.com/ready>. Si no responde, el servicio está caído: avisa al estudiante. Si responde, recarga con Ctrl+F5 (o prueba en incógnito).                          |
| "Desconectado" o "Reconectando…" que no se va                  | Revisa tu conexión. La app reintenta sola; si una red corporativa bloquea WebSockets, prueba otra red.                                                                                                |
| La sesión expiró o el panel vuelve al inicio de sesión         | Vuelve a entrar. Pasa si cerraste sesión en otra pestaña, si se cerraron tus sesiones desde **Mi perfil** o tras 7 días sin usarla.                                                                   |
| No llega el correo (invitación, recuperación)                  | Revisa spam. El correo solo entrega a direcciones verificadas ([Limitaciones](#8-limitaciones-conocidas-y-decisiones-de-diseño)). Pide al estudiante un **Reenviar**.                                 |
| "Invitación no válida"                                         | El enlace venció (72 h), ya se usó o se reenvió uno nuevo. Pide otra invitación.                                                                                                                      |
| El asistente tarda o responde que no tiene la información      | La primera respuesta puede tardar unos segundos (IA real). Si dice que no tiene el dato, publica un artículo sobre el tema (F1) y vuelve a preguntar.                                                 |
| "Alcanzaste el límite diario…"                                 | Es el tope de uso por cliente. Pulsa **Salir** e **Iniciar chat** de nuevo, o escribe "asesor" para seguir con una persona.                                                                           |
| El caso escalado no aparece en el panel                        | Revisa que estés en la pestaña **Cola** y con **Mi disponibilidad** en **Disponible**. Un asesor solo ve la cola y sus propios casos.                                                                 |
| No se puede llamar: permiso del micrófono                      | Candado de la barra de direcciones → **Micrófono → Permitir** y recarga. Revisa que el sistema operativo permita el micrófono al navegador.                                                           |
| El asesor se une pero no se escuchan                           | Sin servidor TURN, el audio directo solo conecta en el mismo equipo o red ([Limitaciones](#8-limitaciones-conocidas-y-decisiones-de-diseño)). La transcripción sí llega.                              |
| Eco o pitido en la llamada                                     | Las dos ventanas en el mismo equipo se escuchan entre sí: usa audífonos.                                                                                                                              |
| "Ya atiendes 3 conversaciones, tu máximo"                      | Cierra un caso en **Mis casos**.                                                                                                                                                                      |
| "Ya tienes 3 conversaciones abiertas"                          | Sigue en una de ellas, o pide a un asesor que cierre una.                                                                                                                                             |
| El código de verificación no funciona                          | Activa la hora automática del teléfono o usa un código de respaldo.                                                                                                                                   |
| Local: la API dice `Configuración inválida`                    | El mensaje indica qué variable de `.env` falta o es insegura (por ejemplo `JWT_SECRET` con menos de 32 caracteres).                                                                                   |
| Local: `Can't reach database server at localhost:5434`         | Docker no está en marcha o falta `docker compose up -d` en `atencion-ia-database`.                                                                                                                    |
| Local: el asistente responde "No encontré información…" a todo | Falta indexar la base de conocimiento: `npm run kb:reindex` en `atencion-ia-backend`.                                                                                                                 |
| Local: no llega ningún correo                                  | En local no se envían: se guardan en la base. Léelos con `docker exec -it atencion_ia_postgres psql -U postgres -d atencion_ia -At -c "SELECT body_text FROM email_outbox ORDER BY id DESC LIMIT 1"`. |
| Local: `prisma generate` falla con `EPERM`                     | La API o el worker tienen abierta la librería de Prisma: detenlos y repite.                                                                                                                           |

## 10. Estructura del repositorio

```
atencion-ia-backend/
├── src/
│   ├── server.ts · app.ts      # arranque, middlewares de seguridad y apagado ordenado
│   ├── config/                 # variables de entorno validadas (zod), Prisma, Redis, logger
│   ├── middlewares/            # autenticación, roles, CSRF, validación, límites de uso, errores
│   ├── modules/                # una carpeta por área: rutas → controlador → servicio
│   │   ├── auth/ · profile/    # login, MFA, sesiones, recuperación y perfil
│   │   ├── staff/              # equipo e invitaciones
│   │   ├── widget/             # sesión anónima y conversaciones del cliente
│   │   ├── conversations/      # cola, tomar, responder, cerrar, reasignar (y quién ve qué)
│   │   ├── engine/ · rag/      # motor conversacional, reglas de escalamiento, búsqueda en la KB
│   │   ├── kb/ · canned/       # base de conocimiento y respuestas predefinidas
│   │   ├── voice/              # llamadas, consentimiento, transcripción y retención
│   │   ├── attachments/        # validación y descarga de adjuntos
│   │   └── analytics/          # métricas de la administración
│   ├── realtime/               # WebSocket de eventos (/ws) y de voz (/ws/voice)
│   ├── services/               # proveedores intercambiables: ai, voice, email, storage, geo, audit
│   ├── queues/ · workers/      # colas BullMQ y el worker
│   ├── observability/          # /health, /ready, métricas
│   ├── lifecycle/              # apagado ordenado
│   ├── scripts/                # operación: primer admin, reindexar, quitar MFA, purgas, demo de voz
│   └── utils/
├── tests/unit · tests/integration
├── prisma/schema.prisma        # cliente de base de datos (el esquema lo manda atencion-ia-database)
├── docs/                       # referencia técnica, ADR, RAG, amenazas, privacidad, carga, demos
├── loadtests/                  # pruebas de carga
├── scripts/                    # verify, pruebas de mutación
└── Dockerfile
```

Los otros repositorios describen su estructura en su propio README:
[atencion-ia-frontend](https://github.com/Jonar519/atencion-ia-frontend#readme) y
[atencion-ia-database](https://github.com/Jonar519/atencion-ia-database#readme).

## 11. Glosario

| Término                             | Qué significa aquí                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **API REST**                        | La interfaz del servidor: direcciones (`/api/...`) que el navegador llama con métodos HTTP (GET, POST…) y que responden JSON.          |
| **Base de conocimiento (KB)**       | Los artículos del banco que el asistente puede usar para responder.                                                                    |
| **Embedding**                       | Una lista de números que representa el significado de un texto; textos parecidos tienen embeddings cercanos.                           |
| **pgvector**                        | Extensión de PostgreSQL que guarda embeddings y busca los más cercanos.                                                                |
| **RAG**                             | _Retrieval-Augmented Generation_: antes de responder, se buscan los fragmentos relevantes de la KB y la IA responde solo con ellos.    |
| **Escalamiento**                    | Pasar una conversación de la IA a una persona, con prioridad y motivo.                                                                 |
| **WebSocket**                       | Conexión que queda abierta para que el servidor envíe eventos al navegador al instante.                                                |
| **WebRTC**                          | Tecnología del navegador para enviar audio directamente entre dos navegadores.                                                         |
| **STUN / TURN**                     | Servidores que ayudan a WebRTC a conectar a través de redes distintas; TURN reenvía el audio cuando la conexión directa no es posible. |
| **STT / TTS**                       | Voz a texto (_speech-to-text_) y texto a voz (_text-to-speech_).                                                                       |
| **MFA / verificación en dos pasos** | Además de la contraseña, un código de 6 dígitos que cambia cada 30 segundos en una aplicación del teléfono (TOTP).                     |
| **Cookie httpOnly**                 | Cookie que el JavaScript de la página no puede leer: protege la sesión si alguien logra inyectar un script (XSS).                      |
| **CSRF**                            | Ataque en el que otro sitio intenta hacer peticiones con tu sesión; se bloquea exigiendo una cabecera que solo la app envía.           |
| **XSS**                             | Inyección de código en la página a través de texto de usuario; la app inserta todo texto como texto, nunca como HTML.                  |
| **Worker / cola**                   | Proceso aparte que ejecuta tareas pendientes (avisos, indexación, purgas) guardadas en una cola de Redis.                              |
| **Pub/sub**                         | Mecanismo de Redis para que un evento publicado llegue a todas las instancias del servidor.                                            |
| **Service Worker**                  | Script del navegador que guarda la aplicación en caché para que cargue sin conexión.                                                   |
| **Web Worker**                      | Hilo aparte del navegador; aquí clasifica la urgencia del texto mientras el cliente escribe.                                           |
| **Prueba de mutación**              | Se rompe el código a propósito y se comprueba que algún test falle; demuestra que los tests protegen algo.                             |
| **E2E**                             | Prueba de punta a punta: un navegador automatizado usa la aplicación completa como lo haría una persona.                               |
| **Readiness (`/ready`)**            | Dirección que responde si el servidor está listo para recibir tráfico (base de datos y Redis disponibles).                             |
| **ADR**                             | _Architecture Decision Record_: documento corto que registra una decisión técnica, sus alternativas y por qué se eligió.               |
