import { Router } from "express";
import { staffController } from "./staff.controller";
import { availabilitySchemaBody, createStaffSchema, updateStaffSchema } from "./staff.schema";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { adminWriteLimiter } from "../../middlewares/rateLimit.middleware";
import { uuidParams } from "../../utils/schemas";
import { asyncHandler } from "../../utils/asyncHandler";

export const staffRouter = Router();
staffRouter.use(authMiddleware);

// Cualquier miembro del staff: su propia disponibilidad (va antes de "/:id").
staffRouter.patch(
  "/me/availability",
  validate({ body: availabilitySchemaBody }),
  asyncHandler(staffController.setMyAvailability)
);

// Solo admin: gestión de cuentas.
staffRouter.get("/", requireRole("admin"), asyncHandler(staffController.list));
staffRouter.post(
  "/",
  requireRole("admin"),
  adminWriteLimiter,
  validate({ body: createStaffSchema }),
  asyncHandler(staffController.create)
);
staffRouter.patch(
  "/:id",
  requireRole("admin"),
  adminWriteLimiter,
  validate({ params: uuidParams("id"), body: updateStaffSchema }),
  asyncHandler(staffController.update)
);
