import { Router } from "express";
import { voiceController } from "./voice.controller";
import { startCallSchema } from "./voice.schema";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { callStaffLimiter, callStartLimiter } from "../../middlewares/rateLimit.middleware";
import { uuidParams } from "../../utils/schemas";
import { asyncHandler } from "../../utils/asyncHandler";

const idParams = uuidParams("id");

/**
 * Rutas de voz del CLIENTE. Se montan dentro de widgetRouter, después de
 * widgetAuth (cookie o Bearer wgt_…): el servicio filtra por el cliente de la sesión.
 */
export const widgetVoiceRouter = Router();
widgetVoiceRouter.get("/voice/consent", voiceController.consent);
widgetVoiceRouter.post(
  "/conversations/:id/calls",
  callStartLimiter,
  validate({ params: idParams, body: startCallSchema }),
  asyncHandler(voiceController.start)
);
widgetVoiceRouter.get("/calls/:id", validate({ params: idParams }), asyncHandler(voiceController.getForCustomer));
widgetVoiceRouter.post("/calls/:id/end", validate({ params: idParams }), asyncHandler(voiceController.endByCustomer));

/** Rutas de voz del STAFF (/api/calls). Autorización por dueño del caso en el servicio. */
export const callsRouter = Router();
callsRouter.use(authMiddleware);
callsRouter.get("/active", asyncHandler(voiceController.active));
callsRouter.get("/:id/transcript", validate({ params: idParams }), asyncHandler(voiceController.transcript));
callsRouter.post("/:id/join", callStaffLimiter, validate({ params: idParams }), asyncHandler(voiceController.join));
callsRouter.post("/:id/leave", callStaffLimiter, validate({ params: idParams }), asyncHandler(voiceController.leave));
callsRouter.post(
  "/:id/end",
  callStaffLimiter,
  validate({ params: idParams }),
  asyncHandler(voiceController.endByStaff)
);
