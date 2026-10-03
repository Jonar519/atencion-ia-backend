import express, { Router } from "express";
import { widgetController } from "./widget.controller";
import {
  createConversationSchema,
  createSessionSchema,
  customerMessageSchema,
  widgetMessagesQuerySchema,
} from "./widget.schema";
import { widgetAuth } from "./widgetAuth.middleware";
import { validate } from "../../middlewares/validate.middleware";
import {
  attachmentUploadLimiter,
  customerAiLimiter,
  widgetSessionLimiter,
} from "../../middlewares/rateLimit.middleware";
import { MAX_ATTACHMENT_BYTES } from "../attachments/fileChecks";
import { uuidParams } from "../../utils/schemas";
import { asyncHandler } from "../../utils/asyncHandler";
import { widgetVoiceRouter } from "../voice/voice.routes";

// API pública del widget de cliente. Autenticación: token opaco de sesión
// (widgetAuth); autorización por dueño: cada consulta filtra por el cliente
// de la sesión (widget.service.ts).
export const widgetRouter = Router();

const idParams = uuidParams("id");

// Crear sesión es anónimo: se limita por IP para que no se abran miles.
widgetRouter.post(
  "/sessions",
  widgetSessionLimiter,
  validate({ body: createSessionSchema }),
  asyncHandler(widgetController.createSession)
);

widgetRouter.use(widgetAuth);
widgetRouter.get("/session", asyncHandler(widgetController.currentSession));
widgetRouter.post("/session/end", asyncHandler(widgetController.endSession));
widgetRouter.get("/conversations", asyncHandler(widgetController.listConversations));
widgetRouter.post(
  "/conversations",
  validate({ body: createConversationSchema }),
  asyncHandler(widgetController.createConversation)
);
widgetRouter.get(
  "/conversations/:id/messages",
  validate({ params: idParams, query: widgetMessagesQuerySchema }),
  asyncHandler(widgetController.messages)
);
// Cada mensaje dispara IA (cuesta dinero): límite por sesión desde el primer commit,
// además del tope diario de tokens por cliente (engine/budget.service.ts).
widgetRouter.post(
  "/conversations/:id/messages",
  customerAiLimiter,
  validate({ params: idParams, body: customerMessageSchema }),
  asyncHandler(widgetController.sendMessage)
);

// Adjuntos (bloque C): el cuerpo es el archivo CRUDO; el límite de express.raw corta antes
// de leer más de la cuenta. Un adjunto también es un turno (IA): mismos límites que un mensaje.
widgetRouter.post(
  "/conversations/:id/attachments",
  customerAiLimiter,
  attachmentUploadLimiter,
  validate({ params: idParams }),
  express.raw({
    type: ["image/png", "image/jpeg", "image/webp", "application/pdf"],
    limit: MAX_ATTACHMENT_BYTES,
  }),
  asyncHandler(widgetController.sendAttachment)
);
widgetRouter.get("/attachments/:id", validate({ params: idParams }), asyncHandler(widgetController.attachment));

// Voz (Fase 5): consentimiento, iniciar, consultar y colgar llamadas.
widgetRouter.use(widgetVoiceRouter);
