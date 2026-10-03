import "dotenv/config";
import { hkdfSync } from "crypto";
import { z } from "zod";

/**
 * Configuración validada con zod al arrancar: si falta o sobra algo peligroso,
 * el proceso no arranca (mejor fallar al inicio que a mitad de una petición).
 */

const nodeEnv = z.enum(["development", "test", "production"]).default("development").parse(process.env.NODE_ENV);
const isProduction = nodeEnv === "production";

const secret = (name: string) =>
  z
    .string({ required_error: `Falta la variable de entorno ${name}. Revisa tu archivo .env` })
    .min(32, `${name} debe tener al menos 32 caracteres`);

const positiveInt = (fallback: number) => z.coerce.number().int().min(1).default(fallback);

const iceServersSchema = z
  .array(
    z
      .object({
        urls: z.union([z.string().regex(/^(stun|turns?):/), z.array(z.string().regex(/^(stun|turns?):/)).min(1)]),
        username: z.string().optional(),
        credential: z.string().optional(),
      })
      .strict()
  )
  .max(5);

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const schema = z
  .object({
    PORT: positiveInt(4100),
    DATABASE_URL: z.string({ required_error: "Falta DATABASE_URL. Revisa tu archivo .env" }).url(),
    REDIS_URL: z.string().url().default("redis://localhost:6380"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default(nodeEnv === "test" ? "silent" : "info"),

    JWT_SECRET: secret("JWT_SECRET"),
    JWT_EXPIRES_IN: z
      .string()
      .regex(/^\d+[smh]$/, 'JWT_EXPIRES_IN debe tener la forma "15m", "900s" o "1h"')
      .default("15m"),
    REFRESH_TOKEN_TTL_DAYS: positiveInt(7),
    COOKIE_SECURE: z.enum(["true", "false"]).default(isProduction ? "true" : "false"),
    IP_HASH_SECRET: secret("IP_HASH_SECRET"),

    // Orígenes permitidos por CORS, separados por coma. Obligatorio en producción.
    CORS_ORIGIN: isProduction ? z.string().min(1) : z.string().default("http://localhost:5174"),
    // Número de proxies delante de la app (para que el rate limiting vea la IP real).
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    // Multiplicador de TODOS los rate limits. Solo para pruebas de carga.
    RATE_LIMIT_SCALE: z.coerce.number().min(1).default(1),

    // Vacío = /metrics desactivado (404).
    METRICS_TOKEN: z.string().optional(),
    SHUTDOWN_TIMEOUT_MS: positiveInt(10_000),
    SHUTDOWN_DRAIN_DELAY_MS: z.coerce.number().int().min(0).default(0),

    // --- IA ---
    // "mock" (por defecto): determinista, sin costo ni credenciales (desarrollo, tests, CI, carga).
    // "anthropic": Claude para respuestas e intención + Voyage AI para embeddings.
    AI_PROVIDER: z.enum(["mock", "anthropic"]).default("mock"),
    ANTHROPIC_API_KEY: z.string().optional(),
    VOYAGE_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().min(1).default("claude-opus-5-5"),
    ANTHROPIC_CLASSIFIER_MODEL: z.string().min(1).default("claude-opus-5-5"),
    VOYAGE_MODEL: z.string().min(1).default("voyage-3.5"),
    AI_TIMEOUT_MS: positiveInt(20_000),
    // Solo con AI_PROVIDER=mock: latencia artificial por llamada (pruebas de carga).
    AI_MOCK_LATENCY_MS: z.coerce.number().int().min(0).default(0),
    // RAG: fragmentos por respuesta y similitud coseno mínima para usarlos.
    // (Los umbrales dependen del modelo de embeddings: ver docs/rag.md.)
    RAG_TOP_K: z.coerce.number().int().min(1).max(10).default(4),
    RAG_MIN_SCORE: z.coerce.number().min(-1).max(1).optional(),
    // Tope diario de tokens de IA por cliente (defensa contra agotar créditos).
    AI_DAILY_TOKEN_BUDGET_PER_CUSTOMER: positiveInt(60_000),
    // Vida de la sesión anónima del widget.
    WIDGET_SESSION_TTL_HOURS: positiveInt(24),
    // Worker (BullMQ): concurrencia y puerto de sus métricas/sondas.
    WORKER_CONCURRENCY: positiveInt(2),
    WORKER_METRICS_PORT: positiveInt(9465),

    // --- Voz (Fase 5) ---
    // "mock" (por defecto): transcripción y síntesis simuladas, sin costo ni credenciales.
    // "deepgram": STT en streaming (Nova-3) y TTS (Aura-2) de Deepgram, con una sola API key.
    VOICE_PROVIDER: z.enum(["mock", "deepgram"]).default("mock"),
    DEEPGRAM_API_KEY: z.string().optional(),
    DEEPGRAM_STT_MODEL: z.string().min(1).default("nova-3"),
    DEEPGRAM_LANGUAGE: z.string().min(2).default("es"),
    // Voz de Aura-2 en español (celeste: acento colombiano). Ver docs/adr/0011.
    DEEPGRAM_TTS_MODEL: z.string().min(1).default("aura-2-celeste-es"),
    VOICE_TIMEOUT_MS: positiveInt(15_000),
    // Retención de la transcripción (docs/privacy-voice.md). La base impone un máximo de 180.
    VOICE_TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().min(1).max(180).default(90),
    VOICE_MAX_CALL_SECONDS: positiveInt(900),
    // Tope diario de audio transcrito por cliente (defensa contra agotar créditos por voz).
    VOICE_DAILY_SECONDS_PER_CUSTOMER: positiveInt(1_800),
    // Si el cliente se desconecta, cuánto se espera a que vuelva antes de cortar.
    VOICE_RECONNECT_GRACE_MS: positiveInt(15_000),
    // Una llamada creada a la que el cliente nunca conecta el audio se da por fallida.
    VOICE_CONNECT_TIMEOUT_MS: positiveInt(30_000),
    // Servidores STUN/TURN para WebRTC, como JSON (RTCIceServer[]). Vacío = sin ICE externo
    // (funciona en la misma máquina o red local; en redes reales hace falta un TURN).
    ICE_SERVERS: z.string().default("[]"),

    // --- Identidad del staff (Fase 7) ---
    // Clave de 32 bytes (base64) para cifrar los secretos TOTP en la base. OBLIGATORIA en producción;
    // en desarrollo y pruebas, si falta, se deriva de JWT_SECRET con HKDF (contexto propio).
    MFA_ENCRYPTION_KEY: z.string().optional(),
    // URL pública del frontend: los enlaces de los correos apuntan aquí.
    APP_BASE_URL: z.string().url().default("http://localhost:5174"),
    // Correo: "mock" (por defecto) guarda lo "enviado" en la tabla email_outbox; "smtp" envía de verdad.
    EMAIL_PROVIDER: z.enum(["mock", "smtp"]).default("mock"),
    SMTP_URL: z.string().optional(),
    EMAIL_FROM: z.string().default("Banco Cordillera <no-responder@cordillera.example>"),
    // Ubicación aproximada de las sesiones: "mock" (por defecto) o "dbip" (archivo .mmdb LOCAL, sin servicio externo).
    GEO_PROVIDER: z.enum(["mock", "dbip"]).default("mock"),
    GEO_DB_PATH: z.string().optional(),
    // Archivos (avatar, adjuntos): "local" (por defecto, carpeta fuera del repo) o "s3" (compatible con S3).
    STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
    STORAGE_LOCAL_DIR: z.string().default("../atencion-ia-storage"),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default("us-east-1"),
    S3_ENDPOINT: z.string().url().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.JWT_SECRET === value.IP_HASH_SECRET) {
      ctx.addIssue({ code: "custom", path: ["IP_HASH_SECRET"], message: "Debe ser distinto de JWT_SECRET" });
    }
    if (isProduction && value.RATE_LIMIT_SCALE !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["RATE_LIMIT_SCALE"],
        message: "Es solo para pruebas de carga y no puede usarse con NODE_ENV=production",
      });
    }
    if (value.AI_PROVIDER === "anthropic") {
      for (const key of ["ANTHROPIC_API_KEY", "VOYAGE_API_KEY"] as const) {
        if (!value[key]) {
          ctx.addIssue({ code: "custom", path: [key], message: "Obligatoria con AI_PROVIDER=anthropic" });
        }
      }
    }
    if (isProduction && value.AI_PROVIDER === "mock") {
      ctx.addIssue({
        code: "custom",
        path: ["AI_PROVIDER"],
        message: "mock responde con plantillas: no puede usarse con NODE_ENV=production",
      });
    }
    if (value.VOICE_PROVIDER === "deepgram" && !value.DEEPGRAM_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["DEEPGRAM_API_KEY"], message: "Obligatoria con VOICE_PROVIDER=deepgram" });
    }
    if (isProduction && value.VOICE_PROVIDER === "mock") {
      ctx.addIssue({
        code: "custom",
        path: ["VOICE_PROVIDER"],
        message: "mock simula la voz: no puede usarse con NODE_ENV=production",
      });
    }
    if (value.MFA_ENCRYPTION_KEY !== undefined && Buffer.from(value.MFA_ENCRYPTION_KEY, "base64").length !== 32) {
      ctx.addIssue({ code: "custom", path: ["MFA_ENCRYPTION_KEY"], message: "Debe ser 32 bytes en base64" });
    }
    if (isProduction && !value.MFA_ENCRYPTION_KEY) {
      ctx.addIssue({ code: "custom", path: ["MFA_ENCRYPTION_KEY"], message: "Obligatoria en producción" });
    }
    if (value.EMAIL_PROVIDER === "smtp" && !value.SMTP_URL) {
      ctx.addIssue({ code: "custom", path: ["SMTP_URL"], message: "Obligatoria con EMAIL_PROVIDER=smtp" });
    }
    if (isProduction && value.EMAIL_PROVIDER === "mock") {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_PROVIDER"],
        message: "mock no envía correos: no puede usarse en producción",
      });
    }
    if (value.GEO_PROVIDER === "dbip" && !value.GEO_DB_PATH) {
      ctx.addIssue({
        code: "custom",
        path: ["GEO_DB_PATH"],
        message: "Obligatoria con GEO_PROVIDER=dbip (ruta al .mmdb)",
      });
    }
    if (value.STORAGE_PROVIDER === "s3") {
      for (const key of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
        if (!value[key]) ctx.addIssue({ code: "custom", path: [key], message: "Obligatoria con STORAGE_PROVIDER=s3" });
      }
    }
    const ice = iceServersSchema.safeParse(safeJson(value.ICE_SERVERS));
    if (!ice.success) {
      ctx.addIssue({
        code: "custom",
        path: ["ICE_SERVERS"],
        message: 'Debe ser un JSON como [{"urls":"stun:stun.example.org:3478"}]',
      });
    }
    if (value.METRICS_TOKEN && value.METRICS_TOKEN.length < 16) {
      ctx.addIssue({ code: "custom", path: ["METRICS_TOKEN"], message: "Debe tener al menos 16 caracteres" });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
  throw new Error(`Configuración inválida (revisa tu archivo .env):\n${problems}`);
}
const e = parsed.data;

