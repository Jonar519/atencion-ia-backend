import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { randomUUID } from "crypto";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { authRouter } from "./modules/auth/auth.routes";
import { staffRouter } from "./modules/staff/staff.routes";
import { kbRouter } from "./modules/kb/kb.routes";
import { conversationsRouter } from "./modules/conversations/conversations.routes";
import { errorMiddleware, notFoundMiddleware } from "./middlewares/error.middleware";
import { globalLimiter } from "./middlewares/rateLimit.middleware";
import { healthHandler, readyHandler } from "./observability/health";
import { httpMetricsMiddleware, metricsHandler } from "./observability/metrics";

export function createApp() {
  const app = express();

  app.set("trust proxy", env.trustProxy);
  app.disable("x-powered-by");

  // Primero: mide también las respuestas de helmet, CORS y los rate limiters.
  app.use(httpMetricsMiddleware);

  // Id de correlación por petición: se devuelve en X-Request-Id y va en el log
  // de acceso, para poder cruzar un error que reporta un usuario con el log.
  app.use((req, res, next) => {
    const incoming = req.get("x-request-id");
    const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.set("X-Request-Id", id);
    res.locals.requestId = id;
    next();
  });

  // La API solo sirve JSON: los defaults de helmet son correctos (CSP
  // default-src 'self', nosniff, frame-ancestors 'none', Referrer-Policy
  // no-referrer, HSTS detrás de HTTPS, CORP same-origin).
  app.use(helmet());
  app.use(compression({ threshold: 1024 }));
  // credentials: true para que el navegador envíe la cookie de refresh a
  // /api/auth (solo a los orígenes listados en CORS_ORIGIN).
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: "100kb" }));

  // Log de acceso estructurado (fuera de tests). Sin headers, sin query ni
  // cuerpo: solo método, ruta, estado, duración y el id de correlación.
  if (env.nodeEnv !== "test") {
    app.use((req, res, next) => {
      const start = process.hrtime.bigint();
      res.on("finish", () => {
        logger.info(
          {
            requestId: res.locals.requestId,
            method: req.method,
            // originalUrl (sin query): req.path es relativo al sub-router
            // ("/login" en vez de "/api/auth/login") y confunde al buscar en los logs.
            path: req.originalUrl.split("?")[0],
            status: res.statusCode,
            durationMs: Number(process.hrtime.bigint() - start) / 1e6,
            staffId: req.user?.staffId,
          },
          "http"
        );
      });
      next();
    });
  }

  // NINGUNA respuesta de la API se guarda en cachés (datos personales de
  // clientes y estado que cambia a cada segundo).
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // Sondas y métricas: fuera de /api (sin rate limit ni auth de usuario).
  app.get("/health", healthHandler);
  app.get("/ready", readyHandler);
  app.get("/metrics", metricsHandler);

  app.use("/api", globalLimiter);
  app.use("/api/auth", authRouter);
  app.use("/api/staff", staffRouter);
  app.use("/api/kb", kbRouter);
  app.use("/api/conversations", conversationsRouter);

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
