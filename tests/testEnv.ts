// Base de datos EXCLUSIVA para tests: se borra y se recrea en cada corrida.
// Por seguridad, globalSetup se niega a usar una base cuyo nombre no termine
// en "_test" (así nunca se toca la base de desarrollo).
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5434/atencion_ia_test";
