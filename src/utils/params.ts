import { Request } from "express";
import { ApiError } from "./apiError";

/**
 * Lee un parámetro de ruta como string. Con noUncheckedIndexedAccess,
 * req.params[x] es `string | undefined`; las rutas ya lo validan con zod,
 * así que el 400 aquí es solo una red de seguridad.
 */
export function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (!value) throw new ApiError(400, `Falta el parámetro de ruta "${name}"`);
  return value;
}

/** Usuario autenticado; authMiddleware ya garantizó que existe. */
export function currentUser(req: Request) {
  if (!req.user) throw new ApiError(401, "No autenticado");
  return req.user;
}
