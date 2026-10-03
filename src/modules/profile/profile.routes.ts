import express, { Router } from "express";
import { profileController } from "./profile.controller";
import {
  changeEmailSchema,
  changePasswordSchema,
  mfaCodeSchema,
  mfaDisableSchema,
  updateProfileSchema,
} from "./profile.schema";
import { MAX_AVATAR_BYTES } from "./avatar";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { profileWriteLimiter } from "../../middlewares/rateLimit.middleware";
import { uuidParams } from "../../utils/schemas";
import { asyncHandler } from "../../utils/asyncHandler";

// Todo es sobre la cuenta PROPIA (el id sale del token, nunca de la URL).
export const profileRouter = Router();
profileRouter.use(authMiddleware);

profileRouter.get("/", asyncHandler(profileController.get));
profileRouter.patch(
  "/",
  profileWriteLimiter,
  validate({ body: updateProfileSchema }),
  asyncHandler(profileController.update)
);
profileRouter.post(
  "/email",
  profileWriteLimiter,
  validate({ body: changeEmailSchema }),
  asyncHandler(profileController.requestEmailChange)
);
profileRouter.post(
  "/password",
  profileWriteLimiter,
  validate({ body: changePasswordSchema }),
  asyncHandler(profileController.changePassword)
);

// El avatar llega como el cuerpo CRUDO (image/png|jpeg|webp), ya recortado en el navegador.
// El límite de express.raw corta antes de leer más de la cuenta; el servicio valida los bytes mágicos.
profileRouter.put(
  "/avatar",
  profileWriteLimiter,
  express.raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: MAX_AVATAR_BYTES }),
  asyncHandler(profileController.setAvatar)
);
profileRouter.delete("/avatar", profileWriteLimiter, asyncHandler(profileController.deleteAvatar));

profileRouter.get("/sessions", asyncHandler(profileController.sessions));
profileRouter.post("/sessions/revoke-others", profileWriteLimiter, asyncHandler(profileController.revokeOtherSessions));
profileRouter.delete(
  "/sessions/:id",
  profileWriteLimiter,
  validate({ params: uuidParams("id") }),
  asyncHandler(profileController.revokeSession)
);

profileRouter.get("/export", profileWriteLimiter, asyncHandler(profileController.exportData));

profileRouter.post("/mfa/setup", profileWriteLimiter, asyncHandler(profileController.mfaSetup));
profileRouter.post(
  "/mfa/confirm",
  profileWriteLimiter,
  validate({ body: mfaCodeSchema }),
  asyncHandler(profileController.mfaConfirm)
);
profileRouter.post(
  "/mfa/disable",
  profileWriteLimiter,
  validate({ body: mfaDisableSchema }),
  asyncHandler(profileController.mfaDisable)
);
profileRouter.post(
  "/mfa/backup-codes",
  profileWriteLimiter,
  validate({ body: mfaCodeSchema }),
  asyncHandler(profileController.mfaBackupCodes)
);
