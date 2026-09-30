// Envío MASIVO de mensajes de clientes al asistente (npm run loadtest:messages).
//
// Cada conexión de autocannon es un cliente distinto (una sesión del widget y
// su conversación) que manda, sin pausa, preguntas con respuesta en la base de
// conocimiento: cada solicitud recorre el motor completo (clasificación,
// embedding de la pregunta, búsqueda vectorial en pgvector, respuesta, dos
// escrituras en la base y dos eventos de tiempo real). Las preguntas NO
// escalan: la conversación sigue con la IA durante toda la prueba.
import { randomUUID } from "node:crypto";
import { readState, run, save } from "./lib.mjs";

const CONNECTIONS = Number(process.env.LOADTEST_CONNECTIONS || 50);
const QUESTIONS = ["¿Cuál es el horario de atención de las oficinas?", "¿Cómo bloqueo mi tarjeta si la pierdo?"];

const { sessions } = readState();
if (sessions.length < CONNECTIONS)
  throw new Error(`Hacen falta ${CONNECTIONS} sesiones; setup creó ${sessions.length}.`);
let nextSession = 0;

const result = await run("messages", {
  connections: CONNECTIONS,
  requests: [
    {
      method: "POST",
      setupRequest(req, context) {
        // Una sesión fija por conexión (como un cliente real escribiendo en su chat).
        context.session ??= sessions[nextSession++ % sessions.length];
        context.turn = (context.turn ?? 0) + 1;
        return {
          ...req,
          path: `/api/widget/conversations/${context.session.conversationId}/messages`,
          headers: { Authorization: `Bearer ${context.session.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ content: QUESTIONS[context.turn % QUESTIONS.length], clientMsgId: randomUUID() }),
        };
      },
    },
  ],
});

save(
  `messages-c${CONNECTIONS}-lat${process.env.LOADTEST_AI_MOCK_LATENCY_MS ?? "x"}${process.env.LOADTEST_LABEL ? `-${process.env.LOADTEST_LABEL}` : ""}.json`,
  {
    scenario: "Envío masivo de mensajes al asistente",
    aiMockLatencyMs: process.env.LOADTEST_AI_MOCK_LATENCY_MS ?? "no indicada (debe coincidir con la de la API)",
    result,
  }
);
