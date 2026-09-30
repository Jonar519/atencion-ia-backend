# 0010 · Voz: audio al STT por WebSocket propio, WebRTC solo entre personas, un solo motor

**Contexto.** La Fase 5 agrega llamadas de voz desde el navegador. Hay dos flujos de audio
distintos:

1. **Cliente ↔ IA**: el audio del cliente tiene que llegar al STT, y la respuesta de la IA vuelve
   como audio (TTS).
2. **Cliente ↔ agente**: cuando un humano se une, las dos personas hablan entre sí.

El enunciado pide señalización WebRTC sobre el mismo backend (WebSocket + Redis pub/sub) y que la
transcripción alimente la misma función conversacional de la Fase 3.

**Decisión.**

- **WebSocket de voz aparte (`/ws/voice`)**, no el de eventos: `/ws` solo recibe
  ([ADR 0008](0008-tiempo-real-solo-recepcion.md)). Este sí recibe audio y señalización, con sus
  propios límites:
  - tramas binarias PCM16 mono 16 kHz de hasta 16 KB;
  - caudal de audio de hasta 1,25× tiempo real;
  - mensajes JSON validados con zod.
- **El audio para la IA NO va por WebRTC.** Viaja del navegador al backend por ese WebSocket y del
  backend al STT del proveedor. Un servidor WebRTC (un SFU o un peer en Node) agregaría una
  dependencia nativa pesada y un servicio más que operar, y el STT en streaming igual se consume
  por WebSocket.
- **WebRTC solo entre cliente y agente**, de navegador a navegador. El audio entre personas nunca
  pasa por nuestro servidor. El backend **relea** la señalización (oferta, respuesta y candidatos
  ICE, validados con zod):
  - siempre al **otro** participante de **esa** llamada (el cliente no elige destinatario);
  - por Redis pub/sub (`atencion-ia:voice`), así funciona aunque cliente y agente estén en
    instancias distintas.

  El agente también envía su audio al STT por su propio `/ws/voice`, para que su parte quede
  transcrita.

- **Un solo motor.** Cada segmento final del STT llama a `handleCustomerTurn` con
  `channel: "voice"` ([ADR 0007](0007-motor-conversacional-independiente-del-canal.md)). RAG,
  intención, topes y escalamiento son los mismos que en el texto. Lo único propio de la voz
  (`voicePipeline.ts`) es:
  - guardar el segmento de transcripción;
  - sintetizar la respuesta;
  - pasar la llamada a `waiting_agent` si el motor escaló.
- **Estados de la llamada**: `connecting → in_progress ⇄ waiting_agent → ended | failed`. Todas
  las transiciones son `UPDATE … WHERE status IN (…)`, así que son idempotentes ante carreras, y
  cada una se publica como `call.updated`.
- **Unirse = tomar el caso.** Si la llamada está en la cola, `POST /api/calls/:id/join` usa la
  misma toma atómica del panel (`conversationsService.take`: un solo ganador, respeta
  `max_concurrent`) y registra la participación. El socket de voz del agente exige esa
  participación **y** que el caso sea suyo.
- **Una conexión por rol y llamada ("la más nueva gana")**, también entre instancias, mediante
  mensajes de presencia en el bus. Así no quedan dos micrófonos transcribiendo lo mismo.
- **Robustez:**
  - gracia de reconexión: un corte breve no cuelga la llamada;
  - la duración máxima la controla la instancia que tiene al cliente;
  - un **barrido** del worker (cada minuto) cierra las llamadas que ninguna instancia puede cerrar
    porque la que las atendía se cayó.

**Alternativas consideradas.**

- _Audio a un SFU (mediasoup/LiveKit) que alimente el STT_: es lo correcto para audio de calidad
  telefónica y muchos participantes, pero aquí es desproporcionado: otro servicio que operar, y
  este proyecto no tiene despliegue.
- _Peer WebRTC en Node (wrtc/werift)_: dependencias nativas o inmaduras en Windows y más código
  que mantener.
- _Reusar `/ws` para la voz_: mezclaría un canal de solo lectura con uno de escritura de alto
  caudal bajo los mismos límites.

**Consecuencias.**

- El audio del cliente viaja por TCP (WebSocket), no por UDP. En redes con pérdida habrá más
  latencia que con WebRTC. **No medido.**
- La conexión WebRTC entre cliente y agente necesita STUN/TURN en redes reales (`ICE_SERVERS`).
  Sin TURN solo funciona dentro de la misma red.
- Mientras el agente habla con el cliente por WebRTC, el audio de cada uno también va a nuestro
  STT: se sube dos veces.

**Evidencia.**

- `tests/integration/voice.test.ts` (33 pruebas) cubre:
  - llamada completa con el motor real;
  - aislamiento de la señalización entre llamadas y entre instancias;
  - permisos de cliente y agente;
  - carrera al unirse;
  - caudal de audio, topes, gracia, duración máxima, barrido y purga.
- Mutaciones 23–38 de `npm run test:mutations`.
- Prueba en vivo en `docs/demo-fase5.md`.

**Verificado en la Fase 6 (UI de voz):** con WebRTC real entre dos pestañas del navegador, la conexión
quedó `connected` y el audio fluye en ambos sentidos (nivel medido del otro lado). Micrófono
sintético, no humano: ver `atencion-ia-frontend/docs/prueba-voz.md`. **No verificado:** entre dos
equipos distintos (requiere HTTPS y TURN).
