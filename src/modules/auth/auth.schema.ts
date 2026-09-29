import { z } from "zod";
import "../../utils/schemas";

// No hay registro público: las cuentas del staff las crea un admin
// (POST /api/staff). Aquí solo se inicia sesión.
export const loginSchema = z
  .object({
    email: z.string().trim().email().max(254),
    // Sin aplicar la política aquí: el seed y cuentas antiguas pueden no cumplirla.
    password: z.string().min(1).max(200),
  })
  .strict();
