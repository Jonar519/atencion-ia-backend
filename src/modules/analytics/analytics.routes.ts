import { Request, Response, Router } from "express";
import { z } from "zod";
import { analyticsService } from "./analytics.service";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { asyncHandler } from "../../utils/asyncHandler";

const querySchema = z
  .object({
    days: z
      .enum(["1", "7", "30", "90"])
      .default("7")
      .transform((value) => Number(value)),
  })
  .strict();

// Solo admin: métricas del servicio (sin datos personales).
export const analyticsRouter = Router();
analyticsRouter.use(authMiddleware, requireRole("admin"));

analyticsRouter.get(
  "/",
  validate({ query: querySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { days } = req.query as unknown as { days: number };
    res.json({ days, ...(await analyticsService.summary(await analyticsService.lastDays(days))) });
  })
);
