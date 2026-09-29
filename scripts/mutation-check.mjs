// scripts/mutation-check.mjs  —  npm run test:mutations
//
// Pruebas de mutación de las reglas CRÍTICAS: rompe a propósito cada regla en
// el código, corre los tests que deberían detectarlo y EXIGE que fallen. Si un
// test sigue pasando con la regla rota, ese test no protege nada.
//
// Cada mutación se aplica sobre el archivo, se corre vitest y el archivo se
// restaura SIEMPRE (try/finally), incluso si algo falla a mitad de camino.
// Funciona igual en cmd.exe y en bash (solo usa Node).
//
// Requiere el Postgres del docker-compose de atencion-ia-database levantado.

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const MUTATIONS = [
  {
    name: "El historial deja de filtrar por conversación (se mezclan clientes en el prompt)",
    file: "src/modules/engine/history.ts",
    from: "where: { conversationId, ...(excludeMessageId",
    to: "where: { ...(excludeMessageId",
    tests: ["tests/integration/ragIsolation.test.ts"],
  },
  {
    name: "La búsqueda del RAG deja de filtrar artículos publicados (borradores/archivados al cliente)",
    file: "src/modules/rag/rag.repository.ts",
    from: "WHERE a.status = 'published'\n      AND c.article_version = a.version",
    to: "WHERE c.article_version = a.version",
    tests: ["tests/integration/ragIsolation.test.ts"],
  },
  {
    name: "La búsqueda del RAG usa fragmentos de versiones viejas",
    file: "src/modules/rag/rag.repository.ts",
    from: "      AND c.article_version = a.version\n",
    to: "",
    tests: ["tests/integration/ragIsolation.test.ts"],
  },
  {
    name: "El widget deja de verificar el dueño de la conversación al leer",
    file: "src/modules/widget/widget.service.ts",
    from: "where: { id: conversationId, customerId: identity.customerId }",
    to: "where: { id: conversationId }",
    tests: ["tests/integration/ragIsolation.test.ts"],
  },
  {
    name: "El motor deja de verificar el dueño de la conversación al escribir",
    file: "src/modules/engine/conversationEngine.ts",
    from: "where: { id: input.conversationId, customerId: input.customerId }",
    to: "where: { id: input.conversationId }",
    tests: ["tests/integration/ragIsolation.test.ts"],
  },
  {
    name: "Se quita la neutralización de etiquetas (prompt injection)",
    file: "src/services/ai/untrusted.ts",
    from: 'return text.replace(TAG_PATTERN, (match) => match.replace("<", "‹"));',
    to: "return text;",
    tests: ["tests/unit/untrusted.test.ts"],
  },
  {
    name: "Escalamiento sin ON CONFLICT (duplicados bajo concurrencia)",
    file: "src/modules/engine/escalation.service.ts",
    from: "ON CONFLICT (conversation_id) WHERE status IN ('open', 'assigned') DO NOTHING",
    to: "",
    tests: ["tests/integration/engine.test.ts"],
  },
  {
    name: "La regla de fraude deja de escalar",
    file: "src/modules/engine/escalationRules.ts",
    from: 'if (current.intent === "possible_fraud" && confident(current)) {',
    to: "if (false) {",
    tests: ["tests/unit/escalationRules.test.ts", "tests/integration/engine.test.ts"],
  },
  {
    name: "Un reclamo aislado escala (se pierde la regla de 'dos seguidos')",
    file: "src/modules/engine/escalationRules.ts",
    from: 'if (current.intent === "complaint" && previous?.intent === "complaint") {',
    to: 'if (current.intent === "complaint") {',
    tests: ["tests/unit/escalationRules.test.ts"],
  },
  {
    name: "Se desactiva el tope diario de tokens por cliente",
    file: "src/modules/engine/budget.service.ts",
    from: "if ((await tokensUsedLast24h(customerId)) >= env.ai.dailyTokenBudgetPerCustomer) throw new AiBudgetExceededError();",
    to: "return;",
    tests: ["tests/integration/engine.test.ts"],
  },
  {
    name: "El adaptador de Claude lee la respuesta sin revisar stop_reason (refusal)",
    file: "src/services/ai/anthropic.provider.ts",
    from: 'if (message.stop_reason === "refusal") {',
    to: "if (false) {",
    tests: ["tests/unit/anthropicProvider.test.ts"],
  },
  {
    name: "La clasificación del modelo se acepta sin validar con zod",
    file: "src/services/ai/anthropic.provider.ts",
    from: 'if (!parsed.success) throw new AiOutputError("La clasificación no cumple el esquema");\n        return { ...parsed.data,',
    to: "return { ...(json as object) as never,",
    tests: ["tests/unit/anthropicProvider.test.ts"],
  },
  {
    name: "Se acepta texto mal codificado (se guardaría corrompido en silencio)",
    file: "src/utils/schemas.ts",
    from: '!value.includes("\\uFFFD")',
    to: "true",
    tests: ["tests/integration/widget.test.ts"],
  },
  // --- Fase 4: tiempo real y sesión del widget ---
  {
    name: "WS: un cliente recibe mensajes de conversaciones AJENAS",
    file: "src/realtime/audience.ts",
    from: "      if (event.conversation.customerId !== customerId) return null;\n      const { intent",
    to: "      const { intent",
    tests: ["tests/unit/audience.test.ts", "tests/integration/websocket.test.ts"],
  },
  {
    name: "WS: un agente recibe mensajes de casos que no puede ver",
    file: "src/realtime/audience.ts",
    from: "return canViewConversation(user, event.conversation) ? { ...event } : null;",
    to: "return { ...event };",
    tests: ["tests/unit/audience.test.ts", "tests/integration/websocket.test.ts"],
  },
  {
    name: "WS: el cliente recibe el análisis de la IA sobre sus mensajes",
    file: "src/realtime/audience.ts",
    from: "const { intent: _intent, sentiment: _sentiment, agent, ...message } = event.message;",
    to: "const { agent, ...message } = event.message;",
    tests: ["tests/unit/audience.test.ts", "tests/integration/websocket.test.ts"],
  },
  {
    name: "WS: quien veía un caso no se entera de que salió de su alcance (cola desactualizada)",
    file: "src/realtime/audience.ts",
    from: "const visibleBefore = event.previous !== null && canViewConversation(user, event.previous);",
    to: "const visibleBefore = false;",
    tests: ["tests/unit/audience.test.ts", "tests/integration/websocket.test.ts"],
  },
  {
    name: "WS: se acepta cualquier Origin (cross-site WebSocket hijacking)",
    file: "src/realtime/wsServer.ts",
    from: "if (!origin || !env.corsOrigins.includes(origin)) {",
    to: "if (false) {",
    tests: ["tests/integration/websocket.test.ts"],
  },
  {
    name: "WS: un token inválido autentica igual (como admin)",
    file: "src/realtime/wsServer.ts",
    from: "const payload = verifyAccessToken(message.accessToken);",
    to: 'const payload = verifyAccessToken(message.accessToken) ?? { staffId: "x", role: "admin" as const, exp: undefined };',
    tests: ["tests/integration/websocket.test.ts"],
  },
  {
    name: "WS: el socket sigue abierto después de que vence el token",
    file: "src/realtime/wsServer.ts",
    from: "if (payload.exp) closeAt(ws, state, payload.exp * 1000);",
    to: "",
    tests: ["tests/integration/websocket.test.ts"],
  },
  {
    name: "Widget: escrituras con la cookie SIN protección CSRF",
    file: "src/modules/widget/widgetAuth.middleware.ts",
    from: "csrfProtection(req, res, () => undefined);",
    to: "",
    tests: ["tests/integration/widget.test.ts"],
  },
  {
    name: "Widget: el token se entrega al JavaScript del navegador",
    file: "src/modules/widget/widget.controller.ts",
    from: "...(fromBrowser ? {} : { token: session.token }),",
    to: "token: session.token,",
    tests: ["tests/integration/widget.test.ts"],
  },
];

