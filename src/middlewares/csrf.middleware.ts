import { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { ApiError } from "../utils/apiError";

/**
 * Protección CSRF para las rutas que se autentican con la cookie de sesión
 * (/api/auth/refresh y /api/auth/logout). El resto de la API usa el header
 * Authorization, que un sitio ajeno no puede poner, así que no es vulnerable.
 *
 * Dos capas, además de SameSite=Strict en la cookie:
 *  1. Header personalizado X-Requested-With: atencion-ia. Un formulario HTML
 *     de otro sitio no puede enviar headers, y un fetch con headers propios a
 *     otro origen dispara un preflight CORS que la API solo aprueba para los
 *     orígenes de CORS_ORIGIN.
 *  2. Si el navegador manda Origin, debe estar en CORS_ORIGIN.
 */
export const CSRF_HEADER = "x-requested-with";
export const CSRF_HEADER_VALUE = "atencion-ia";

export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (req.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
    throw new ApiError(403, "Solicitud rechazada (falta el encabezado anti-CSRF)");
  }
  const origin = req.get("origin");
  if (origin && !env.corsOrigins.includes(origin)) {
    throw new ApiError(403, "Solicitud rechazada (origen no permitido)");
  }
  next();
}
