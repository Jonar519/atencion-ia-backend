# RAG, motor conversacional y escalamiento (Fase 3)

## Flujo de un turno

```
cliente (widget texto · Fase 5: voz transcrita)
   │  POST /api/widget/conversations/:id/messages        ← rate limit por sesión (12/min)
   ▼
handleCustomerTurn()  src/modules/engine/conversationEngine.ts   ← MISMA función para texto y voz
   1. dueño de la conversación (404 si no es suya) · idempotencia por clientMsgId
   2. tope diario de tokens del cliente (429)
   3. clasificación: intención + sentimiento + confianza → se guarda CON el mensaje
   4. reglas de escalamiento previas (fraude, pide humano, enojo… → no se gasta una respuesta)
   5. si la atiende la IA: RAG (solo KB publicada, versión vigente) + historial de ESTA conversación → respuesta
   6. reglas de escalamiento con el resultado (sin apoyo en la KB, fallo del proveedor)
   7. escalamiento: INSERT … ON CONFLICT DO NOTHING (uno abierto por conversación, lo garantiza la base)
      → conversación a waiting_agent, prioridad = máx(actual, nueva) → cola escalation-notify
   8. consumo (ai_usage) por operación
   ▼
worker (npm run worker)
   escalation-notify → elige candidatos (disponibles y con cupo) → Redis pub/sub "atencion-ia:staff-events"
   kb-indexing       → fragmenta + embeddings → kb_chunks (reemplazo atómico, descarta si el artículo cambió)
```

## Reglas de escalamiento

Función pura `decideEscalation()` (`src/modules/engine/escalationRules.ts`), probada regla por regla.
Gana la primera que aplica:

| #   | Condición                                                                  | Motivo             | Prioridad | Origen             |
| --- | -------------------------------------------------------------------------- | ------------------ | --------- | ------------------ |
| 1   | Intención `possible_fraud` con confianza ≥ 0.6                             | `possible_fraud`   | 90        | `ai_signal`        |
| 2   | Intención `human_request` (con cualquier confianza: se respeta al cliente) | `human_requested`  | 60        | `customer_request` |
| 3   | Sentimiento `angry` con confianza ≥ 0.6                                    | `angry_customer`   | 70        | `ai_signal`        |
| 4   | Dos reclamos seguidos (uno aislado no escala: la IA orienta)               | `complaint`        | 55        | `rule`             |
| 5   | Misma intención (no general) tres turnos seguidos                          | `repeated_failure` | 50        | `rule`             |
| 6   | Sin apoyo en la KB dos respuestas seguidas                                 | `low_confidence`   | 40        | `rule`             |
| 7   | El proveedor de IA falló o declinó (`refusal`)                             | `low_confidence`   | 45        | `rule`             |

Al escalar desde la IA, el cliente recibe un mensaje de traspaso **de plantilla** (sin LLM: no puede
prometer nada indebido). En fraude incluye la instrucción de bloquear la tarjeta y "nunca te pediremos tu clave".
La evidencia (`escalations.signal`) guarda señales y la regla, **nunca el texto del cliente**.

## Aislamiento del RAG (defensa en profundidad)

Lo que escribe un cliente no puede llegar, por ninguna vía, al contexto con el que la IA responde a otro.

| Vía              | Cierre                                                                                                                                                                                                                                       | Prueba                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Índice del RAG   | `kb_chunks` solo tiene texto de artículos. **La base lo garantiza**: trigger `kb_chunks_check_provenance` (migración 013) rechaza todo fragmento que no sea subcadena literal del cuerpo vigente de su artículo, o cuyo hash no corresponda. | `atencion-ia-database/tests/002_rag_provenance.sql`, `ragIsolation.test.ts`                                                    |
| Búsqueda         | `searchChunks()` solo recibe un vector; filtra `status = 'published'` y `article_version = version` vigente                                                                                                                                  | `ragIsolation.test.ts` (borrador, archivado, versión vieja)                                                                    |
| Historial        | `loadHistory()` es la única lectura de mensajes para el prompt y filtra por `conversationId`                                                                                                                                                 | `ragIsolation.test.ts`: un "secreto" de la conversación A nunca llega al modelo cuando responde a B (espía sobre el proveedor) |
| API del widget   | Cada consulta filtra por el cliente de la sesión; ajeno = 404                                                                                                                                                                                | `ragIsolation.test.ts`, `widget.test.ts`                                                                                       |
| Prompt injection | Todo texto externo va etiquetado como dato; se neutralizan nuestras etiquetas dentro de él; la clasificación del modelo se valida con zod                                                                                                    | `untrusted.test.ts`, `anthropicProvider.test.ts`                                                                               |

