# Informe de pruebas de carga

Todos los números salen de corridas ejecutadas el **2026-09-30** con los scripts de `loadtests/`.
Los JSON crudos están en `loadtests/results/`: una respuesta es una muestra, y los percentiles
son exactos, calculados por _nearest-rank_. Lo que no se midió se dice explícitamente.

## Máquina y entorno

|                    |                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| CPU                | AMD Ryzen 9 7900 (12 núcleos, 24 hilos)                                                                                                    |
| RAM                | 31,1 GB                                                                                                                                    |
| SO                 | Windows 11 Pro (10.0.26200)                                                                                                                |
| Node               | v24.13.1                                                                                                                                   |
| PostgreSQL         | 16.15 + pgvector 0.8.6 (imagen `pgvector/pgvector:pg16`) en Docker Desktop 29.7.2                                                          |
| Redis              | 7.4.11 en Docker Desktop                                                                                                                   |
| API y worker       | build compilado (`node dist/...`), **un solo proceso** cada uno, `LOG_LEVEL=warn`, worker con concurrencia 2                               |
| IA                 | `AI_PROVIDER=mock`, con `AI_MOCK_LATENCY_MS` = **0** (costo propio del sistema) o **300** (latencia **simulada** por llamada al proveedor) |
| Generador de carga | autocannon 8 en la **misma máquina** (compite por CPU con la API)                                                                          |
| Base               | `atencion_ia_load`: aparte (nunca la de desarrollo), con migraciones, seed y la KB indexada. Redis en la base lógica 2                     |
| Límites            | `RATE_LIMIT_SCALE=1000` y tope diario de tokens por cliente elevado. Se prueba el sistema, no los límites (que tienen sus propios tests)   |

Cada escenario de duración fija corrió **20 s**. La comparación antes/después se hizo con **las dos
versiones compiladas**, la anterior en un worktree aparte, **alternando** corridas (antes, después,
antes, después…). Así las dos ven la misma máquina y la misma base, que crece con cada corrida.

## Escenarios

1. **Envío masivo de mensajes** (`loadtests/messages.mjs`). 50 clientes distintos, cada uno con su
   sesión del widget y su conversación, envían sin pausa preguntas que la KB responde. Cada
   solicitud recorre el motor completo:
   - clasificación;
   - embedding de la pregunta;
   - búsqueda vectorial en pgvector;
   - respuesta;
   - escrituras en la base;
   - eventos de tiempo real.

   No escalan: la conversación sigue con la IA.

2. **Ráfaga de escalamientos** (`loadtests/escalations.mjs`). 20 agentes conectados al WebSocket
   (como el panel) y **199 clientes que reportan un posible fraude al mismo tiempo**. Se mide:
   - la latencia HTTP;
   - lo que tarda en llegarle a **cada** agente el aviso de que el caso entró a la cola: lo
     publica la API al confirmar el turno;
   - lo que tarda el aviso del worker (`escalation.created`), que pasa por BullMQ;
   - si se pierde o se repite algún aviso.

   Además hay una **carrera**: 30 turnos de fraude simultáneos **en la misma conversación**. Al
   final se verifica en la base: un escalamiento por conversación y ninguno duplicado.

## Resultados

### 1. Envío masivo de mensajes (50 conexiones, 3 corridas por versión)

| Latencia simulada de la IA | Versión     |      Throughput (3 corridas) |            p50 |            p95 |          p99 | Errores |
| -------------------------- | ----------- | ---------------------------: | -------------: | -------------: | -----------: | ------: |
| **300 ms**                 | antes       |     46,1 · 44,7 · 44,6 req/s |   1048–1055 ms |   1168–1193 ms | 1255–1309 ms |     0 % |
| **300 ms**                 | **después** | **67,1 · 67,0 · 65,8 req/s** | **730–735 ms** | **772–775 ms** |   939–957 ms |     0 % |
| 0 ms                       | antes       |  200,3 · 181,4 · 168,6 req/s |     244–289 ms |     283–343 ms |   358–419 ms |     0 % |
| 0 ms                       | después     |  200,0 · 188,3 · 173,1 req/s |     245–281 ms |     278–332 ms |   350–395 ms |     0 % |