function runTests(files) {
  const result = spawnSync("npx", ["vitest", "run", ...files], {
    shell: true,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const failed = (output.match(/Tests\s+(\d+) failed/) ?? [])[1];
  return { passed: result.status === 0, failed: failed ? Number(failed) : 0 };
}

let survivors = 0;
console.log(`Pruebas de mutación: ${MUTATIONS.length} reglas críticas\n`);

for (const [index, mutation] of MUTATIONS.entries()) {
  const original = readFileSync(mutation.file, "utf8");
  if (!original.includes(mutation.from)) {
    console.log(`✗ [${index + 1}] NO SE PUDO APLICAR (¿cambió el código?): ${mutation.name}`);
    survivors += 1;
    continue;
  }
  try {
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
    const { passed, failed } = runTests(mutation.tests);
    if (passed) {
      survivors += 1;
      console.log(`✗ [${index + 1}] SOBREVIVIÓ (ningún test lo detectó): ${mutation.name}`);
    } else {
      console.log(`✓ [${index + 1}] detectada por ${failed} test(s): ${mutation.name}`);
    }
  } finally {
    writeFileSync(mutation.file, original);
  }
}

console.log(`\n${MUTATIONS.length - survivors}/${MUTATIONS.length} mutaciones detectadas. Archivos restaurados.`);
process.exit(survivors === 0 ? 0 : 1);
