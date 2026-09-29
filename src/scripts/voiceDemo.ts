import { WebSocket } from "ws";
import { encodeMockSpeech } from "../services/voice/mock.provider";
import { durationMs } from "../services/voice/pcm";

/**
 * Demo de una llamada de voz de punta a punta, desde la consola, contra una
 * API corriendo (con VOICE_PROVIDER=mock y AI_PROVIDER=mock):
 *
 *   npm run voice:demo
 *   npm run voice:demo -- --agente laura@cordillera.example
 *   npm run voice:demo -- --agente laura@cordillera.example --espera-agente 20
 *     (espera 20 s en la cola antes de que el agente se una: da tiempo a abrir
 *      el caso en el panel y ver la transcripción)
 *
 * Hace de CLIENTE: crea una sesión del widget, acepta el aviso, inicia la
 * llamada y "habla" (habla simulada del mock, enviada a velocidad real por el
 * WebSocket de voz). Pregunta algo con respuesta en la base de conocimiento y
 * luego reporta un cargo que no reconoce: el MISMO motor de la Fase 3 escala.
 * Con --agente, además hace de AGENTE: se une (recibe la transcripción
 * acumulada), intercambia señalización WebRTC de prueba y habla.
 *
 * Mientras corre, el panel de agente del navegador muestra la conversación y
 * la transcripción en tiempo real.
 *
 * Variables opcionales: DEMO_API_URL (http://localhost:4100),
 * DEMO_ORIGIN (http://localhost:5174, debe estar en CORS_ORIGIN de la API),
 * DEMO_AGENT_PASSWORD (la del seed: Password123!).
 */

const API = process.env.DEMO_API_URL ?? "http://localhost:4100";
const ORIGIN = process.env.DEMO_ORIGIN ?? "http://localhost:5174";
const agentArg = process.argv.indexOf("--agente");
const AGENT_EMAIL = agentArg > 0 ? process.argv[agentArg + 1] : undefined;
const AGENT_PASSWORD = process.env.DEMO_AGENT_PASSWORD ?? "Password123!";
const waitArg = process.argv.indexOf("--espera-agente");
const WAIT_BEFORE_JOIN_MS = waitArg > 0 ? Number(process.argv[waitArg + 1]) * 1000 : 0;

type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (who: string, text: string) =>
  console.log(`${new Date().toISOString().slice(11, 19)}  ${who.padEnd(8)} ${text}`);

async function api(path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<Json> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Json) : {};
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

function openVoice(auth: Json, who: string) {
  const ws = new WebSocket(`${API.replace(/^http/, "ws")}/ws/voice`, { headers: { Origin: ORIGIN } });
  const messages: Json[] = [];
  let audioBytes = 0;
  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      audioBytes += (raw as Buffer).length;
      return;
    }
    const message = JSON.parse(raw.toString()) as Json;
    messages.push(message);
    switch (message.type) {
      case "transcript.final":
        log(who, `📝 transcrito (${message.speaker}): "${message.text}"`);
        break;
      case "tts.start":
        log(who, `🔊 la IA responde (${message.durationMs} ms de audio): "${message.text}"`);
        break;
      case "tts.end":
        log(who, `🔊 audio recibido: ${audioBytes} bytes de PCM16`);
        audioBytes = 0;
        break;
      case "call.status":
        log(who, `📞 estado de la llamada: ${message.status}`);
        break;
      case "peer":
        log(
          who,
          `👥 ${message.role === "agent" ? "el agente" : "el cliente"} ${message.present ? "está en la llamada" : "salió"}`
        );
        break;
      case "signal":
        log(who, `📡 señal WebRTC recibida: ${(message.signal as Json).type}`);
        break;
      case "call.ended":
        log(who, `📞 llamada terminada (${message.reason})`);
        break;
      case "notice":
      case "error":
        log(who, `⚠️  ${String(message.text ?? message.message)}`);
        break;
    }
  });
  const until = async (predicate: (m: Json) => boolean, timeoutMs = 20_000) => {
    const start = Date.now();
    for (;;) {
      const found = messages.find(predicate);
      if (found) return found;
      if (Date.now() - start > timeoutMs) throw new Error(`${who}: no llegó lo esperado a tiempo`);
      await sleep(50);
    }
  };
  const ready = new Promise<void>((resolve, reject) => {
    ws.once("open", () => ws.send(JSON.stringify({ type: "auth", ...auth })));
    ws.once("close", (code, reason) => reject(new Error(`${who}: el socket se cerró (${code} ${reason.toString()})`)));
    void until((m) => m.type === "ready").then(() => resolve());
  });
  return { ws, messages, ready, until };
}

