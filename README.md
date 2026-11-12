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
