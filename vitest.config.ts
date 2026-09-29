import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL } from "./tests/testEnv";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Crea la base de pruebas desde cero y aplica las migraciones SQL reales.
    globalSetup: ["tests/globalSetup.ts"],
    // Redis simulado: los tests no lo necesitan.
    setupFiles: ["tests/setup.ts"],
    // Los tests de integración comparten una misma base de datos.
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: "test-jwt-secret-solo-para-pruebas-0123456789",
      IP_HASH_SECRET: "test-ip-hash-secret-solo-para-pruebas-987654",
      // Fijo: el .env local de desarrollo no debe cambiar lo que prueban los tests.
      JWT_EXPIRES_IN: "15m",
      CORS_ORIGIN: "http://localhost:5174",
      METRICS_TOKEN: "test-metrics-token-0123456789",
      // Cada test manda su propia IP en X-Forwarded-For: así los rate limiters
      // (por IP) no se contaminan entre tests del mismo archivo.
      TRUST_PROXY: "1",
    },
  },
});