/** "Habla": envía la habla simulada a velocidad REAL (como un micrófono). */
async function speak(ws: WebSocket, who: string, text: string) {
  log(who, `🎙️  dice: "${text}"`);
  for (const frame of encodeMockSpeech(text)) {
    ws.send(frame);
    await sleep(durationMs(frame.length));
  }
}

async function main() {
  console.log(`\nDemo de llamada de voz contra ${API} (origen ${ORIGIN})\n`);

  // 1. Sesión del cliente, conversación y aviso de consentimiento.
  const session = await api("/api/widget/sessions", { method: "POST", body: { displayName: "Cliente demo voz" } });
  const token = String(session.token);
  const conversation = await api("/api/widget/conversations", { method: "POST", token, body: {} });
  const consent = await api("/api/widget/voice/consent", { token });
  log("CLIENTE", `lee el aviso (${consent.version}):`);
  for (const point of consent.points as string[]) console.log(`            · ${point}`);

  // 2. Acepta y llama.
  const started = await api(`/api/widget/conversations/${conversation.id}/calls`, {
    method: "POST",
    token,
    body: { consentVersion: consent.version, accepted: true },
  });
  const callId = String((started.call as Json).id);
  log("CLIENTE", `📞 llamada creada ${callId} (estado: ${(started.call as Json).status})`);
  const customer = openVoice({ callId, widgetToken: token }, "CLIENTE");
  await customer.ready;

  // 3. Pregunta con respuesta en la KB → la IA contesta con voz.
  await speak(customer.ws, "CLIENTE", "¿Cuál es el horario de atención de las oficinas?");
  await customer.until((m) => m.type === "tts.end");

  // 4. Posible fraude → el motor escala → en espera de agente.
  await speak(customer.ws, "CLIENTE", "No reconozco un cargo de 450.000 pesos en mi tarjeta de crédito");
  await customer.until((m) => m.type === "call.status" && m.status === "waiting_agent");
  log("CLIENTE", "⏳ esperando a un asesor (en el panel, el caso está en la cola)");

  if (!AGENT_EMAIL) {
    log(
      "CLIENTE",
      "sin --agente: la llamada queda en espera 20 s (únete desde otra consola o mira el panel) y luego cuelga"
    );
    await sleep(20_000);
    customer.ws.send(JSON.stringify({ type: "hangup" }));
    await customer.until((m) => m.type === "call.ended");
    return;
  }

  if (WAIT_BEFORE_JOIN_MS > 0) {
    log("CLIENTE", `el agente se unirá en ${WAIT_BEFORE_JOIN_MS / 1000} s; mientras, el cliente sigue hablando`);
    await speak(customer.ws, "CLIENTE", "Por favor bloqueen la tarjeta, es urgente");
    await sleep(WAIT_BEFORE_JOIN_MS);
  }

  // 5. El agente inicia sesión, se une y recibe la transcripción acumulada.
  const login = await api("/api/auth/login", {
    method: "POST",
    body: { email: AGENT_EMAIL, password: AGENT_PASSWORD },
  });
  const accessToken = String(login.accessToken);
  const join = await api(`/api/calls/${callId}/join`, { method: "POST", token: accessToken });
  log("AGENTE", `se une a la llamada; transcripción acumulada:`);
  for (const segment of join.transcript as Json[])
    console.log(`            [${segment.seq}] ${segment.speaker}: ${segment.text}`);
  const agent = openVoice({ callId, accessToken }, "AGENTE");
  await agent.ready;

  // 6. Señalización WebRTC (de prueba: en la Fase 6 la hace el navegador).
  await agent.until((m) => m.type === "peer" && m.role === "customer");
  agent.ws.send(JSON.stringify({ type: "signal", signal: { type: "offer", sdp: "v=0\r\n(oferta de demo)" } }));
  await customer.until((m) => m.type === "signal");
  customer.ws.send(JSON.stringify({ type: "signal", signal: { type: "answer", sdp: "v=0\r\n(respuesta de demo)" } }));
  await agent.until((m) => m.type === "signal");

  // 7. Hablan: lo del agente queda como turno suyo; la IA ya no interviene.
  await speak(agent.ws, "AGENTE", "Hola, soy tu asesora. Ya bloqueé la tarjeta y abrí el reclamo por el cargo.");
  await agent.until((m) => m.type === "transcript.final");
  await speak(customer.ws, "CLIENTE", "Muchas gracias por la ayuda");
  await customer.until((m) => m.type === "transcript.final" && m.text === "Muchas gracias por la ayuda");

  // 8. Cuelga el cliente.
  customer.ws.send(JSON.stringify({ type: "hangup" }));
  await agent.until((m) => m.type === "call.ended");
  const call = await api(`/api/widget/calls/${callId}`, { token });
  log("CLIENTE", `resumen: estado ${call.status}, motivo ${call.endReason}, duración ${call.durationSeconds} s`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(`\nLa demo falló: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
