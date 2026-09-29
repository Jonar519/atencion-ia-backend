import { Router } from "express";
import { kbController } from "./kb.controller";
import { createArticleSchema, listArticlesQuerySchema, updateArticleSchema } from "./kb.schema";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { adminWriteLimiter } from "../../middlewares/rateLimit.middleware";
import { uuidParams } from "../../utils/schemas";
import { asyncHandler } from "../../utils/asyncHandler";

export const kbRouter = Router();
kbRouter.use(authMiddleware);

const idParams = uuidParams("id");

// Lectura: todo el staff (un agente consulta la KB mientras atiende).
kbRouter.get("/articles", validate({ query: listArticlesQuerySchema }), asyncHandler(kbController.list));
kbRouter.get("/articles/:id", validate({ params: idParams }), asyncHandler(kbController.get));

// Escritura: solo admin.
kbRouter.post(
  "/articles",
  requireRole("admin"),
  adminWriteLimiter,
  validate({ body: createArticleSchema }),
  asyncHandler(kbController.create)
);
kbRouter.patch(
  "/articles/:id",
  requireRole("admin"),
  adminWriteLimiter,
  validate({ params: idParams, body: updateArticleSchema }),
  asyncHandler(kbController.update)
);
kbRouter.delete(
  "/articles/:id",
  requireRole("admin"),
  adminWriteLimiter,
  validate({ params: idParams }),
  asyncHandler(kbController.remove)
);
