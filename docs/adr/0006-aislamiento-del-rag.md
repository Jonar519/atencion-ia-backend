# 0006 · Aislamiento del RAG garantizado por la base, no solo por el código

**Contexto.** El riesgo más grave de un chatbot con RAG en un banco: que el texto de un cliente
(su número de cuenta, su reclamo) aparezca como "contexto" en la respuesta a otro cliente. Si la única
defensa es "el código nunca indexa mensajes de clientes", basta un bug o un cambio descuidado.

**Decisión.** Tres capas independientes:

1. **Base de datos** (migración 013): un trigger rechaza cualquier fila de `kb_chunks` que no sea una
   subcadena literal del cuerpo vigente de su artículo (con hash verificado). El índice del RAG
   físicamente no puede contener otra cosa.
2. **Búsqueda**: solo recibe un vector; filtra artículos publicados y la versión vigente.
3. **Historial**: una única función lo carga, siempre filtrando por la conversación.

Para que la capa 1 sea posible, el indexador corta los artículos **por posiciones** (los fragmentos
son subcadenas exactas); el título se agrega solo al texto que va al modelo de embeddings.

**Evidencia.** Tests que siembran un "secreto" en una conversación y verifican con un espía que nunca
llega al modelo al responder otra; pruebas de mutación que rompen cada capa y son detectadas
(`docs/rag.md`, 13/13 más el trigger).

**Consecuencias.** Un fragmento "enriquecido" (resumido o reescrito) no puede guardarse en
`kb_chunks`; si algún día se quiere, requiere una columna aparte y una migración que revise esta regla.
