# 0011 · Proveedor de voz: Deepgram (STT Nova-3 + TTS Aura-2), mock por defecto

**Contexto.** Hace falta:

- STT **en streaming**, con resultados parciales y detección del fin de cada frase;
- TTS en **español**;
- una latencia que permita conversar.

Igual que con la IA ([ADR 0005](0005-proveedor-de-ia-intercambiable.md)), todo debe funcionar sin
credenciales con un proveedor simulado, y el real debe quedar detrás de la misma interfaz
(`src/services/voice/types.ts`).

**Decisión.**

- `VOICE_PROVIDER=mock` por defecto: transcripción y síntesis simuladas, deterministas en los tests.
- Adaptador real: **Deepgram**.
  - **STT**: WebSocket de streaming con `model=nova-3&language=es`, resultados parciales,
    `endpointing` para detectar el fin de frase, `smart_format` y `mip_opt_out=true`.
  - **TTS**: REST `/v1/speak` con una voz Aura-2 en español que devuelve PCM16 crudo. Por defecto
    usa `aura-2-celeste-es` (acento colombiano); se cambia con `DEEPGRAM_TTS_MODEL`.

**Por qué Deepgram.**

- **Una sola API key** para STT y TTS: la integración y la gestión de secretos son simples.
- Su STT en streaming por WebSocket (parciales + fin de frase) encaja directamente con nuestro
  `/ws/voice` y con el modelo "cada frase final es un turno".
- Tiene español en Nova-3 (`language=es`) y voces Aura-2 en español, con acentos latinoamericanos.
- Trabaja con PCM16 crudo de entrada y de salida, sin recodificar.

**Alternativas.**

- _Azure AI Speech_: STT y TTS muy completos, con voces neurales `es-CO`. Pero necesita key **y**
  región, su SDK es más pesado y el streaming sin SDK es más complejo. Es una buena segunda opción
  si se exige una voz concreta de Microsoft.
- _Google Cloud STT/TTS_: requiere una cuenta de servicio (un archivo JSON de credenciales) y
  streaming por gRPC.
- _ElevenLabs_: el TTS más natural, pero habría que combinarlo con otro STT, es decir, dos
  proveedores y dos keys.
- _OpenAI Realtime_: mezclaría el STT con otro LLM y rompería el principio de un solo motor con
  Claude.

**Qué necesito del usuario para probarlo con credenciales reales.**

1. Una API key de Deepgram. Se crea en la consola de Deepgram, en el proyecto → API Keys, con rol
   de uso, no de administración.
2. Agregar al `.env` del backend:

   ```
   VOICE_PROVIDER=deepgram
   DEEPGRAM_API_KEY=<la key>
   ```

   Opcionales: `DEEPGRAM_STT_MODEL`, `DEEPGRAM_LANGUAGE` y `DEEPGRAM_TTS_MODEL`.

3. Verificar lo que solo está probado con dobles, **no contra el servicio real**:
   - que `nova-3` + `language=es` y la voz elegida responden sin error 400;
   - que el servicio acepta `mip_opt_out`;
   - la latencia real de un turno (métrica `atencion_ia_voice_turn_latency_seconds`);
   - si los 300 ms de `endpointing` funcionan bien con voces reales.

**Consecuencias.** La voz real está **implementada pero no probada contra el proveedor**. Las
pruebas del adaptador (`voiceProviders.test.ts`) verifican el protocolo con un socket y un fetch
simulados:

- URL, parámetros y la key en el header;
- cómo se acumulan los resultados `is_final` y cómo `speech_final` cierra el turno;
- el cierre con `CloseStream`;
- el troceo del texto largo en el TTS;
- que un error del proveedor no filtre la key.
