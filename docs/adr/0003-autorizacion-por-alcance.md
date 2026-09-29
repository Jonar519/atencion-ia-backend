# 0003 · Autorización por dueño con un único "alcance"

**Contexto.** Un agente solo debe ver sus conversaciones y la cola general (para leer
el historial antes de tomar un caso). Si cada endpoint escribiera su propio `WHERE`, el
día que alguien olvide uno se filtran datos de un cliente a otro agente.

**Decisión.**

- Un único archivo decide la visibilidad: `src/modules/conversations/conversations.access.ts`.
  - `conversationScope(user)`: filtro Prisma que se añade a TODA consulta de conversaciones.
  - `canViewConversation(user, fila)`: la misma regla como predicado.
  - `canReply` / `canClose`: quién escribe o cierra (el asignado; el admin también debe
    tomar la conversación antes de responder, para que haya un solo responsable).
- Lo que no se puede ver responde **404**, no 403: no se confirma que existe.
- **Tomar** una conversación es atómico: `UPDATE … WHERE status = 'waiting_agent' AND
assigned_agent_id IS NULL`. Dos agentes a la vez: uno gana y el otro recibe 409. La fila
  del agente se bloquea (`FOR UPDATE`) para que una ráfaga de "tomar" no supere su
  `max_concurrent`.

**Alternativas.** Row Level Security de Postgres: más robusta, pero exige pasar el
usuario a cada conexión del pool de Prisma (`SET LOCAL` por transacción) y complica los
workers. Se reevalúa para producción.

**Excepción documentada.** Si un agente intenta tomar una conversación que otro acaba
de tomar, recibe 409 ("otro agente ya la tomó") y no 404: la vio en la cola segundos
antes, así que no se le revela nada nuevo, y un 404 sería confuso.

**Evidencia.**

- `tests/integration/authorization.test.ts` compara filtro y predicado contra la base
  en todas las combinaciones estado × asignación.
- Prueba de mutación hecha en la Fase 2: al romper a propósito `conversationScope` (un
  agente ve todo), fallaron 4 tests. Se restauró y volvieron a pasar.
- Carreras: "dos agentes toman a la vez" y "ráfaga de 4 con máximo 2" en
  `tests/integration/conversations.test.ts`.
