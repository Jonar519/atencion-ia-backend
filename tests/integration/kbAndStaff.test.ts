import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, authHeader, csrfHeader, freshIp, login, staffSession, unique } from "../helpers";
import { prisma } from "../../src/config/prisma";

const article = () => ({
  slug: `articulo-${unique().replace(/\D/g, "")}`,
  title: "Cómo bloquear la tarjeta",
  body: "Entra a la app, elige la tarjeta y pulsa Bloquear.",
  category: "Tarjetas",
  tags: ["tarjeta", "Bloqueo", "tarjeta"],
});

describe("base de conocimiento (admin)", () => {
  it("crea un artículo normalizando categoría y etiquetas, y registra quién lo creó", async () => {
    const { staff, token } = await staffSession("admin");
    const res = await request(app).post("/api/kb/articles").set(authHeader(token)).send(article());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ category: "tarjetas", tags: ["tarjeta", "bloqueo"], status: "draft", version: 1 });
    expect(res.body.createdBy.id).toBe(staff.id);
    expect(res.body.publishedAt).toBeNull();
  });

  it("editar el cuerpo sube la versión; publicar fija published_at", async () => {
    const { token } = await staffSession("admin");
    const created = await request(app).post("/api/kb/articles").set(authHeader(token)).send(article());
    const id = created.body.id;

    const tagsOnly = await request(app)
      .patch(`/api/kb/articles/${id}`)
      .set(authHeader(token))
      .send({ tags: ["x"] });
    expect(tagsOnly.body.version).toBe(1);
    const edited = await request(app)
      .patch(`/api/kb/articles/${id}`)
      .set(authHeader(token))
      .send({ body: "Nuevo cuerpo con más detalle del procedimiento.", status: "published" });
    expect(edited.body.version).toBe(2);
    expect(edited.body.publishedAt).not.toBeNull();
  });

  it("slug duplicado es 409; slug inválido o campo no declarado es 400", async () => {
    const { token } = await staffSession("admin");
    const data = article();
    await request(app).post("/api/kb/articles").set(authHeader(token)).send(data);
    expect((await request(app).post("/api/kb/articles").set(authHeader(token)).send(data)).status).toBe(409);
    expect(
      (
        await request(app)
          .post("/api/kb/articles")
          .set(authHeader(token))
          .send({ ...article(), slug: "Con Espacios" })
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/kb/articles")
          .set(authHeader(token))
          .send({ ...article(), version: 99 })
      ).status
    ).toBe(400);
  });

  it("no se puede crear un artículo ya archivado", async () => {
    const { token } = await staffSession("admin");
    const res = await request(app)
      .post("/api/kb/articles")
      .set(authHeader(token))
      .send({ ...article(), status: "archived" });
    expect(res.status).toBe(400);
  });

  it("borrar un artículo deja las citas viejas sin romper (article_id → NULL)", async () => {
    const { token } = await staffSession("admin");
    const created = await request(app).post("/api/kb/articles").set(authHeader(token)).send(article());
    const customer = await prisma.customer.create({ data: {} });
    const conversation = await prisma.conversation.create({ data: { customerId: customer.id, originChannel: "text" } });
    const message = await prisma.message.create({
      data: { conversationId: conversation.id, senderType: "ai", content: "Respuesta" },
    });
    await prisma.messageCitation.create({
      data: { messageId: message.id, rank: 1, articleId: created.body.id, articleVersion: 1, score: 0.9 },
    });

    expect((await request(app).delete(`/api/kb/articles/${created.body.id}`).set(authHeader(token))).status).toBe(204);
    const citation = await prisma.messageCitation.findFirstOrThrow({ where: { messageId: message.id } });
    expect(citation.articleId).toBeNull();
    expect((await request(app).get(`/api/kb/articles/${created.body.id}`).set(authHeader(token))).status).toBe(404);
  });
});

describe("gestión del staff (admin)", () => {
  it("aplica la política de contraseñas al crear una cuenta", async () => {
    const { token } = await staffSession("admin");
    const res = await request(app)
      .post("/api/staff")
      .set(authHeader(token))
      .send({ name: "Nuevo Agente", email: `nuevo-${unique()}@test.example`, password: "Password123!" });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: "body.password" })]));
  });

  it("crea una cuenta que puede iniciar sesión, sin devolver el hash", async () => {
    const { token } = await staffSession("admin");
    const email = `nuevo-${unique()}@test.example`;
    const password = "tres palabras largas y raras";
    const res = await request(app)
      .post("/api/staff")
      .set(authHeader(token))
      .send({ name: "Nuevo Agente", email, password });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("passwordHash");
    expect((await login(email, password)).token).toEqual(expect.any(String));
  });

  it("desactivar a un agente cierra sus sesiones (el refresh deja de funcionar)", async () => {
    const admin = await staffSession("admin");
    const agent = await staffSession("agent");
    const res = await request(app)
      .patch(`/api/staff/${agent.staff.id}`)
      .set(authHeader(admin.token))
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.availability).toBe("offline");
    const refresh = await request(app)
      .post("/api/auth/refresh")
      .set("X-Forwarded-For", freshIp())
      .set("Cookie", agent.cookie)
      .set(csrfHeader);
    expect(refresh.status).toBe(401);
  });

  it("un admin no puede desactivarse ni quitarse el rol a sí mismo", async () => {
    const { staff, token } = await staffSession("admin");
    expect(
      (await request(app).patch(`/api/staff/${staff.id}`).set(authHeader(token)).send({ isActive: false })).status
    ).toBe(409);
    expect(
      (await request(app).patch(`/api/staff/${staff.id}`).set(authHeader(token)).send({ role: "agent" })).status
    ).toBe(409);
  });

  it("cualquier miembro del staff cambia SU disponibilidad (y solo la suya)", async () => {
    const { staff, token } = await staffSession("agent");
    const res = await request(app)
      .patch("/api/staff/me/availability")
      .set(authHeader(token))
      .send({ availability: "available" });
    expect(res.status).toBe(200);
    expect((await prisma.staffUser.findUniqueOrThrow({ where: { id: staff.id } })).availability).toBe("available");
    const invalid = await request(app)
      .patch("/api/staff/me/availability")
      .set(authHeader(token))
      .send({ availability: "fiesta" });
    expect(invalid.status).toBe(400);
  });
});
