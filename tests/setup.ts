import { vi } from "vitest";

// Ningún test necesita Redis real: el rate limiting usa el store en memoria
// en NODE_ENV=test y /ready consulta este ping simulado.
vi.mock("../src/config/redis", () => ({
  redisConnection: {
    call: vi.fn(),
    on: vi.fn(),
    quit: vi.fn(),
    disconnect: vi.fn(),
    publish: vi.fn(),
    ping: vi.fn().mockResolvedValue("PONG"),
  },
}));

// Colas: se registra qué se encoló; el trabajo se prueba llamando directo a
// sus funciones (indexArticle, notifyEscalation).
vi.mock("../src/queues/queues", () => ({
  enqueueArticleIndexing: vi.fn().mockResolvedValue(undefined),
  enqueueEscalationNotify: vi.fn().mockResolvedValue(undefined),
  closeQueues: vi.fn().mockResolvedValue(undefined),
  KB_INDEXING_QUEUE: "kb-indexing",
  ESCALATION_NOTIFY_QUEUE: "escalation-notify",
  VOICE_MAINTENANCE_QUEUE: "voice-maintenance",
  scheduleVoiceMaintenance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/realtime/staffEvents", () => ({
  STAFF_EVENTS_CHANNEL: "atencion-ia:staff-events",
  publishStaffEvent: vi.fn().mockResolvedValue(undefined),
}));

// Bus de tiempo real: en memoria (tests/support/memoryBus.ts) en vez de Redis pub/sub.
vi.mock("../src/realtime/bus", () => import("./support/memoryBus"));
