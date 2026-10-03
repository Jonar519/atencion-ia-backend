import { Request, Response, Router } from "express";
import { cannedService } from "./canned.service";
import { createCannedSchema, listCannedQuerySchema, updateCannedSchema } from "./canned.schema";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { adminWriteLimiter } from "../../middlewares/rateLimit.middleware";
import { audit } from "../../services/audit/audit.service";
import { uuidParams } from "../../utils/schemas";
import { asyncHandler } from "../../utils/asyncHandler";
import { ApiError } from "../../utils/apiError";
import { currentUser, routeParam } from "../../utils/params";

export const cannedRouter = Router();
cannedRouter.use(authMiddleware);

const idParams = uuidParams("id");

// Lectura: todo el staff (el asesor las inserta). Las desactivadas, solo un admin.
cannedRouter.get(
  "/",
  validate({ query: listCannedQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { includeInactive } = req.query as { includeInactive?: boolean };
    if (includeInactive && currentUser(req).role !== "admin") {
      throw new ApiError(403, "No tienes permisos para ver las respuestas desactivadas");
    }
    res.json(await cannedService.list({ includeInactive }));
  })
);

// Escritura: solo admin.
cannedRouter.post(
  "/",
  requireRole("admin"),
  adminWriteLimiter,
  validate({ body: createCannedSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const item = await cannedService.create(currentUser(req).staffId, req.body);
    audit(req, { action: "canned.create", entityType: "canned_response", entityId: item.id });
    res.status(201).json(item);
  })
);
cannedRouter.patch(
  "/:id",
  requireRole("admin"),
  adminWriteLimiter,
  validate({ params: idParams, body: updateCannedSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = routeParam(req, "id");
    const item = await cannedService.update(currentUser(req).staffId, id, req.body);
    audit(req, {
      action: "canned.update",
      entityType: "canned_response",
      entityId: id,
      metadata: { fields: Object.keys(req.body) },
    });
    res.json(item);
  })
);
cannedRouter.delete(
  "/:id",
  requireRole("admin"),
  adminWriteLimiter,
  validate({ params: idParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = routeParam(req, "id");
    await cannedService.remove(id);
    audit(req, { action: "canned.delete", entityType: "canned_response", entityId: id });
    res.status(204).end();
  })
);
