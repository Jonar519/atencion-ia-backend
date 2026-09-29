# 0007 · Un solo motor conversacional para texto y voz

**Contexto.** La Fase 5 agrega voz. Si la voz tuviera su propio flujo, habría dos lugares donde
clasificar, buscar en la KB y decidir escalamientos, y tarde o temprano divergirían.

**Decisión.** `handleCustomerTurn({ conversationId, customerId, content, channel, callId? })` es la
única entrada. El widget la llama con `channel: "text"`; la transcripción de voz la llamará con
`channel: "voice"` y el id de la llamada, una vez por segmento final. El esquema ya lo soporta
(`messages.channel`/`call_id`, con FK compuesta a una llamada de la misma conversación).

- Las llamadas a la IA ocurren fuera de transacciones (pueden tardar segundos); cada escritura es atómica.
- Si la decisión de escalar se conoce por la clasificación, no se gasta una respuesta del modelo.
- Si el proveedor falla o declina, el cliente no queda sin respuesta: se escala.
- El escalamiento es idempotente por diseño (`INSERT … ON CONFLICT DO NOTHING` sobre el índice
  único parcial), así que turnos simultáneos —texto y voz a la vez, por ejemplo— no lo duplican.

**Evidencia.** `engine.test.ts` ejecuta un turno de voz por la misma función y verifica que queda
asociado a su llamada; 5 turnos de fraude simultáneos producen 1 escalamiento y 1 aviso.
