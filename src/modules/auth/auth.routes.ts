import { Router } from "express";
import { authController } from "./auth.controller";
import { loginSchema } from "./auth.schema";
import { validate } from "../../middlewares/validate.middleware";
import { loginLimiter, sessionLimiter } from "../../middlewares/rateLimit.middleware";
import { csrfProtection } from "../../middlewares/csrf.middleware";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

export const authRouter = Router();

authRouter.post("/login", loginLimiter, validate({ body: loginSchema }), asyncHandler(authController.login));

// Estas dos se autentican con la cookie: requieren protección CSRF.
authRouter.post("/refresh", sessionLimiter, csrfProtection, asyncHandler(authController.refresh));
authRouter.post("/logout", sessionLimiter, csrfProtection, asyncHandler(authController.logout));

authRouter.get("/me", authMiddleware, asyncHandler(authController.me));
