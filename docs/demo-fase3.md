# Demo de la Fase 3 paso a paso (cmd.exe)

Flujo completo de [`docs/rag.md`](rag.md) con los datos reales del seed de Banco Cordillera:
cliente → respuesta con la base de conocimiento → posible fraude → escalamiento (uno solo) →
Laura toma el caso → Diego no puede verlo.

Cada comando se pega tal cual en **cmd.exe**. Cuando un paso dice **COPIA**, toma ese valor de
la respuesta del comando anterior y pégalo en el `set` que sigue (sin comillas).

> **Por qué los mensajes van sin tildes:** `curl` en Windows envía los argumentos en la
> codificación de Windows (no UTF-8) y la API rechaza con un 400 el texto mal codificado en vez
> de guardarlo corrupto. Las respuestas sí traen tildes; si en la consola se ven como `Ã¡`,
> ejecuta `chcp 65001` (solo cambia cómo se muestran).

## Requisitos (ya corriendo)

- Postgres y Redis: `docker compose up -d` en `atencion-ia-database`.
- Backend (`npm run dev`) en el puerto 4100 y worker (`npm run worker`), cada uno en su ventana.

## Paso 0 · Preparar datos (una vez; se puede repetir)

```bat
cd ..\atencion-ia-database
scripts\seed.bat
cd ..\atencion-ia-backend
npm run kb:reindex
set API=http://localhost:4100
```

`seed.bat` deja lista la sesión del widget del cliente de la demo (y la renueva si ya existía);
`kb:reindex` indexa los 9 artículos publicados para el RAG. Al final debe decir
`kb:reindex terminado: 11 artículos revisados`.

## Paso 1 · Sesión de widget como cliente

**Cliente del seed:** el **cliente anónimo** `b0000000-0000-4000-8000-000000000003` (entró por el
widget sin dar datos). Es el único cliente del seed con sesión de widget: los demás (Camila,
Andrés, Valentina, Jorge) no tienen, y **a propósito no hay forma de "entrar como" un cliente
existente** dando su correo o nombre, porque cualquiera podría escribir el correo de otra persona
y leer sus conversaciones. Su sesión la crea el seed con este token de prueba:

```bat
set TOKEN=wgt_seed-anonimo-cordillera
curl -s -H "Authorization: Bearer %TOKEN%" %API%/api/widget/conversations
```

**Debes ver** `"items":[...]` y, entre ellas, la conversación suya que viene en el seed:
`"subject":"Consulta por llamada: compras internacionales"`, `"status":"closed"`. Eso confirma
que el token corresponde a ese cliente. (Si ya corriste la demo antes, también aparecen las
conversaciones de esas corridas.)

> Alternativa (cliente nuevo, no del seed): `curl -s -H "Content-Type: application/json" -d "{\"displayName\":\"Demo\"}" %API%/api/widget/sessions`
> y **COPIA** el valor de `"token"` (empieza con `wgt_`) en `set TOKEN=...`.

Ahora abre una conversación nueva para la demo:

```bat
curl -s -H "Authorization: Bearer %TOKEN%" -H "Content-Type: application/json" -d "{}" %API%/api/widget/conversations
```

**COPIA** el valor de `"id"` (un UUID, por ejemplo `3f1c…`) y pégalo aquí:

```bat
set CONV=pega-aqui-el-id
```

## Paso 2 · Pregunta que se responde con la base de conocimiento

```bat
curl -s -H "Authorization: Bearer %TOKEN%" -H "Content-Type: application/json" -d "{\"content\":\"A que hora abren las oficinas el sabado?\"}" %API%/api/widget/conversations/%CONV%/messages
```

**Debes ver** en `"reply"`:

- `"sender":"ai"` y `"handedOffToAgent":false` (lo atendió la IA, no escaló).
- `"content"` que empieza con `Según nuestra información (Horarios de atención de oficinas y canales):`
  y contiene **`los sábados de 9:00 a. m. a 12:00 m.`** — ese texto viene literal del artículo
  `horarios-oficinas` del seed.

Confirma en la base qué artículo citó la IA (el cliente no ve las citas, el sistema sí):

```bat
docker exec atencion_ia_postgres psql -U postgres -d atencion_ia -c "SELECT a.slug AS articulo_citado, round(mc.score::numeric, 3) AS similitud FROM messages m JOIN message_citations mc ON mc.message_id = m.id JOIN kb_articles a ON a.id = mc.article_id WHERE m.conversation_id = '%CONV%' AND m.sender_type = 'ai'"
```

**Debes ver** una fila: `articulo_citado = horarios-oficinas` (la similitud ronda 0.5 con el
proveedor mock).

## Paso 3 · Mensaje de posible fraude → escalamiento

```bat
curl -s -H "Authorization: Bearer %TOKEN%" -H "Content-Type: application/json" -d "{\"content\":\"Me aparece una compra de 1.200.000 que yo NO hice!!\"}" %API%/api/widget/conversations/%CONV%/messages
```

