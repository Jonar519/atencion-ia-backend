# Demo de la Fase 5: una llamada de voz de principio a fin (cmd.exe)

Esta demo usa el proveedor de voz **mock**: la transcripción y la síntesis son simuladas, así que
no hacen falta credenciales. Un script hace de cliente (y, si se pide, de agente) y "habla" a
velocidad real por el WebSocket de voz. En el navegador, el panel de agente muestra la conversación
y la **transcripción en vivo**.

Para probar con tu micrófono en el navegador (botón de llamar, unirse, WebRTC real) usa la guía
`atencion-ia-frontend/docs/prueba-voz.md`.

## Antes de empezar

- Postgres y Redis levantados, la base migrada **con la migración 014** y el seed cargado. Si ya
  tenías la base de fases anteriores, solo falta migrar:
  ```bat
  cd atencion-ia-database
  scripts\migrate.bat
  ```
- Base de conocimiento indexada: en `atencion-ia-backend`, ejecuta `npm run kb:reindex` una vez.

## 1. Levantar la API, el worker y el frontend (tres ventanas de cmd)

```bat
cd atencion-ia-backend
npm run dev
```

```bat
cd atencion-ia-backend
npm run worker
```

```bat
cd atencion-ia-frontend
npm run dev
```

## 2. Abrir el panel de agente

En el navegador, abre `http://localhost:5174/#/agente/login` e inicia sesión como
`laura@cordillera.example` con la contraseña `Password123!` (cuenta del seed).

## 3. Ejecutar la llamada de demo (cuarta ventana)

```bat
cd atencion-ia-backend
npm run voice:demo -- --agente laura@cordillera.example --espera-agente 20
```

Qué pasa, en orden (la consola muestra cada paso):

1. **Consentimiento.** El cliente lee el aviso vigente (`voz-v1`) y lo acepta. Sin esto, la API no
   crea la llamada.
2. **Llamada.** El estado pasa de `connecting` a `in_progress` cuando el cliente conecta el audio.
3. **Pregunta con respuesta en la base de conocimiento.** El cliente dice "¿Cuál es el horario de
   atención de las oficinas?" y ocurre esto:
   - el STT la transcribe;
   - el **mismo motor de la Fase 3** busca en la KB y responde;
   - la respuesta vuelve como audio (TTS).
4. **Posible fraude.** El cliente dice "No reconozco un cargo de 450.000 pesos…". El motor escala,
   la IA avisa que lo comunica con un asesor y la llamada pasa a **`waiting_agent`**.
5. **En el panel.** El caso aparece en la cola de Laura sin recargar la página:
   - ábrelo para ver el historial con la etiqueta "Voz" y el análisis de la IA;
   - arriba aparece el aviso "Llamada en espera de asesor".
6. **El agente se une** (después de 20 s):
   - recibe la **transcripción acumulada** (se imprime en la consola);
   - toma el caso;
   - se intercambian la oferta y la respuesta WebRTC de prueba a través del servidor.
7. **El agente habla.** Mientras habla, el panel muestra **"Tú (en vivo)"** palabra por palabra;
   al terminar la frase, esta pasa al historial. La IA ya no interviene.
8. **El cliente agradece y cuelga.** La llamada termina como `customer_hangup` y queda su duración.

Sin `--agente`, la llamada queda 20 s en espera. En ese tiempo puedes mirar la cola en el panel;
después el cliente cuelga.

## 4. Comprobar lo que quedó guardado (opcional)

```bat
docker exec atencion_ia_postgres psql -U postgres -d atencion_ia -c "select status, end_reason, duration_seconds, consent_version, audio_storage_key from calls order by started_at desc limit 1"
docker exec atencion_ia_postgres psql -U postgres -d atencion_ia -c "select seq, speaker, text from call_transcript_segments where call_id = (select id from calls order by started_at desc limit 1) order by seq"
```

Resultado esperado:

- `audio_storage_key` vacío: el audio no se guarda;
- la transcripción con los segmentos del cliente, la IA y el agente, en orden.

## Verificación hecha en esta fase

Corrí la misma demo en un **entorno aislado**, sin tocar la base de desarrollo:

| Recurso       | Entorno aislado   |
| ------------- | ----------------- |
| Base de datos | `atencion_ia_e2e` |
| Redis         | db 1              |
| API           | puerto 4101       |
| Frontend      | puerto 5175       |

Resultados:

- La llamada terminó como `customer_hangup` y duró 43 s.
- Quedaron 7 segmentos en orden (cliente, IA, cliente, IA, cliente, agente, cliente), todos
  enlazados a su turno.
- El consumo quedó medido: 18 s de STT (el audio del agente no se cobra al cliente) y 562
  caracteres de TTS.
- El panel mostró la transcripción en vivo palabra por palabra, primero la del agente y luego la
  del cliente.

## No verificado

- Audio real de micrófono y WebRTC real: ya hay UI de voz; la guía para probarlo con tu micrófono
  está en `atencion-ia-frontend/docs/prueba-voz.md`.
- El proveedor real (Deepgram): solo se probó el protocolo con dobles
  ([ADR 0011](adr/0011-proveedor-de-voz.md)).
- La latencia con un proveedor real: **no medida**. Con el mock, un turno tarda milisegundos.
