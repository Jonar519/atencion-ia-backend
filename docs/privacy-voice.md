# Voz: consentimiento, qué se guarda y por cuánto tiempo

Política del canal de voz de Banco Cordillera (Fase 5). Cada regla indica **dónde se hace cumplir**:
en la base de datos, en el backend, o en ambos.

## 1. Consentimiento antes de llamar

Antes de iniciar una llamada, el widget muestra el aviso vigente (`GET /api/widget/voice/consent`,
versión `voz-v1`, texto en `src/modules/voice/consent.ts`). El aviso dice, en lenguaje simple:

- Te atiende primero un asistente de IA, y puedes pedir un asesor humano cuando quieras.
- Tu voz se **transcribe con IA**, y el texto se **analiza** (intención y tono) para atenderte y,
  si hace falta, pasarte con un asesor.
- **El audio no se graba.** Lo que se conserva es la transcripción.
- La transcripción se guarda **90 días** y luego se elimina.
- Cada llamada dura como máximo 15 minutos. Puedes colgar y seguir por chat.
- Nunca te pediremos contraseñas, claves ni el código de seguridad de tu tarjeta.

| Regla                                      | Dónde se cumple                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| No hay llamada sin consentimiento          | Base: `calls.consent_given_at NOT NULL`, CHECK `consent_given_at <= started_at`                     |
| El consentimiento es del aviso **vigente** | Backend: `POST …/calls` exige `consentVersion` = versión actual y `accepted: true` (si no, 400/409) |
| Se sabe qué texto aceptó cada cliente      | Base: `calls.consent_version`                                                                       |
| Quien no acepta puede seguir atendido      | Producto: el chat de texto no requiere este consentimiento                                          |

Cambiar el texto del aviso obliga a subir `CONSENT_VERSION`. Desde ese momento se rechazan las
llamadas iniciadas con el aviso anterior (pruebas en `voice.test.ts` y mutación 30).

## 2. Qué se procesa, qué se guarda y por cuánto tiempo

| Dato                                                                                       | ¿Se guarda?                | Retención                                                                                   | Detalle                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Audio del cliente o del agente**                                                         | **No**                     | —                                                                                           | Llega por el WebSocket de voz, pasa en memoria al STT y se descarta. `calls.audio_storage_key` queda en NULL (no hay almacenamiento de audio). |
| **Audio entre cliente y agente (WebRTC)**                                                  | **No**                     | —                                                                                           | Va de navegador a navegador. El servidor solo relea la señalización (SDP/ICE) y nunca recibe ese audio.                                        |
| **Transcripción parcial** (lo que el STT entiende mientras se habla)                       | **No**                     | —                                                                                           | Solo viaja por WebSocket al propio hablante y al staff que puede ver el caso.                                                                  |
| **Transcripción final** (`call_transcript_segments`)                                       | Sí                         | `VOICE_TRANSCRIPT_RETENTION_DAYS` (**90** por defecto; la base impone un **máximo de 180**) | Una fila por frase: quién habló, texto, tiempos, confianza.                                                                                    |
| **Turnos de voz** (`messages` con `channel = 'voice'`)                                     | Sí                         | Igual que la transcripción: su **texto** se reemplaza al purgar                             | Son los mismos turnos que ve el agente en la conversación.                                                                                     |
| Respuestas de la IA sintetizadas (TTS)                                                     | Solo el texto (como turno) | Igual que la transcripción                                                                  | El audio sintetizado no se guarda.                                                                                                             |
| Análisis por turno (intención, sentimiento)                                                | Sí                         | Mientras exista la conversación                                                             | No contiene lo que se dijo, solo categorías.                                                                                                   |
| Metadatos de la llamada (inicio, fin, duración, motivo de fin, participantes)              | Sí                         | Mientras exista la conversación                                                             | Sirven para auditoría y reportes, y no incluyen contenido.                                                                                     |
| Consumo (`ai_usage`: segundos de STT, caracteres de TTS)                                   | Sí                         | Mientras exista la conversación                                                             | Sin contenido. Sirve para los topes de gasto por cliente.                                                                                      |
| Auditoría (`audit_log`: `call.start`, `call.join`, `call.leave`, `call.end`, `call.purge`) | Sí                         | Según la política de auditoría                                                              | Sin contenido y con la IP como HMAC.                                                                                                           |
| Logs de la aplicación                                                                      | Nunca el contenido         | —                                                                                           | Los logs no incluyen texto transcrito ni audio (redacción del logger y logs de voz sin texto).                                                 |

