import express, { Router } from "express";
import { conversationsController } from "./conversations.controller";
import {
  closeConversationSchema,
  reassignConversationSchema,
  listConversationsQuerySchema,
  messagesQuerySchema,
  sendMessageSchema,
} from "./conversations.schema";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate.middleware";
import {
  adminWriteLimiter,
  agentMessageLimiter,
  attachmentUploadLimiter,
} from "../../middlewares/rateLimit.middleware";
import { MAX_ATTACHMENT_BYTES } from "../attachments/fileChecks";
import { z } from "zod";
import { requireRole } from "../../middlewares/role.middleware";
import { uuidParams, uuidSchema } from "../../utils/schemas";
import { asyncHandler } from "../../utils/asyncHandler";

// Autorización por dueño: cada operación del service aplica conversationScope
// (conversations.access.ts). Aquí solo se exige estar autenticado.
export const conversationsRouter = Router();
conversationsRouter.use(authMiddleware);

const idParams = uuidParams("id");

conversationsRouter.get(
  "/",
  validate({ query: listConversationsQuerySchema }),
  asyncHandler(conversationsController.list)
);
conversationsRouter.get("/:id", validate({ params: idParams }), asyncHandler(conversationsController.get));
conversationsRouter.get(
  "/:id/messages",
  validate({ params: idParams, query: messagesQuerySchema }),
  asyncHandler(conversationsController.messages)
);
conversationsRouter.post("/:id/take", validate({ params: idParams }), asyncHandler(conversationsController.take));
// Solo admin: mover un caso atendido a otro agente (requisito para eliminar una cuenta).
conversationsRouter.post(
  "/:id/reassign",
  requireRole("admin"),
  adminWriteLimiter,
  validate({ params: idParams, body: reassignConversationSchema }),
  asyncHandler(conversationsController.reassign)
);
conversationsRouter.post(
  "/:id/close",
  validate({ params: idParams, body: closeConversationSchema }),
  asyncHandler(conversationsController.close)
);
conversationsRouter.post(
  "/:id/messages",
  agentMessageLimiter,
  validate({ params: idParams, body: sendMessageSchema }),
  asyncHandler(conversationsController.sendMessage)
);

// Adjuntos (bloque C): el cuerpo es el archivo crudo (imagen o PDF).
conversationsRouter.post(
  "/:id/attachments",
  agentMessageLimiter,
  attachmentUploadLimiter,
  validate({ params: idParams }),
  express.raw({
    type: ["image/png", "image/jpeg", "image/webp", "application/pdf"],
    limit: MAX_ATTACHMENT_BYTES,
  }),
  asyncHandler(conversationsController.sendAttachment)
);
conversationsRouter.get(
  "/:id/attachments/:attachmentId",
  validate({ params: z.object({ id: uuidSchema, attachmentId: uuidSchema }).strict() }),
  asyncHandler(conversationsController.attachment)
);
