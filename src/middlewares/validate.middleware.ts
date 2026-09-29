import { NextFunction, Request, Response } from "express";
import { ZodTypeAny, z } from "zod";
import { ApiError } from "../utils/apiError";

interface RequestSchemas {
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
}

export interface ValidationDetail {
  field: string;
  message: string;
}

function toDetails(error: z.ZodError, prefix: string): ValidationDetail[] {
  return error.issues.map((issue) => ({ field: [prefix, ...issue.path].join("."), message: issue.message }));
}

/**
 * Valida (y normaliza) body/params/query con zod antes de llegar al
 * controller. Los valores parseados reemplazan a los originales, así que el
 * controller solo ve datos ya validados y con los tipos correctos.
 *
 * Error: 400 { error: "Datos inválidos", details: [{ field, message }] }
 */
export function validate(schemas: RequestSchemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const details: ValidationDetail[] = [];

    for (const key of ["params", "query", "body"] as const) {
      const schema = schemas[key];
      if (!schema) continue;
      const result = schema.safeParse(req[key] ?? {});
      if (result.success) {
        // req.query es un getter en Express 5; en Express 4 se puede reasignar.
        (req as unknown as Record<string, unknown>)[key] = result.data;
      } else {
        details.push(...toDetails(result.error, key));
      }
    }

    if (details.length > 0) throw new ApiError(400, "Datos inválidos", details);
    next();
  };
}