### Purga por retención

- Cada llamada guarda `retain_until = started_at + 90 días` al crearse.
- El **worker** ejecuta la purga **cada hora** (cola `voice-maintenance`). También se puede
  ejecutar a mano con `npm run voice:purge`.
- Para cada llamada **terminada** con `retain_until` vencido:
  1. Borra sus segmentos de transcripción.
  2. Reemplaza el texto de sus turnos de voz por `[Transcripción eliminada por la política de retención]`.
  3. Marca `calls.transcript_purged_at`.

  Todo ocurre en una transacción, por lotes y con `FOR UPDATE SKIP LOCKED`, así que dos workers
  no se pisan.

- Garantías de la **base** (migración 014 del repo de base de datos):
  - Una llamada purgada **no acepta** segmentos nuevos (trigger).
  - Solo se purga una llamada terminada, y nunca antes de su fin (CHECK).
  - Ninguna llamada puede pedir más de 180 días de retención (CHECK), aunque el backend se configure mal.
- Pruebas: `voice.test.ts` verifica que solo se purga lo vencido y que lo dicho (por ejemplo, un
  número de cuenta) desaparece. `tests/003_voice.sql` del repo de base de datos rompe cada una de
  las garantías anteriores. Las mutaciones 34 y 35 dejan la purga incompleta a propósito.

## 3. Proveedor de voz (datos que salen de nuestra infraestructura)

- **Modo `mock`** (por defecto, el único usado hasta ahora): nada sale del backend.
- **Modo `deepgram`** (recomendado para producción, [ADR 0011](adr/0011-proveedor-de-voz.md)):
  - El audio se envía por streaming al STT de Deepgram y el texto de las respuestas a su TTS.
  - El adaptador pide `mip_opt_out=true`, es decir, que el audio **no** se use para mejorar sus modelos.
  - **Pendiente de confirmar con credenciales reales:** que ese parámetro se acepta y la política
    de retención del proveedor en el plan contratado. Hay que revisarlo con el contrato antes de
    usarlo con clientes reales.

## 4. Límites que también protegen al cliente y al banco

| Límite                                | Valor por defecto                         | Por qué                                                                                  |
| ------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| Duración máxima de una llamada        | 15 min (`VOICE_MAX_CALL_SECONDS`)         | Evita llamadas abiertas indefinidamente (costo y exposición).                            |
| Segundos de audio por cliente en 24 h | 1800 (`VOICE_DAILY_SECONDS_PER_CUSTOMER`) | Impide agotar los créditos de STT por el canal de voz.                                   |
| Tope de tokens de IA por cliente      | El mismo del chat                         | La voz pasa por el mismo motor conversacional.                                           |
| Caudal de audio                       | 1,25× tiempo real (ráfagas de 2 s)        | Un script no puede enviar horas de audio en segundos (cierre 4429).                      |
| Llamadas nuevas por sesión            | 6 por hora                                | Evita abrir llamadas en masa.                                                            |
| Reconexión                            | 15 s de gracia                            | Un corte de red breve no cuelga la llamada. Si el cliente no vuelve, la llamada termina. |

## 5. Derechos del titular (pendiente)

La legislación de protección de datos aplicable (por ejemplo, en Colombia la Ley 1581 de 2012) da al
cliente derecho a pedir acceso a sus datos, rectificación o supresión. **No está implementado** un flujo de supresión a pedido: hoy
solo existe la purga por vencimiento. Queda documentado como trabajo futuro. En este proyecto de
curso, el cliente del widget es anónimo y no hay forma de verificar su identidad para atender esa
solicitud.
