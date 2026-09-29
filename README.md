# atencion-ia-backend

API REST, WebSocket (mensajería en tiempo real y señalización WebRTC) y workers de IA de
**Atención al cliente omnicanal con IA**: un cliente escribe o llama desde el navegador,
una IA con RAG sobre la base de conocimiento de la empresa responde, y cuando no puede
resolver (fraude, cliente molesto, pide un humano…) la conversación se escala a un agente.

## Stack

Node.js + TypeScript + Express · Prisma (solo como cliente) · PostgreSQL + pgvector ·
BullMQ + Redis (colas, rate limiting, pub/sub de señalización) · zod · pino ·
prom-client · Vitest.

Proveedores intercambiables por variable de entorno, con modo `mock` por defecto (sin
costo ni credenciales, usado en desarrollo y CI):
- `AI_PROVIDER`: chat, clasificación de intención y embeddings.
- `VOICE_PROVIDER`: transcripción (STT) y síntesis (TTS).

## Relación con los otros repositorios

| Repositorio | Relación |
|---|---|
| `atencion-ia-database` | Dueño del esquema. Este repo lo **introspecciona** (`npx prisma db pull`); nunca crea ni altera tablas. Los tests de integración aplican sus migraciones desde `../atencion-ia-database/migrations`. |
| `atencion-ia-frontend` | Cliente de esta API (widget de cliente y panel de agente). Sesión de staff: access token corto en memoria + refresh token rotativo en cookie httpOnly. |

## Estado

**Fase 0**: repositorio inicializado. El código llega en la Fase 2 (identidad,
autorización, observabilidad), la Fase 3 (IA) y la Fase 5 (voz), con las instrucciones
de arranque en cmd.exe en este README.
