import { vi } from "vitest";

// Ningún test necesita Redis real: el rate limiting usa el store en memoria
// en NODE_ENV=test y /ready consulta este ping simulado.
vi.mock("../src/config/redis", () => ({
  redisConnection: { call: vi.fn(), on: vi.fn(), quit: vi.fn(), ping: vi.fn().mockResolvedValue("PONG") },
}));
