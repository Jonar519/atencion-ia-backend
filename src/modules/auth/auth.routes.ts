import { Router } from "express";
import { authController } from "./auth.controller";
import {
  confirmEmailSchema,
  enrollmentConfirmSchema,
  enrollmentStartSchema,
  forgotPasswordSchema,
  loginSchema,
  mfaVerifySchema,
  resetPasswordSchema,
} from "./auth.schema";
import { validate } from "../../middlewares/validate.middleware";
import { loginLimiter, mfaLimiter, passwordResetLimiter, sessionLimiter } from "../../middlewares/rateLimit.middleware";
import { csrfProtection } from "../../middlewares/csrf.middleware";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

export const authRouter = Router();

authRouter.post("/login", loginLimiter, validate({ body: loginSchema }), asyncHandler(authController.login));

// Segundo paso del login (el token del paso 1 va en el cuerpo, no en una cookie).
authRouter.post("/mfa/verify", mfaLimiter, validate({ body: mfaVerifySchema }), asyncHandler(authController.verifyMfa));
authRouter.post(
  "/mfa/enroll/start",
  mfaLimiter,
  validate({ body: enrollmentStartSchema }),
  asyncHandler(authController.startEnrollment)
);
authRouter.post(
  "/mfa/enroll/confirm",
  mfaLimiter,
  validate({ body: enrollmentConfirmSchema }),
  asyncHandler(authController.confirmEnrollment)
);

authRouter.post(
  "/forgot-password",
  passwordResetLimiter,
  validate({ body: forgotPasswordSchema }),
  asyncHandler(authController.forgotPassword)
);
authRouter.post(
  "/reset-password",
  passwordResetLimiter,
  validate({ body: resetPasswordSchema }),
  asyncHandler(authController.resetPassword)
);
authRouter.post(
  "/confirm-email",
  passwordResetLimiter,
  validate({ body: confirmEmailSchema }),
  asyncHandler(authController.confirmEmail)
);

// Estas dos se autentican con la cookie: requieren protección CSRF.
authRouter.post("/refresh", sessionLimiter, csrfProtection, asyncHandler(authController.refresh));
authRouter.post("/logout", sessionLimiter, csrfProtection, asyncHandler(authController.logout));

authRouter.get("/me", authMiddleware, asyncHandler(authController.me));
