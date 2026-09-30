// Datos sintéticos para las pruebas de carga (npm run loadtest:setup).
//  - SESSIONS clientes del widget, cada uno con su conversación (envío masivo).
//  - BURST clientes más, con conversación nueva, reservados para la ráfaga de escalamientos.
//  - AGENTS agentes sintéticos (los crea el admin del seed) que escuchan por WebSocket.
// Todo se guarda en loadtests/.state.json (ignorado por git).
import { api, PASSWORD, SEED_ADMIN, staffLogin, writeState } from "./lib.mjs";

const SESSIONS = Number(process.env.LOADTEST_SESSIONS || 100);
const BURST = Number(process.env.LOADTEST_BURST || 200);
const AGENTS = Number(process.env.LOADTEST_AGENTS || 20);

async function customer(label) {
  const session = await api("POST", "/api/widget/sessions", { body: { displayName: label } });
  const conversation = await api("POST", "/api/widget/conversations", { token: session.token, body: {} });
  return { token: session.token, conversationId: conversation.id };
}

async function inBatches(count, size, make) {
  const out = [];
  for (let start = 0; start < count; start += size) {
    const batch = await Promise.all(Array.from({ length: Math.min(size, count - start) }, (_, i) => make(start + i)));
    out.push(...batch);
  }
  return out;
}

const tag = Date.now().toString(36);
const sessions = await inBatches(SESSIONS, 20, (i) => customer(`Carga ${i}`));
const burst = await inBatches(BURST, 20, (i) => customer(`Ráfaga ${i}`));

const adminToken = await staffLogin(SEED_ADMIN.email, SEED_ADMIN.password);
const agents = await inBatches(AGENTS, 10, async (i) => {
  const email = `carga-${tag}-${i}@load.example`;
  await api("POST", "/api/staff", {
    token: adminToken,
    body: { name: `Agente de carga ${i}`, email, password: PASSWORD, role: "agent", maxConcurrent: 20 },
  });
  return email;
});

writeState({ createdAt: new Date().toISOString(), sessions, burst, agents });
console.log(`Listo: ${sessions.length} sesiones, ${burst.length} para la ráfaga, ${agents.length} agentes.`);
