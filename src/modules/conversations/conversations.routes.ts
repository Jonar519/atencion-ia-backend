import { Router } from "express";
import { conversationsController } from "./conversations.controller";
import {
  closeConversationSchema,
  listConversationsQuerySchema,
  messagesQuerySchema,
  sendMessageSchema,
} from "./conversations.schema";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { agentMessageLimiter } from "../../middlewares/rateLimit.middleware";
import { uuidParams } from "../../utils/schemas";
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