export const env = {
  nodeEnv,
  port: e.PORT,
  databaseUrl: e.DATABASE_URL,
  redisUrl: e.REDIS_URL,
  logLevel: e.LOG_LEVEL,

  jwtSecret: e.JWT_SECRET,
  // Access token: corto, solo en memoria del navegador (nunca en localStorage).
  jwtExpiresIn: e.JWT_EXPIRES_IN,
  // Refresh token (cookie httpOnly, rotativo): días de vida de una sesión inactiva.
  refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
  cookieSecure: e.COOKIE_SECURE === "true",
  ipHashSecret: e.IP_HASH_SECRET,

  corsOrigins: e.CORS_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  trustProxy: e.TRUST_PROXY,
  rateLimitScale: e.RATE_LIMIT_SCALE,

  metricsToken: e.METRICS_TOKEN || undefined,
  shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
  // Espera entre "/ready = 503" y dejar de aceptar conexiones, para que el
  // balanceador alcance a sacar la instancia. 0 en local.
  shutdownDrainDelayMs: e.SHUTDOWN_DRAIN_DELAY_MS,

  ai: {
    provider: e.AI_PROVIDER,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    voyageApiKey: e.VOYAGE_API_KEY,
    chatModel: e.ANTHROPIC_MODEL,
    classifierModel: e.ANTHROPIC_CLASSIFIER_MODEL,
    embeddingModel: e.AI_PROVIDER === "mock" ? "mock-embed-v1" : e.VOYAGE_MODEL,
    timeoutMs: e.AI_TIMEOUT_MS,
    mockLatencyMs: e.AI_MOCK_LATENCY_MS,
    ragTopK: e.RAG_TOP_K,
    // Umbral calibrado por proveedor (docs/rag.md): los embeddings reales y los
    // del mock (hashing de palabras) no tienen la misma escala de similitud.
    ragMinScore: e.RAG_MIN_SCORE ?? (e.AI_PROVIDER === "mock" ? 0.2 : 0.45),
    dailyTokenBudgetPerCustomer: e.AI_DAILY_TOKEN_BUDGET_PER_CUSTOMER,
  },
  widgetSessionTtlHours: e.WIDGET_SESSION_TTL_HOURS,
  workerConcurrency: e.WORKER_CONCURRENCY,
  workerMetricsPort: e.WORKER_METRICS_PORT,

  voice: {
    provider: e.VOICE_PROVIDER,
    deepgramApiKey: e.DEEPGRAM_API_KEY,
    sttModel: e.VOICE_PROVIDER === "mock" ? "mock-stt-v1" : e.DEEPGRAM_STT_MODEL,
    ttsModel: e.VOICE_PROVIDER === "mock" ? "mock-tts-v1" : e.DEEPGRAM_TTS_MODEL,
    language: e.DEEPGRAM_LANGUAGE,
    timeoutMs: e.VOICE_TIMEOUT_MS,
    retentionDays: e.VOICE_TRANSCRIPT_RETENTION_DAYS,
    maxCallSeconds: e.VOICE_MAX_CALL_SECONDS,
    dailySecondsPerCustomer: e.VOICE_DAILY_SECONDS_PER_CUSTOMER,
    reconnectGraceMs: e.VOICE_RECONNECT_GRACE_MS,
    connectTimeoutMs: e.VOICE_CONNECT_TIMEOUT_MS,
    iceServers: iceServersSchema.parse(JSON.parse(e.ICE_SERVERS)),
  },

  identity: {
    // 32 bytes. Si no se configuró (solo fuera de producción), se deriva de JWT_SECRET.
    mfaEncryptionKey: e.MFA_ENCRYPTION_KEY
      ? Buffer.from(e.MFA_ENCRYPTION_KEY, "base64")
      : Buffer.from(hkdfSync("sha256", e.JWT_SECRET, "atencion-ia", "mfa-secret-at-rest-v1", 32)),
    appBaseUrl: e.APP_BASE_URL.replace(/\/$/, ""),
  },
  email: { provider: e.EMAIL_PROVIDER, smtpUrl: e.SMTP_URL, from: e.EMAIL_FROM },
  geo: { provider: e.GEO_PROVIDER, dbPath: e.GEO_DB_PATH },
  storage: {
    provider: e.STORAGE_PROVIDER,
    localDir: e.STORAGE_LOCAL_DIR,
    s3: {
      bucket: e.S3_BUCKET,
      region: e.S3_REGION,
      endpoint: e.S3_ENDPOINT,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
    },
  },
};