**Con una IA realista (300 ms por llamada), cada turno pasó de ~1050 a ~732 ms (−30 %) y el
throughput subió de ~45 a ~67 req/s (+48 %)**, sin errores, de forma consistente en las tres
corridas. Sin latencia de IA (0 ms), las dos versiones son **equivalentes**: +0 a +4 %, dentro del
ruido entre corridas.

### 2. Ráfaga de 199 escalamientos con 20 agentes conectados (2 corridas por versión)

|                                                                 |                antes #1 |       antes #2 |     después #1 |     después #2 |
| --------------------------------------------------------------- | ----------------------: | -------------: | -------------: | -------------: |
| Toda la ráfaga respondida (HTTP)                                |                 1448 ms |        1532 ms |        1411 ms |        1410 ms |
| Latencia HTTP de cada turno, p50 / p95                          |          1252 / 1426 ms | 1402 / 1513 ms | 1244 / 1384 ms | 1274 / 1384 ms |
| Aviso "caso en cola" a CADA agente, p50 / p95                   |          1332 / 1413 ms | 1415 / 1502 ms | 1230 / 1385 ms | 1286 / 1375 ms |
| Aviso del worker (`escalation.created`), p50 / p95              |            595 / 753 ms |   628 / 857 ms |  708 / 1000 ms |   680 / 901 ms |
| Avisos recibidos por el agente que menos recibió (de 199 / 200) |               199 / 200 |      199 / 200 |      199 / 200 |      199 / 200 |
| Avisos **duplicados**                                           |                       0 |              0 |              0 |              0 |
| Carrera: 30 turnos simultáneos en UNA conversación              | 1 escalamiento, 1 aviso |          1 y 1 |          1 y 1 |          1 y 1 |
| Base: conversaciones sin escalamiento / con más de uno          |                   0 / 0 |          0 / 0 |          0 / 0 |          0 / 0 |

En los cuatro casos, **cada uno de los 20 agentes recibió todos los avisos**, en unos 1,4 s como
máximo para toda la ráfaga, **sin un solo duplicado**. La garantía de "un escalamiento abierto por
conversación" (índice único parcial + `ON CONFLICT DO NOTHING`) aguantó 30 turnos simultáneos en la
misma conversación.

**Dato curioso, explicado:** el aviso del **worker** llega **antes** que el que publica la propia
API. La API publica "caso en cola" al terminar el turno, y en una ráfaga su hilo principal está
ocupado con los 199 turnos. El worker, en otro proceso, recoge el trabajo de la cola apenas se
encola. El panel reacciona a los dos (recarga la cola), así que el asesor ve el caso con el primero
que llegue.

## Diagnóstico: dónde se va el tiempo

### Con IA realista: la espera del proveedor, y era evitable en parte

Con 300 ms por llamada, el throughput crecía **lineal** con las conexiones (sondeo exploratorio:
47 req/s con 50 conexiones y 95 con 100). No era un límite de CPU: cada turno **esperaba**. Un
turno hacía **tres llamadas al proveedor en serie**:

1. clasificar (intención y sentimiento);
2. embedding de la pregunta para buscar en la KB;
3. respuesta.

Mínimo 900 ms. Pero **clasificar y buscar en la KB son independientes**: la búsqueda solo necesita
el texto del cliente.

**Arreglo** (`src/modules/engine/conversationEngine.ts`): las dos corren **en paralelo** con
`Promise.allSettled`. Una falla de cualquiera se maneja igual que antes. Resultado medido arriba:
−30 % de latencia por turno y +48 % de throughput.

**Costo del arreglo:** si el turno termina escalando (por ejemplo, un fraude), la búsqueda en la
KB se hace igual y se "desperdicia". Es un embedding, lo barato. La respuesta del modelo, lo caro,
sigue sin gastarse.

- El test `engine.test.ts` ("posible fraude… NO gasta una respuesta del modelo") lo refleja:
  `classification` + `embedding`, sin `chat`.
