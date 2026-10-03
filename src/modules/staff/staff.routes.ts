import { Router } from "express";
import { staffController } from "./staff.controller";
import { profileController } from "../profile/profile.controller";
import { availabilitySchemaBody, inviteStaffSchema, updateStaffSchema } from "./staff.schema";
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

// Cualquier miembro del staff: el avatar de un compañero (el panel lo muestra).
staffRouter.get("/:id/avatar", validate({ params: uuidParams("id") }), asyncHandler(profileController.getAvatar));

// Solo admin: gestión de cuentas.
staffRouter.get("/", requireRole("admin"), asyncHandler(staffController.list));
// Alta SOLO por invitación (bloque F2): no hay ruta para crear una cuenta con contraseña.
staffRouter.post(
  "/invitations",
  requireRole("admin"),
  adminWriteLimiter,
  validate({ body: inviteStaffSchema }),
  asyncHandler(staffController.invite)
);
staffRouter.post(
  "/:id/invitation/resend",
  requireRole("admin"),
  adminWriteLimiter,
  validate({ params: uuidParams("id") }),
  asyncHandler(staffController.resendInvitation)
);
staffRouter.delete(
  "/:id/invitation",
  requireRole("admin"),
  adminWriteLimiter,
  validate({ params: uuidParams("id") }),
  asyncHandler(staffController.cancelInvitation)
);
staffRouter.patch(
  "/:id",
  requireRole("admin"),
  adminWriteLimiter,
  validate({ params: uuidParams("id"), body: updateStaffSchema }),
  asyncHandler(staffController.update)
);
staffRouter.get(
  "/:id/export",
  requireRole("admin"),
  adminWriteLimiter,
  validate({ params: uuidParams("id") }),
  asyncHandler(staffController.exportData)
);
staffRouter.post(
  "/:id/anonymize",
  requireRole("admin"),
  adminWriteLimiter,
  validate({ params: uuidParams("id") }),
  asyncHandler(staffController.anonymize)
);
