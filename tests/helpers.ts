import request from "supertest";
import bcrypt from "bcrypt";
import type { ConversationStatus, StaffRole } from "@prisma/client";
import { createApp } from "../src/app";
import { prisma } from "../src/config/prisma";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "../src/middlewares/csrf.middleware";

export const app = createApp();

// Cumple la política de contraseñas (src/modules/auth/passwordPolicy.ts).
export const TEST_PASSWORD = "Llave-Segura-Pruebas-2026";
// Hash precalculado (costo 4: solo tests) para crear staff rápido directo en la base.
const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

let counter = 0;
/** Sufijo único: los tests comparten la base de datos. */
export function unique(): string {
  counter += 1;
  return `${Date.now()}-${counter}`;
}

let ipCounter = 0;
/** IP distinta por llamada (X-Forwarded-For + TRUST_PROXY=1): aísla los rate limiters por IP. */
export function freshIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export const csrfHeader = { [CSRF_HEADER]: CSRF_HEADER_VALUE };

export async function createStaff(
  role: StaffRole = "agent",
  overrides: { isActive?: boolean; maxConcurrent?: number } = {}
) {
  return prisma.staffUser.create({
    data: {
      name: `${role === "admin" ? "Admin" : "Agente"} ${unique()}`,
      email: `${role}-${unique()}@test.example`,
      passwordHash: TEST_PASSWORD_HASH,
      role,
      isActive: overrides.isActive ?? true,
      maxConcurrent: overrides.maxConcurrent ?? 3,
    },
  });
}

/** Inicia sesión por la API y devuelve el access token y la cookie de refresh. */
export async function login(email: string, password = TEST_PASSWORD) {
  const res = await request(app).post("/api/auth/login").set("X-Forwarded-For", freshIp()).send({ email, password });
  if (res.status !== 200) throw new Error(`login falló (${res.status}): ${JSON.stringify(res.body)}`);
  const cookie = [res.headers["set-cookie"]].flat().find((c) => c?.startsWith("atencion_ia_refresh="));
  return { token: res.body.accessToken as string, cookie: cookie!.split(";")[0]!, res };
}

/** Crea un miembro del staff y le inicia sesión. */
export async function staffSession(role: StaffRole = "agent", overrides: { maxConcurrent?: number } = {}) {
  const staff = await createStaff(role, overrides);
  const { token, cookie } = await login(staff.email);
  return { staff, token, cookie };
}

/**
 * Crea una conversación en el estado pedido, coherente con los CHECKs del
 * esquema (agent_active ⇒ agente; closed ⇒ fecha y motivo), con un mensaje
 * del cliente y, si está en cola o atendida, su escalamiento abierto.
 */
export async function createConversation(status: ConversationStatus, assignedAgentId: string | null = null) {
  const customer = await prisma.customer.create({ data: { displayName: `Cliente ${unique()}` } });
  const conversation = await prisma.conversation.create({
    data: {
      customerId: customer.id,
      status,
      assignedAgentId,
      originChannel: "text",
      subject: "Prueba",
      priority: status === "waiting_agent" ? 50 : 0,
      // Ambas fechas del MISMO reloj: con closedAt de Node y createdAt de la base, el
      // desfase entre relojes (medido: ~1 ms) viola chk_conversations_closed_after_created.
      ...(status === "closed"
        ? (() => {
            const at = new Date();
            return { createdAt: at, closedAt: at, closeReason: "resolved_by_ai" as const };
          })()
        : {}),
    },
  });
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      senderType: "customer",
      content: "Hola, necesito ayuda con mi tarjeta",
      intent: "general_inquiry",
      sentiment: "neutral",
    },
  });
  if (status === "waiting_agent" || status === "agent_active") {
    const escalation = await prisma.escalation.create({
      data: {
        conversationId: conversation.id,
        triggeringMessageId: message.id,
        triggerSource: "customer_request",
        reason: "human_requested",
      },
    });
    if (status === "agent_active") {
      // assigned_at con el reloj de la base (ver src/utils/dbTime.ts).
      await prisma.$executeRaw`
        UPDATE escalations
        SET status = 'assigned', assigned_agent_id = ${assignedAgentId}::uuid, assigned_at = now()
        WHERE id = ${escalation.id}::uuid`;
    }
  }
  return { conversation, customer, message };
}

// ---------------------------------------------------------------------------
// Fase 3: widget del cliente y base de conocimiento indexada
// ---------------------------------------------------------------------------

export function widgetHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** Sesión anónima del widget (IP propia para no gastar el cupo de otros tests). */
export async function widgetSession(displayName = "Cliente de prueba") {
  const res = await request(app).post("/api/widget/sessions").set("X-Forwarded-For", freshIp()).send({ displayName });
  if (res.status !== 201) throw new Error(`widgetSession falló (${res.status}): ${JSON.stringify(res.body)}`);
  return { token: res.body.token as string, customerId: res.body.customerId as string };
}

export async function widgetConversation(token: string) {
  const res = await request(app).post("/api/widget/conversations").set(widgetHeader(token)).send({});
  if (res.status !== 201) throw new Error(`widgetConversation falló (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

export function sendCustomerMessage(token: string, conversationId: string, content: string, clientMsgId?: string) {
  return request(app)
    .post(`/api/widget/conversations/${conversationId}/messages`)
    .set(widgetHeader(token))
    .send(clientMsgId ? { content, clientMsgId } : { content });
}

/** Artículo publicado (o en el estado pedido) ya indexado con el proveedor mock. */
export async function kbArticle(title: string, body: string, status: "published" | "draft" | "archived" = "published") {
  const { indexArticle } = await import("../src/modules/rag/indexing.service");
  const article = await prisma.kbArticle.create({
    data: {
      slug: `art-${unique().replace(/\D/g, "")}`,
      title,
      body,
      category: "pruebas",
      status,
      publishedAt: status === "draft" ? null : new Date(),
    },
  });
  await indexArticle(article.id);
  return article;
}
