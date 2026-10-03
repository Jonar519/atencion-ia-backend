// Datos sintéticos para las pruebas de carga (npm run loadtest:setup).
//  - SESSIONS clientes del widget, cada uno con su conversación (envío masivo).
//  - BURST clientes más, con conversación nueva, reservados para la ráfaga de escalamientos.
//  - AGENTS agentes sintéticos (los INVITA el admin del seed y completan su cuenta) que escuchan por WebSocket.
// Todo se guarda en loadtests/.state.json (ignorado por git).
import { adminLogin, api, invitationTokenFor, PASSWORD, writeState } from "./lib.mjs";

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

// Bloque F2: el ÚNICO camino para tener cuenta es la invitación. El admin invita, el enlace se lee del
// correo simulado (email_outbox de la base de CARGA) y el agente completa su cuenta con su contraseña.
const adminToken = await adminLogin();
const agents = await inBatches(AGENTS, 10, async (i) => {
  const email = `carga-${tag}-${i}@load.example`;
  await api("POST", "/api/staff/invitations", {
    token: adminToken,
    body: { name: `Agente de carga ${i}`, email, role: "agent", maxConcurrent: 20 },
  });
  await api("POST", "/api/auth/invitation/accept", {
    body: { token: invitationTokenFor(email), password: PASSWORD },
  });
  return email;
});

writeState({ createdAt: new Date().toISOString(), sessions, burst, agents });
console.log(`Listo: ${sessions.length} sesiones, ${burst.length} para la ráfaga, ${agents.length} agentes.`);
