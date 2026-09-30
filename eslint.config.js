// @ts-check
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const prettier = require("eslint-config-prettier");
const globals = require("globals");

module.exports = tseslint.config(
  // atencion-ia-database/: en CI se descarga dentro del workspace solo por las migraciones.
  { ignores: ["dist/", "node_modules/", "coverage/", "atencion-ia-database/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // Parámetros/variables que empiezan con "_" se consideran intencionalmente sin usar.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Todo el log pasa por pino (con redacción de datos sensibles).
      "no-console": "error",
    },
  },
  {
    // Herramientas de línea de comandos (kb:reindex, rag:calibrate, test:mutations, pruebas de carga): su salida ES
    // el reporte en la terminal. El código del servidor sigue obligado a usar pino (con redacción).
    files: ["scripts/**", "src/scripts/**", "loadtests/**"],
    languageOptions: { globals: globals.node },
    rules: { "no-console": "off" },
  },
  {
    files: ["eslint.config.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Desactiva reglas de estilo que chocan con Prettier (debe ir al final).
  prettier
);
