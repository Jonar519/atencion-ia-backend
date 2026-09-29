import { NextFunction, Request, Response } from "express";
import type { StaffRole } from "@prisma/client";
import { ApiError } from "../utils/apiError";

/**
 * Autorización por ROL (qué tipo de acción puede hacer). La autorización por
 * DUEÑO (sobre qué conversación) vive en conversations.access.ts.
 * Debe ir después de authMiddleware.
 */
export function requireRole(...roles: StaffRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new ApiError(403, "No tienes permisos para realizar esta acción");
    }
    next();
  };
}
