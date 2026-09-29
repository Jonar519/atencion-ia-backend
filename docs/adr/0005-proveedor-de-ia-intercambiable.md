# 0005 · Proveedor de IA intercambiable, con mock por defecto

**Contexto.** El chat, la clasificación y los embeddings cuestan dinero por llamada. No hay API keys
hasta el cierre del curso, y los tests, la CI y las pruebas de carga no deben gastar ni depender de la red.

**Decisión.**

- Tres interfaces (`ChatProvider`, `ClassifierProvider`, `EmbeddingProvider`, en
  `src/services/ai/types.ts`); el motor solo conoce esas interfaces. `AI_PROVIDER` elige la implementación.
- `mock` (por defecto): determinista y sin red. Embeddings por _feature hashing_ (el RAG funciona de
  verdad con vocabulario común), clasificación por reglas, respuesta armada **solo** con texto de la KB.
  Prohibido con `NODE_ENV=production` (el proceso no arranca).
- `anthropic`: Claude para respuesta y clasificación + Voyage AI para embeddings (mismos proveedores
  del Proyecto 1). Según la guía vigente de la API:
  - modelo `claude-opus-5-5` (configurable); el razonamiento no se puede apagar en ese modelo, se
    controla con `output_config.effort`: `low` para clasificar, `medium` para responder;
  - `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`): si un clasificador de seguridad
    declina, la API reintenta en el modelo recomendado; si igual termina en `refusal`, el motor escala;
  - clasificación con salida estructurada (JSON schema) **y** validación zod (nunca se confía en la salida);
  - prompt de sistema estable con `cache_control`, timeout por llamada, 2 reintentos del SDK.
  - Voyage `voyage-3.5` con `input_type` document/query y `output_dimension: 1024` verificado.
- Toda llamada queda medida (latencia, resultado, tokens) y registrada en `ai_usage` por cliente.

**Alternativas.** Llamar al SDK directamente desde el motor (acopla y obliga a tener keys para
probar); un mock "tonto" que devuelva siempre lo mismo (no prueba el RAG ni las reglas).

**Consecuencias / honestidad.** Los adaptadores reales están probados con un cliente y un `fetch`
simulados (forma exacta de cada petición y manejo de cada respuesta), **no contra el proveedor real**:
calidad de respuestas, latencia y costo reales quedan **no medidos** hasta el cierre del curso
(procedimiento en `docs/rag.md`).
