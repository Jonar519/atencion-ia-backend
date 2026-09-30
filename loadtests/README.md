# Pruebas de carga (autocannon)

Los resultados y su interpretación están en [`docs/load-test-report.md`](../docs/load-test-report.md).
Los JSON de cada corrida quedan en `loadtests/results/`.

> Usa SIEMPRE una base aparte (por ejemplo `atencion_ia_load`) y otra base lógica de Redis (`/2`):
> `setup.mjs` crea clientes y agentes sintéticos, y las ráfagas llenan la cola. **Nunca la base de
> desarrollo.**

## 1. Base de carga (cmd.exe, desde `atencion-ia-database`)

```bat
docker exec atencion_ia_postgres createdb -U postgres atencion_ia_load
set DB_NAME=atencion_ia_load
scripts\migrate.bat
scripts\seed.bat
set DB_NAME=
```

El `createdb` solo hace falta la primera vez. Luego indexa la KB del seed, desde
`atencion-ia-backend`:

```bat
set DATABASE_URL=postgresql://postgres:postgres@localhost:5434/atencion_ia_load
set REDIS_URL=redis://localhost:6380/2
npm run kb:reindex
```

## 2. API y worker de carga (dos ventanas de cmd, desde `atencion-ia-backend`)

**Ventana 1: API** en el puerto 4300, con IA simulada, límites ×1000 y secretos solo de prueba.

```bat
npm run build
set JWT_SECRET=secreto-solo-para-pruebas-de-carga-0123456789
set IP_HASH_SECRET=otro-secreto-solo-para-pruebas-de-carga-98765
set DATABASE_URL=postgresql://postgres:postgres@localhost:5434/atencion_ia_load
set REDIS_URL=redis://localhost:6380/2
set PORT=4300
set LOG_LEVEL=warn
set RATE_LIMIT_SCALE=1000
set AI_DAILY_TOKEN_BUDGET_PER_CUSTOMER=1000000000
set AI_MOCK_LATENCY_MS=300
set CORS_ORIGIN=http://localhost:5174
node dist\server.js
```

**Ventana 2: worker.** Usa las mismas variables, sin `PORT`:

```bat
set WORKER_METRICS_PORT=9467
node dist\workers\worker.js
```

- `AI_MOCK_LATENCY_MS=300` simula la latencia de cada llamada al proveedor. Con `0` se mide el
  costo propio del sistema.
- `mock` y `RATE_LIMIT_SCALE` están prohibidos con `NODE_ENV=production`: la API no arranca.

## 3. Datos sintéticos (tercera ventana)

```bat
set LOADTEST_API_URL=http://localhost:4300
npm run loadtest:setup
```

Crea 100 clientes con su conversación, 200 más reservados para la ráfaga y 20 agentes sintéticos.
Todo se guarda en `loadtests\.state.json` (ignorado por git). **Antes de cada ráfaga** vuelve a
correrlo: una conversación que ya escaló no vuelve a escalar.

## 4. Escenarios

```bat
set LOADTEST_AI_MOCK_LATENCY_MS=300
npm run loadtest:messages
```

```bat
set LOADTEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5434/atencion_ia_load
npm run loadtest:escalations
```

| Variable                                                   | Por defecto             | Para qué                                                             |
| ---------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------- |
| `LOADTEST_API_URL`                                         | `http://localhost:4300` | API bajo prueba                                                      |
| `LOADTEST_DURATION`                                        | `20`                    | Segundos por escenario                                               |
| `LOADTEST_CONNECTIONS`                                     | `50`                    | Clientes simultáneos en `messages`                                   |
| `LOADTEST_AI_MOCK_LATENCY_MS`                              | —                       | Solo **etiqueta** el resultado: debe coincidir con la de la API      |
| `LOADTEST_LABEL`                                           | —                       | Sufijo del archivo de resultados (por ejemplo `despues-1`)           |
| `LOADTEST_SESSIONS` / `LOADTEST_BURST` / `LOADTEST_AGENTS` | `100` / `200` / `20`    | Tamaños de `setup`                                                   |
| `LOADTEST_RACE`                                            | `30`                    | Turnos simultáneos en UNA conversación                               |
| `LOADTEST_DATABASE_URL`                                    | —                       | Para verificar en la base que no hay escalamientos duplicados        |
| `LOADTEST_ORIGIN`                                          | `http://localhost:5174` | Origin de los WebSocket de los agentes (debe estar en `CORS_ORIGIN`) |