**Debes ver:**

- `"reply":{..."sender":"system"...}` con el aviso `Por tu seguridad, si no reconoces un cargo bloquea tu tarjeta…`
  (mensaje de traspaso, no una respuesta de la IA).
- `"conversationStatus":"waiting_agent"` y `"handedOffToAgent":true`.

Ahora insiste como lo haría un cliente preocupado (otro turno que también es fraude):

```bat
curl -s -H "Authorization: Bearer %TOKEN%" -H "Content-Type: application/json" -d "{\"content\":\"Por favor rapido, fue un fraude, me robaron\"}" %API%/api/widget/conversations/%CONV%/messages
```

**Debes ver** `"reply":null` (ya espera un asesor: la IA no responde y no se repite el aviso) y
`"conversationStatus":"waiting_agent"`.

Confirma que existe **UN solo** escalamiento, aunque hubo dos turnos de fraude:

```bat
docker exec atencion_ia_postgres psql -U postgres -d atencion_ia -c "SELECT count(*) AS escalamientos, max(reason::text) AS motivo, max(status::text) AS estado, max(priority) AS prioridad FROM escalations WHERE conversation_id = '%CONV%'"
```

**Debes ver** `escalamientos = 1`, `motivo = possible_fraud`, `estado = open`, `prioridad = 90`.

## Paso 4 · Laura inicia sesión y toma el caso

```bat
curl -s -H "Content-Type: application/json" -d "{\"email\":\"laura@cordillera.example\",\"password\":\"Password123!\"}" %API%/api/auth/login
```

**COPIA** el valor de `"accessToken"` (empieza con `eyJ`, es largo) y pégalo aquí:

```bat
set LAURA=pega-aqui-el-accessToken-de-laura
```

(Opcional) La cola general, donde el caso aparece con prioridad 90:

```bat
curl -s -H "Authorization: Bearer %LAURA%" "%API%/api/conversations?scope=queue"
```

Toma el caso:

```bat
curl -s -X POST -H "Authorization: Bearer %LAURA%" %API%/api/conversations/%CONV%/take
```

**Debes ver** `"status":"agent_active"` y `"assignedAgent":{…"name":"Laura Méndez"}`.

## Paso 5 · Diego intenta ver el caso de Laura → 404

```bat
curl -s -H "Content-Type: application/json" -d "{\"email\":\"diego@cordillera.example\",\"password\":\"Password123!\"}" %API%/api/auth/login
```

**COPIA** su `"accessToken"`:

```bat
set DIEGO=pega-aqui-el-accessToken-de-diego
curl -s -i -H "Authorization: Bearer %DIEGO%" %API%/api/conversations/%CONV%
```

**Debes ver** en la primera línea `HTTP/1.1 404 Not Found` y al final
`{"error":"Conversación no encontrada"}`: 404 y no 403, para no revelar que la conversación existe.
Lo mismo con el historial:

```bat
curl -s -i -H "Authorization: Bearer %DIEGO%" %API%/api/conversations/%CONV%/messages
```

Contraprueba: Laura, que la atiende, sí la ve (`HTTP/1.1 200 OK`):

```bat
curl -s -i -H "Authorization: Bearer %LAURA%" %API%/api/conversations/%CONV%
```

> Antes del paso 4 Diego **sí** podía verla (estaba en la cola general, y los agentes leen el
> historial antes de tomar un caso). Deja de verla en el momento en que Laura la toma.

## Paso 6 (recomendado) · Cerrar el caso para poder repetir la demo

Un cliente puede tener hasta 3 conversaciones abiertas y Laura atiende hasta 3 a la vez; cerrar
el caso deja todo listo para repetir la demo:

```bat
curl -s -H "Authorization: Bearer %LAURA%" -H "Content-Type: application/json" -d "{\"note\":\"Demo terminada\"}" %API%/api/conversations/%CONV%/close
```

**Debes ver** `"status":"closed"`. El escalamiento queda `resolved`.

## Si algo no coincide

| Síntoma                                     | Causa probable                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `401` en el paso 1                          | No corriste `scripts\seed.bat` después de actualizar el repo (el token del seed cambió en la Fase 3) |
| Paso 2 responde `No encontré información…`  | Falta `npm run kb:reindex`                                                                           |
| `400 … UTF-8`                               | Un mensaje con tilde o ñ escrito en cmd (ver la nota del inicio)                                     |
| `409 Ya tienes 3 conversaciones abiertas`   | Demos anteriores sin el paso 6                                                                       |
| `409 Ya atiendes 3 conversaciones` al tomar | Laura tiene 3 casos abiertos: cierra alguno (paso 6)                                                 |
| `429`                                       | Rate limit: más de 12 mensajes por minuto en la misma sesión; espera un minuto                       |