- Otro test prueba que las dos llamadas **empiezan antes de que termine cualquiera**.
- La mutación 39 las vuelve a poner en serie y ese test falla.

### Sin latencia de IA: CPU del hilo principal de Node, dominado por Prisma

Con 0 ms de IA el throughput se aplanaba en ~200–250 req/s. Sondeo exploratorio, con la versión
anterior:

| Conexiones | Throughput |    p50 |
| ---------: | ---------: | -----: |
|          1 |   32 req/s |  30 ms |
|         10 |  217 req/s |  45 ms |
|         50 |  245 req/s | 197 ms |

Durante la carga el proceso de la API usaba ~3,7 núcleos y PostgreSQL ~3,6, de 24. El motor de
consultas de Prisma corre en hilos propios. Ninguno estaba saturado como proceso.

Un **perfil de CPU** real, tomado por el inspector durante 10 s con 50 conexiones, mostró el hilo
principal **sin tiempo libre** (3,5 % idle) y:

- **48 %** en el cliente de Prisma, serializando consultas y leyendo respuestas;
- 6,5 % más en `writeUtf8String`, que envía el JSON de cada consulta al motor.

Con `log_statement` sobre la base de carga, un turno ejecutaba **23 sentencias SQL**. Tres grupos
eran evitables:

- un SELECT extra tras cada INSERT para traer la relación `senderAgent`, que en los mensajes del
  motor siempre es `null`;
- releer la conversación dos veces y los mensajes recién creados para publicarlos por tiempo
  real;
- una transacción aparte para `ai_usage`.

**Arreglo:** esos mensajes se crean sin la relación, `ai_usage` entra en la transacción de la
respuesta, y los eventos se publican con lo que el motor ya tiene en memoria, con **una** sola
lectura del estado final. Resultado: **18 sentencias por turno**.

**Resultado honesto:** esa reducción **no movió el throughput de forma medible** con 0 ms (tabla de
arriba). La hipótesis era que la sobrecarga de Prisma escalaba con el número de consultas. El
perfil lo sugería, pero las cinco sentencias quitadas eran de las baratas: BEGIN/COMMIT y lecturas
por clave primaria. El costo dominante está en las que quedan: INSERT de mensajes y citas,
búsqueda vectorial e historial. **No se hicieron más cambios en ese frente.** Pasar las rutas
calientes a SQL crudo o a varios procesos (cluster) lo mejoraría, pero con un proveedor de IA real
el cuello de botella es su latencia, no esto.

### Degradación entre corridas (y por qué no es un problema en producción)

Las dos versiones pierden throughput de una corrida a la siguiente con 0 ms (200 → 169 req/s). La
base crece: cada cliente sintético hace cientos de turnos. El chequeo del **tope diario de tokens**
(`tokensUsedLast24h`) suma las filas de `ai_usage` del cliente en 24 h: el más activo llegó a
**2232 filas**, unos 20 ms la consulta con la caché fría.

En producción esa suma está **acotada por el propio tope**. Con 60 000 tokens/día y un promedio
medido de 259 tokens por fila, un cliente no puede pasar de ~230 filas diarias, antes de que el tope
lo corte. En la prueba de carga el tope se elevó a propósito, y por eso crece sin límite.

## Qué NO se midió

- **Proveedores reales** (Anthropic, Voyage, Deepgram): sus latencias reales, sus límites de tasa
  y sus errores. Con ellos el turno tardará más que con 300 ms simulados.
- **Voz bajo carga**: muchas llamadas simultáneas con audio a tiempo real (STT en streaming, TTS,
  señalización). Solo se probó una llamada a la vez (tests, E2E y prueba manual).
- **Varias instancias** de la API detrás de un balanceador. El diseño lo soporta: los eventos y la
  señalización viajan por Redis, y hay un test con dos instancias. No se midió su throughput.
- **Red real**: todo corrió en la misma máquina (sin latencia de red, y el generador de carga
  compitiendo por CPU).
- **Carga sostenida** de horas (fugas de memoria, crecimiento de Redis): las corridas duran 20 s.

Cómo repetir todo: [`loadtests/README.md`](../loadtests/README.md).