### Pruebas de mutación (reglas rotas a propósito)

`npm run test:mutations` rompe cada regla crítica en el código, corre los tests y exige que fallen;
restaura siempre el archivo. Resultado medido en la Fase 3: **13/13 detectadas**.

| #   | Mutación                                                | Detectada por                         |
| --- | ------------------------------------------------------- | ------------------------------------- |
| 1   | El historial deja de filtrar por conversación           | 1 test (el "secreto" llega al modelo) |
| 2   | La búsqueda deja de filtrar artículos publicados        | 1 test                                |
| 3   | La búsqueda usa fragmentos de versiones viejas          | 1 test                                |
| 4   | El widget no verifica el dueño al leer                  | 1 test                                |
| 5   | El motor no verifica el dueño al escribir               | 1 test                                |
| 6   | Sin neutralización de etiquetas                         | 6 tests                               |
| 7   | Escalamiento sin `ON CONFLICT`                          | 2 tests                               |
| 8   | La regla de fraude deja de escalar                      | 6 tests                               |
| 9   | Un reclamo aislado escala                               | 1 test                                |
| 10  | Sin tope diario de tokens                               | 1 test                                |
| 11  | Se lee la respuesta de Claude sin revisar `stop_reason` | 1 test                                |
| 12  | La clasificación del modelo se acepta sin validar       | 3 tests                               |
| 13  | Se acepta texto mal codificado (U+FFFD)                 | 1 test                                |

Además, en la base: quitar el trigger 013 dentro de la transacción del test hace fallar
`002_rag_provenance.sql`, y omitir la migración 013 hace fallar el test del backend que la verifica.

## Calibración del RAG (medida con el proveedor mock)

`npm run rag:calibrate` sobre la KB del seed, `AI_PROVIDER=mock`, `RAG_MIN_SCORE=0.2`:

| Resultado                                                                   | Valor                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mejor fragmento del artículo correcto                                       | **7/9** preguntas relevantes                                                                                                                                                  |
| Preguntas bien clasificadas con el umbral (relevantes arriba, ajenas abajo) | **11/14**                                                                                                                                                                     |
| Errores                                                                     | "cobro que no hice" → artículo de bloqueo (0.305 vs 0.290); "viaje a Chile" → bloqueo; "crédito hipotecario para **comprar** casa" pasa el umbral (0.336) por la raíz "compr" |

Esto es lo esperable: los embeddings del mock son un _bag of words_ con hashing, **no entienden
significado**. El mock existe para probar el flujo de forma determinista, no la calidad semántica.

**No medido:** la calidad con Voyage y el umbral correcto para Voyage (0.45 por defecto es una
estimación sin calibrar). Al tener la API key:

```bat
set AI_PROVIDER=anthropic
npm run kb:reindex
npm run rag:calibrate
```

y ajustar `RAG_MIN_SCORE` en `.env` según el reporte.

## Costo y abuso

- Rate limit por sesión del widget (12 mensajes/min) y por IP para crear sesiones (20/h).
- Tope diario de tokens por cliente (`AI_DAILY_TOKEN_BUDGET_PER_CUSTOMER`, 60 000 por defecto), medido
  con el consumo real de `ai_usage` (clasificación + embeddings + respuesta). Excedido → 429 antes de gastar.
- Máximo 3 conversaciones abiertas por cliente (no se multiplica el cupo).
- Si la decisión de escalar ya se conoce por la clasificación, no se genera respuesta con el modelo.

## Pasar al proveedor real (cierre del curso)

1. En `.env`: `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`.
2. `npm run kb:reindex` (los vectores del mock no sirven para Voyage).
3. `npm run rag:calibrate` y ajustar `RAG_MIN_SCORE`.
4. Revisar en `/metrics` `atencion_ia_ai_request_duration_seconds` y `atencion_ia_ai_tokens_total`
   (latencia y costo reales: **no medidos todavía**).
