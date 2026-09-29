# 0008 · WebSocket de tiempo real solo de recepción, con destinatarios decididos por una función pura

**Contexto.** La Fase 4 necesita que cliente y agente vean los mensajes sin recargar, y que la cola
del panel se actualice cuando entra, se toma o se cierra un caso. El envío de mensajes ya existe
por REST, con validación zod, idempotencia por `clientMsgId`, rate limit, tope diario de tokens y
verificación de dueño. El riesgo principal de un WebSocket es **filtrar** eventos: que un cliente
reciba mensajes de otra conversación, o un agente casos que no puede ver.

**Decisión.**

- `/ws` en el mismo puerto que la API, **solo para recibir**. Enviar sigue siendo por REST: no hay
  una segunda puerta de entrada con reglas duplicadas.
- Autenticación en el **primer mensaje** (access token del staff, o la cookie httpOnly del widget
  capturada en el upgrade), nunca en la URL (quedaría en logs). Se valida el `Origin` contra
  `CORS_ORIGIN`, porque el navegador envía la cookie del widget solo.
- Los servicios publican en Redis (`atencion-ia:realtime`) **después del commit**; cada instancia
  de la API reparte a sus sockets. Así el worker (escalamientos) y varias instancias funcionan igual.
- **Qué recibe cada socket lo decide `audienceFor(event, identity)`**, una función pura: el
  cliente solo lo de sus conversaciones y sin el análisis de la IA; el staff, según
  `canViewConversation` (la misma regla de la API REST, [ADR 0003](0003-autorizacion-por-alcance.md)).
  Si un caso deja de ser visible para un agente, recibe `conversation.updated` con `visible: false`.
- El socket se cierra cuando vence el token o la sesión (4409); el cliente renueva y reconecta.
- **Sin reenvío**: lo publicado mientras un cliente estaba desconectado se recupera por REST al
  reconectar (el frontend lo hace siempre).

**Alternativas consideradas.**

- _Enviar mensajes también por el socket_: duplicaría validación, idempotencia y límites.
- _Socket.IO_: salas y reconexión listas, pero otro protocolo que el frontend sin framework tendría
  que cargar; `ws` + un cliente de ~150 líneas alcanza.
- _Token en la query string_: más simple, pero queda en logs de proxies y del servidor.
- _Historial de eventos en Redis Streams para reenviar lo perdido_: más complejo; el REST ya es la
  fuente de verdad y el resync es una sola petición.

**Consecuencias.** Un evento nunca llega a quien no podría leerlo por REST. A cambio, al reconectar
siempre hay una petición extra de historial. Si Redis cae, la API sigue funcionando pero sin tiempo
real hasta que vuelva.

**Evidencia.** `tests/unit/audience.test.ts` (reglas de destinatario) y
`tests/integration/websocket.test.ts` (sockets reales: Origin, autenticación, aislamiento entre
clientes y entre agentes, recorte del análisis de IA, cierre al vencer). Mutaciones 14–20 de
`npm run test:mutations`. Prueba en vivo con dos pestañas y resync tras caída de la API:
`atencion-ia-frontend/docs/fase4-verificacion.md`.
