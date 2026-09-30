// RÁFAGA de escalamientos (npm run loadtest:escalations).
//
//  1. AGENTS agentes sintéticos conectados al WebSocket de eventos (como el panel).
//  2. BURST clientes reportan un posible fraude AL MISMO TIEMPO.
//  3. Se mide:
//     - latencia HTTP de cada turno que escala;
//     - cuánto tarda en llegarle a CADA agente el aviso de que el caso entró a
//       la cola (conversation.updated: lo publica la API al confirmar) y el
//       aviso del worker (escalation.created: pasa por la cola BullMQ);
//     - si algún aviso se perdió o llegó repetido.
//  4. Carrera en UNA conversación: RACE turnos de fraude simultáneos del mismo
//     cliente deben producir UN solo escalamiento y UN solo aviso.
//  5. Verificación en la base (LOADTEST_DATABASE_URL): un escalamiento por
//     conversación, ninguno duplicado.
import pg from "pg";
import { WebSocket } from "ws";
import { API, ORIGIN, readState, save, sleep, staffLogin, summarize } from "./lib.mjs";

const RACE = Number(process.env.LOADTEST_RACE || 30);
const WAIT_MS = Number(process.env.LOADTEST_WAIT_MS || 60_000);
const DATABASE_URL = process.env.LOADTEST_DATABASE_URL;
const FRAUD = "No reconozco un cargo de 450.000 pesos en mi tarjeta, creo que me clonaron la tarjeta";

const { burst, agents } = readState();
const raceTarget = burst.at(-1);
const burstCustomers = burst.slice(0, -1);

// --- 1. Agentes conectados ---------------------------------------------------
async function connectAgent(email) {
  const token = await staffLogin(email);
  const ws = new WebSocket(`${API.replace(/^http/, "ws")}/ws`, { headers: { Origin: ORIGIN } });
  const events = [];
  await new Promise((resolve, reject) => {
    ws.once("open", () => ws.send(JSON.stringify({ type: "auth", accessToken: token })));
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "ready") return resolve();
      events.push({ at: performance.now(), message });
    });
    ws.once("error", reject);
    setTimeout(() => reject(new Error(`El agente ${email} no se autenticó a tiempo`)), 10_000);
  });
  return { ws, events };
}

const listeners = await Promise.all(agents.map(connectAgent));
console.log(`${listeners.length} agentes conectados al WebSocket.`);

// --- 2. Ráfaga ---------------------------------------------------------------
const sentAt = new Map();
const httpLatencies = [];
const statuses = {};
const burstStart = performance.now();
await Promise.all(
  burstCustomers.map(async (customer) => {
    const start = performance.now();
    sentAt.set(customer.conversationId, start);
    const res = await fetch(`${API}/api/widget/conversations/${customer.conversationId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${customer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: FRAUD }),
    });
    await res.arrayBuffer();
    httpLatencies.push(Number((performance.now() - start).toFixed(1)));
    statuses[res.status] = (statuses[res.status] || 0) + 1;
  })
);
const burstHttpMs = performance.now() - burstStart;
console.log(`Ráfaga de ${burstCustomers.length} turnos respondida en ${burstHttpMs.toFixed(0)} ms.`);

// --- 3. Carrera en una sola conversación ------------------------------------
const raceStatuses = {};
await Promise.all(
  Array.from({ length: RACE }, async () => {
    const res = await fetch(`${API}/api/widget/conversations/${raceTarget.conversationId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${raceTarget.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: FRAUD }),
    });
    await res.arrayBuffer();
    raceStatuses[res.status] = (raceStatuses[res.status] || 0) + 1;
  })
);

// --- Esperar a que los avisos del worker lleguen a todos -----------------------
const burstIds = new Set(burstCustomers.map((c) => c.conversationId));
const expected = burstIds.size + 1; // + la conversación de la carrera
const escalationsOf = (l) => l.events.filter((e) => e.message.type === "escalation.created");
const waitStart = performance.now();
while (performance.now() - waitStart < WAIT_MS && listeners.some((l) => escalationsOf(l).length < expected)) {
  await sleep(100);
}

// --- Métricas de entrega ------------------------------------------------------
const queueDelivery = []; // conversation.updated (API → bus → WS)
const workerDelivery = []; // escalation.created (API → BullMQ → worker → bus → WS)
const perAgent = listeners.map((listener) => {
  const updated = new Map();
  const escalated = new Map();
  for (const { at, message } of listener.events) {
    const id = message.conversation?.id ?? message.conversationId;
    if (
      message.type === "conversation.updated" &&
      message.conversation?.status === "waiting_agent" &&
      !updated.has(id)
    ) {
      updated.set(id, at);
    }
    if (message.type === "escalation.created") escalated.set(id, (escalated.get(id) ?? 0) + 1);
    if (message.type === "escalation.created" && burstIds.has(id) && escalated.get(id) === 1) {
      workerDelivery.push(Number((at - sentAt.get(id)).toFixed(1)));
    }
  }
  for (const [id, at] of updated) if (burstIds.has(id)) queueDelivery.push(Number((at - sentAt.get(id)).toFixed(1)));
  return {
    queueEventsForBurst: [...updated.keys()].filter((id) => burstIds.has(id)).length,
    escalationEvents: [...escalated.values()].reduce((a, b) => a + b, 0),
    duplicatedEscalationEvents: [...escalated.values()].filter((n) => n > 1).length,
    raceEscalationEvents: escalated.get(raceTarget.conversationId) ?? 0,
  };
});
for (const { ws } of listeners) ws.close();

// --- 5. Verificación en la base ----------------------------------------------
let database = "no verificada (define LOADTEST_DATABASE_URL)";
if (DATABASE_URL) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const ids = [...burstIds, raceTarget.conversationId];
  const { rows } = await client.query(
    `SELECT conversation_id, count(*)::int AS n FROM escalations WHERE conversation_id = ANY($1::uuid[]) GROUP BY 1`,
    [ids]
  );
  const counts = new Map(rows.map((r) => [r.conversation_id, r.n]));
  database = {
    conversationsWithEscalation: rows.length,
    conversationsWithoutEscalation: ids.filter((id) => !counts.has(id)).length,
    conversationsWithMoreThanOne: rows.filter((r) => r.n > 1).length,
    raceConversationEscalations: counts.get(raceTarget.conversationId) ?? 0,
  };
  await client.end();
}

save(`escalations-b${burstCustomers.length}-a${listeners.length}.json`, {
  scenario: "Ráfaga de escalamientos con agentes conectados",
  burst: {
    customers: burstCustomers.length,
    agentsListening: listeners.length,
    httpTotalMs: Number(burstHttpMs.toFixed(0)),
    httpLatencyMs: summarize(httpLatencies),
    statusCodes: statuses,
  },
  delivery: {
    note: "Tiempo desde que cada cliente envió su turno hasta que el aviso llegó a CADA agente conectado.",
    queueEventMs: summarize(queueDelivery),
    workerEscalationEventMs: summarize(workerDelivery),
    expectedPerAgent: expected,
    perAgentMin: {
      queueEventsForBurst: Math.min(...perAgent.map((a) => a.queueEventsForBurst)),
      escalationEvents: Math.min(...perAgent.map((a) => a.escalationEvents)),
    },
    duplicatedEscalationEventsTotal: perAgent.reduce((s, a) => s + a.duplicatedEscalationEvents, 0),
  },
  race: {
    concurrentTurns: RACE,
    statusCodes: raceStatuses,
    escalationEventsPerAgent: [...new Set(perAgent.map((a) => a.raceEscalationEvents))],
  },
  database,
});
process.exit(0);
