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
  {
    name: "VOZ: un cliente se conecta a la llamada de OTRO cliente (escucharía y hablaría en ella)",
    file: "src/realtime/voiceServer.ts",
    from: "where: { id: message.callId, conversation: { customerId: identity.customerId } },",
    to: "where: { id: message.callId },",
    tests: ["tests/integration/voice.test.ts"],
  },
  {
    name: "VOZ: un agente que NO se unió a la llamada puede escucharla",
    file: "src/realtime/voiceServer.ts",
    from: "call.participants.length > 0 &&",
    to: "",
    tests: ["tests/integration/voice.test.ts"],
  },
  {
    name: "VOZ: la señalización WebRTC se entrega a sockets de OTRAS llamadas",
    file: "src/realtime/voiceServer.ts",
    from: "const inCall = connections().filter((conn) => conn.callId === message.callId);",
    to: "const inCall = connections();",
    tests: ["tests/integration/voice.test.ts"],
  },
  {
    name: "VOZ: sin tope de caudal de audio (un script quema créditos de STT)",
    file: "src/realtime/voiceServer.ts",
    from: "if (state.bucket < 0) {",
    to: "if (false) {",
    tests: ["tests/integration/voice.test.ts"],
  },
  {
    name: "VOZ: el audio del cliente no cuenta en su tope diario",
    file: "src/realtime/voiceServer.ts",
    from: 'customerId: conn.role === "customer" ? conn.customerId : null,',
    to: "customerId: null,",
    tests: ["tests/integration/voice.test.ts"],
  },
  {
    name: "VOZ: sin período de gracia, un corte de red cuelga la llamada al instante",
    file: "src/realtime/voiceServer.ts",
    from: "      }, graceMs)",
    to: "      }, 0)",
    tests: ["tests/integration/voice.test.ts"],
  },
  {
    name: "VOZ: no se aplica la duración máxima de la llamada",
    file: "src/realtime/voiceServer.ts",
    from: "Math.max(msLeft, 0)",
    to: "Math.max(msLeft, 0) + 60_000",
    tests: ["tests/integration/voice.test.ts"],
  },
  {
    name: "VOZ: se inicia una llamada con un aviso de consentimiento viejo",
    file: "src/modules/voice/calls.service.ts",
    from: "if (input.consentVersion !== CONSENT_VERSION) {",
    to: "if (false) {",
    tests: ["tests/integration/voice.test.ts"],
  },
  {
    name: "VOZ: se inicia una llamada con el tope diario de voz agotado",
    file: "src/modules/voice/calls.service.ts",
    from: "await assertWithinVoiceBudget(widget.customerId);",
    to: "",
    tests: ["tests/integration/voice.test.ts"],
  },
  {
    name: "VOZ: unirse a una llamada en cola NO toma el caso (dos agentes a la vez, sin responsable)",
    file: "src/modules/voice/calls.service.ts",
    from: "await conversationsService.take(user, call.conversationId);",
    to: "",
    tests: ["tests/integration/voice.test.ts"],
  },
  {
    name: "VOZ: cualquiera que ve el caso se une sin ser el agente asignado",
    file: "src/modules/voice/calls.service.ts",
    from: '} else if (!(conversation.status === "agent_active" && conversation.assignedAgentId === user.staffId)) {',
    to: "} else if (false) {",
    tests: ["tests/integration/voice.test.ts"],
  },
  {
    name: "VOZ: la purga borra transcripciones que NO vencieron",
    file: "src/modules/voice/calls.service.ts",
    from: "WHERE transcript_purged_at IS NULL AND retain_until <= now() AND status",
    to: "WHERE transcript_purged_at IS NULL AND status",
    tests: ["tests/integration/voice.test.ts"],
  },
  {
    name: "VOZ: la purga deja el texto dicho en los turnos de voz",
    file: "src/modules/voice/calls.service.ts",
    from: "      await tx.message.updateMany({ where: { callId: { in: ids } }, data: { content: PURGED_PLACEHOLDER } });\n",
    to: "",
    tests: ["tests/integration/voice.test.ts"],
  },
  {
    name: "VOZ: el escalamiento del motor no pasa la llamada a espera de agente",
    file: "src/modules/voice/voicePipeline.ts",
    from: "if (escalated) await callsService.markWaitingAgent(ctx.callId);",
    to: "",
    tests: ["tests/integration/voice.test.ts"],
  },
  {
    name: "VOZ: cerrar la conversación deja la llamada activa",
    file: "src/modules/conversations/conversations.service.ts",
    from: "      if (activeCall) {\n        await tx.call.update(",
    to: "      if (false) {\n        await tx.call.update(",
    tests: ["tests/integration/voice.test.ts"],
  },
  {
    name: "VOZ: el staff recibe transcripciones parciales de casos que no puede ver",
    file: "src/realtime/audience.ts",
    from: '    case "call.updated":\n    case "call.transcript.partial":\n      return canViewConversation(user, event.conversation) ? { ...event } : null;',
    to: '    case "call.updated":\n    case "call.transcript.partial":\n      return { ...event };',
    tests: ["tests/unit/audience.test.ts", "tests/integration/voice.test.ts"],
  },
  {
    name: "Rendimiento: clasificar y buscar en la KB vuelven a ir en serie (una espera de proveedor más por turno)",
    file: "src/modules/engine/conversationEngine.ts",
    // (Fase 7) la clasificación ahora usa lo que escribió el cliente (customerText): misma regla, línea nueva.
    from: "    customerText ? ai.classifier.classify(customerText) : Promise.resolve(null),",
    to: "    customerText ? await ai.classifier.classify(customerText) : Promise.resolve(null),",
    tests: ["tests/integration/engine.test.ts"],
  },
  {
    name: "IDENTIDAD: con MFA activa, la contraseña sola da sesión",
    file: "src/modules/auth/auth.service.ts",
    from: '    if (staff.mfaEnabledAt) {\n      return { kind: "mfa_required"',
    to: '    if (false) {\n      return { kind: "mfa_required"',
    tests: ["tests/integration/recoveryAndMfa.test.ts"],
  },
  {
    name: "IDENTIDAD: un admin sin MFA entra sin enrolarse",
    file: "src/modules/auth/auth.service.ts",
    from: '    if (staff.role === "admin") {\n      return { kind: "mfa_enrollment_required"',
    to: '    if (false) {\n      return { kind: "mfa_enrollment_required"',
    tests: ["tests/integration/recoveryAndMfa.test.ts"],
  },
  {
    name: "IDENTIDAD: los códigos de MFA incorrectos no cuentan para el bloqueo de la cuenta",
    file: "src/modules/auth/auth.service.ts",
    from: "      await lockoutService.registerFailure(staff.email);\n      throw new InvalidMfaCodeError();",
    to: "      throw new InvalidMfaCodeError();",
    tests: ["tests/integration/recoveryAndMfa.test.ts"],
  },
  {
    name: "IDENTIDAD: el desafío de MFA no se consume (dos sesiones con el mismo desafío)",
    file: "src/modules/auth/auth.service.ts",
    from: 'if (!(await consumeToken(input.challengeToken, "mfa_challenge")))',
    to: 'if (!(await findLiveToken(input.challengeToken, "mfa_challenge")))',
    tests: ["tests/integration/recoveryAndMfa.test.ts"],
  },
  {
    name: "IDENTIDAD: TOTP sin anti-replay (en memoria)",
    file: "src/modules/auth/totp.ts",
    from: "&& step <= options.lastUsedStep) continue;",
    to: "&& step < options.lastUsedStep) continue;",
    tests: ["tests/unit/identity.test.ts", "tests/integration/recoveryAndMfa.test.ts"],
  },
  {
    name: "IDENTIDAD: TOTP sin anti-replay (actualización condicional en la base)",
    file: "src/modules/auth/mfa.service.ts",
    from: "(mfa_last_used_step IS NULL OR mfa_last_used_step < ${step})",
    to: "(mfa_last_used_step IS NULL OR mfa_last_used_step <= ${step})",
    tests: ["tests/integration/recoveryAndMfa.test.ts"],
  },
  {
    name: "IDENTIDAD: un código de respaldo sirve más de una vez",
    file: "src/modules/auth/mfa.service.ts",
    from: "code_hash = ${sha256(normalized)} AND used_at IS NULL`",
    to: "code_hash = ${sha256(normalized)}`",
    tests: ["tests/integration/recoveryAndMfa.test.ts"],
  },
  {
    name: "IDENTIDAD: un admin puede desactivar su MFA",
    file: "src/modules/auth/mfa.service.ts",
    from: '    if (staff.role === "admin") {\n      throw new ApiError(409, "Para una cuenta',
    to: '    if (false) {\n      throw new ApiError(409, "Para una cuenta',
    tests: ["tests/integration/recoveryAndMfa.test.ts"],
  },
  {
    name: "IDENTIDAD: el desafío de MFA no muere tras 5 intentos",
    file: "src/modules/auth/singleUseTokens.ts",
    from: "if (updated.attempts >= MAX_MFA_ATTEMPTS) {",
    to: "if (updated.attempts >= 1000) {",
    tests: ["tests/integration/recoveryAndMfa.test.ts"],
  },
  {
    name: "IDENTIDAD: los tokens de un solo uso no vencen",
    file: "src/modules/auth/singleUseTokens.ts",
    from: "AND used_at IS NULL AND expires_at > now()",
    to: "AND used_at IS NULL",
    tests: ["tests/integration/recoveryAndMfa.test.ts", "tests/integration/invitations.test.ts"],
  },
  {
    name: "IDENTIDAD: los tokens de un solo uso se pueden reutilizar",
    file: "src/modules/auth/singleUseTokens.ts",
    from: "AND purpose = ${purpose} AND used_at IS NULL AND expires_at > now()",
    to: "AND purpose = ${purpose} AND expires_at > now()",
    tests: [
      "tests/integration/recoveryAndMfa.test.ts",
      "tests/integration/profile.test.ts",
      "tests/integration/invitations.test.ts",
    ],
  },
  {
    name: "IDENTIDAD: pedir otro enlace NO invalida el anterior",
    file: "src/modules/auth/singleUseTokens.ts",
    from: "await tx.staffToken.updateMany({ where: { staffUserId, purpose, usedAt: null }, data: { usedAt: now } });",
    to: "",
    tests: ["tests/integration/recoveryAndMfa.test.ts", "tests/integration/invitations.test.ts"],
  },
  {
    name: "IDENTIDAD: la recuperación revela qué correos existen (envía a cuentas desactivadas)",
    file: "src/modules/auth/password.service.ts",
    from: "if (!staff || !staff.isActive || staff.deletedAt) return;",
    to: "if (!staff) return;",
    tests: ["tests/integration/recoveryAndMfa.test.ts"],
  },
  {
    name: "IDENTIDAD: restablecer la contraseña no cierra las sesiones",
    file: "src/modules/auth/password.service.ts",
    from: '    await sessionsService.revokeAllFor(staffId, "password_reset");\n',
    to: "",
    tests: ["tests/integration/recoveryAndMfa.test.ts"],
  },
  {
    name: "IDENTIDAD: restablecer acepta contraseñas débiles",
    file: "src/modules/auth/password.service.ts",
    from: '      if (problems.length) throw new ApiError(400, "La contraseña no cumple la política", problems);',
    to: "",
    tests: ["tests/integration/recoveryAndMfa.test.ts"],
  },
  {
    name: "PERFIL: cambiar el correo no pide la contraseña actual",
    file: "src/modules/profile/profile.service.ts",
    from: "    await requirePassword(staff.passwordHash, input.currentPassword);\n    if (input.newEmail",
    to: "    if (input.newEmail",
    tests: ["tests/integration/profile.test.ts"],
  },
  {
    name: "PERFIL: cambiar el correo revela (y escribe a) cuentas existentes",
    file: "src/modules/profile/profile.service.ts",
    from: "    if (taken > 0) return;\n",
    to: "",
    tests: ["tests/integration/profile.test.ts"],
  },
  {
    name: "PERFIL: cambiar la contraseña no cierra las demás sesiones",
    file: "src/modules/profile/profile.service.ts",
    from: 'const closed = await sessionsService.revokeOthers(staffId, currentSessionId, "password_changed");',
    to: "const closed = 1;",
    tests: ["tests/integration/profile.test.ts"],
  },
  {
    name: "PERFIL: el avatar se acepta sin revisar los bytes mágicos (SVG con script)",
    file: "src/modules/profile/profile.service.ts",
    from: "    const format = detectImage(data);",
    to: '    const format = detectImage(data) ?? { ext: "png" as const, contentType: "image/png" };',
    tests: ["tests/integration/profile.test.ts"],
  },
  {
    name: "SESIONES: cerrar una sesión ajena (sin filtrar por dueño)",
    file: "src/modules/auth/sessions.service.ts",
    from: "where: { staffUserId: staffId, familyId, revokedAt: null },",
    to: "where: { familyId, revokedAt: null },",
    tests: ["tests/integration/profile.test.ts"],
  },
  {
    name: "SESIONES: 'cerrar las demás' también cierra la actual",
    file: "src/modules/auth/sessions.service.ts",
    from: "...(keepSessionId ? { familyId: { not: keepSessionId } } : {}),",
    to: "",
    tests: ["tests/integration/profile.test.ts"],
  },
  {
    name: "SESIONES: la IP se guarda completa",
    file: "src/modules/auth/sessions.service.ts",
    from: "return { ipAddress: truncateIp(ip),",
    to: "return { ipAddress: ip ?? null,",
    tests: ["tests/integration/profile.test.ts"],
  },
  {
    name: "CUENTAS: se anonimiza un agente con casos en curso",
    file: "src/modules/staff/staff.service.ts",
    from: "if (active > 0 || inCall > 0) {",
    to: "if (false) {",
    tests: ["tests/integration/profile.test.ts"],
  },
  {
    name: "CUENTAS: se anonimiza una cuenta de admin",
    file: "src/modules/staff/staff.service.ts",
    from: 'if (staff.role !== "agent") {',
    to: "if (false) {",
    tests: ["tests/integration/profile.test.ts"],
  },
  {
    name: "CUENTAS: una cuenta anonimizada se puede reactivar",
    file: "src/modules/staff/staff.service.ts",
    from: "if (target.deletedAt) throw",
    to: "if (false) throw",
    tests: ["tests/integration/profile.test.ts"],
  },
  {
    name: "CUENTAS: reasignar ignora el máximo de conversaciones del destino",
    file: "src/modules/conversations/conversations.service.ts",
    from: "      if (active >= target.max_concurrent) {\n        throw new ApiError(409, `El agente destino",
    to: "      if (false) {\n        throw new ApiError(409, `El agente destino",
    tests: ["tests/integration/profile.test.ts"],
  },
  {
    name: "ADMIN: un asesor puede crear respuestas predefinidas",
    file: "src/modules/canned/canned.routes.ts",
    from: 'cannedRouter.post(\n  "/",\n  requireRole("admin"),\n',
    to: 'cannedRouter.post(\n  "/",\n',
    tests: ["tests/integration/adminTools.test.ts"],
  },
  {
    name: "ADMIN: un asesor ve las respuestas desactivadas",
    file: "src/modules/canned/canned.routes.ts",
    from: 'if (includeInactive && currentUser(req).role !== "admin") {',
    to: "if (false) {",
    tests: ["tests/integration/adminTools.test.ts"],
  },
  {
    name: "ADMIN: la lista del asesor incluye respuestas desactivadas",
    file: "src/modules/canned/canned.service.ts",
    from: "where: includeInactive ? {} : { isActive: true },",
    to: "where: {},",
    tests: ["tests/integration/adminTools.test.ts"],
  },
  {
    name: "ADMIN: la analítica queda abierta a cualquier asesor",
    file: "src/modules/analytics/analytics.routes.ts",
    from: 'analyticsRouter.use(authMiddleware, requireRole("admin"));',
    to: "analyticsRouter.use(authMiddleware);",
    tests: ["tests/integration/adminTools.test.ts"],
  },
  {
    name: "ANALÍTICA: abandonos y spam cuentan como 'resueltos'",
    file: "src/modules/analytics/analytics.service.ts",
    from: "        WHERE closed_at >= ${from} AND closed_at < ${to}\n          AND close_reason IN ('resolved_by_ai', 'resolved_by_agent')`,",
    to: "        WHERE closed_at >= ${from} AND closed_at < ${to}`,",
    tests: ["tests/integration/adminTools.test.ts"],
  },
  {
    name: "ANALÍTICA: la tasa de escalamiento cuenta todas las conversaciones como escaladas",
    file: "src/modules/analytics/analytics.service.ts",
    from: "count(*) FILTER (WHERE EXISTS (SELECT 1 FROM escalations e WHERE e.conversation_id = c.id)) AS escalated",
    to: "count(*) AS escalated",
    tests: ["tests/integration/adminTools.test.ts"],
  },
  {
    name: "ANALÍTICA: el volumen por hora usa UTC en vez de la hora de Bogotá",
    file: "src/modules/analytics/analytics.service.ts",
    from: "extract(hour FROM created_at AT TIME ZONE ${ANALYTICS_TIMEZONE})::int",
    to: "extract(hour FROM created_at AT TIME ZONE 'UTC')::int",
    tests: ["tests/integration/adminTools.test.ts"],
  },
  {
    name: "CSAT: el spam entra en la satisfacción",
    file: "src/modules/analytics/csat.ts",
    from: "  spam: null,",
    to: "  spam: 1,",
    tests: ["tests/unit/csat.test.ts", "tests/integration/adminTools.test.ts"],
  },
  {
    name: "CSAT: tardar más de 30 min no baja la nota",
    file: "src/modules/analytics/csat.ts",
    from: "const slow = conversation.resolutionMinutes > SLOW_RESOLUTION_MINUTES ? -1 : 0;",
    to: "const slow = 0;",
    tests: ["tests/unit/csat.test.ts"],
  },
  {
    name: "CSAT: la nota se sale de 1–5",
    file: "src/modules/analytics/csat.ts",
    from: "return Math.min(5, Math.max(1, base + slow + idVariation(conversation.id)));",
    to: "return base + slow + idVariation(conversation.id);",
    tests: ["tests/unit/csat.test.ts"],
  },
  {
    name: "EQUIPO: un asesor filtra conversaciones por agente fuera de scope=all",
    file: "src/modules/conversations/conversations.service.ts",
    from: 'if (query.agentId && scope !== "all") {',
    to: "if (false) {",
    tests: ["tests/integration/adminTools.test.ts"],
  },
  {
    name: "ADJUNTOS→IA: el CONTENIDO del archivo se agrega al texto del turno (p. ej. 'extraer el texto del PDF')",
    file: "src/modules/widget/widget.service.ts",
    from: "        content: input.caption ?? ATTACHMENT_PLACEHOLDER,",
    to: '        content: [input.caption, Buffer.isBuffer(input.data) ? input.data.toString("latin1") : ""].filter(Boolean).join("\\n").slice(0, 3000),',
    tests: ["tests/integration/attachments.test.ts"],
  },
  {
    name: "ADJUNTOS→IA: el NOMBRE del archivo (lo escribe el cliente) llega al modelo",
    file: "src/modules/engine/conversationEngine.ts",
    from: "  const aiText = textForAi(input.content, input.attachment?.contentType);",
    to: '  const aiText = `${textForAi(input.content, input.attachment?.contentType)} (${input.attachment?.originalName ?? ""})`;',
    tests: ["tests/integration/attachments.test.ts"],
  },
  {
    name: "ADJUNTOS→IA: el clasificador y el RAG reciben la señal del servidor (dispara reglas de escalamiento)",
    file: "src/modules/engine/conversationEngine.ts",
    from: "  const customerText = customerWrittenText(input.content, Boolean(input.attachment));",
    to: "  const customerText = textForAi(input.content, input.attachment?.contentType);",
    tests: ["tests/integration/attachments.test.ts"],
  },
  {
    name: "ADJUNTOS→IA: la IA no se entera de que hay un adjunto (se pierde la señal)",
    file: "src/modules/engine/conversationEngine.ts",
    from: "  const aiText = textForAi(input.content, input.attachment?.contentType);",
    to: "  const aiText = input.content;",
    tests: ["tests/integration/attachments.test.ts"],
  },
  {
    name: "ADJUNTOS→IA: el historial de turnos siguientes pierde la señal del adjunto",
    file: "src/modules/engine/history.ts",
    from: "content: textForAi(row.content, row.attachments[0]?.contentType) })",
    to: "content: row.content })",
    tests: ["tests/integration/attachments.test.ts"],
  },
  {
    name: "ADJUNTOS: se acepta cualquier archivo (sin revisar los bytes)",
    file: "src/modules/attachments/attachments.service.ts",
    from: "  const kind = detectAttachment(data);",
    to: '  const kind = detectAttachment(data) ?? { ext: "pdf" as const, contentType: "application/pdf", label: "PDF" as const };',
    tests: ["tests/integration/attachments.test.ts"],
  },
  {
    name: "ADJUNTOS: se aceptan PDF con JavaScript o archivos incrustados",
    file: "src/modules/attachments/attachments.service.ts",
    from: "    const found = pdfDangerousFeatures(data);",
    to: "    const found: string[] = [];",
    tests: ["tests/integration/attachments.test.ts"],
  },
  {
    name: "ADJUNTOS: el nombre ofuscado (/J#61vaScript) burla la revisión del PDF",
    file: "src/modules/attachments/fileChecks.ts",
    from: "    .replace(/#([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))\n",
    to: "",
    tests: ["tests/unit/attachments.test.ts"],
  },
  {
    name: "ADJUNTOS: las fotos JPEG se guardan CON su EXIF (ubicación GPS)",
    file: "src/modules/attachments/attachments.service.ts",
    from: "      data = stripJpegMetadata(data);",
    to: "      stripJpegMetadata(data);",
    tests: ["tests/integration/attachments.test.ts"],
  },
  {
    name: "ADJUNTOS: un cliente descarga adjuntos de conversaciones AJENAS",
    file: "src/modules/attachments/attachments.service.ts",
    from: "  if (!found || found.conversation.customerId !== customerId) throw",
    to: "  if (!found) throw",
    tests: ["tests/integration/attachments.test.ts"],
  },
  {
    name: "ADJUNTOS: un asesor ve adjuntos de casos que no puede ver",
    file: "src/modules/attachments/attachments.service.ts",
    from: "  if (!canViewConversation(user, found.conversation)) throw",
    to: "  if (false) throw",
    tests: ["tests/integration/attachments.test.ts"],
  },
  {
    name: "ADJUNTOS: un adjunto se sirve bajo la URL de OTRA conversación (coherencia; el permiso se aplica igual)",
    file: "src/modules/attachments/attachments.service.ts",
    from: "  if (!found || found.attachment.conversationId !== conversationId) throw",
    to: "  if (!found) throw",
    tests: ["tests/integration/attachments.test.ts"],
  },
  {
    name: "ADJUNTOS: el PDF se abre dentro de la app (inline) en vez de descargarse",
    file: "src/modules/attachments/attachments.http.ts",
    from: '  const disposition = contentType === "application/pdf" ? "attachment" : "inline";',
    to: '  const disposition = "inline";',
    tests: ["tests/integration/attachments.test.ts"],
  },
  {
    name: "ADJUNTOS: un reenvío duplicado deja el archivo repetido en el almacenamiento",
    file: "src/modules/widget/widget.service.ts",
    from: "    if (result.duplicate) await discardAttachment(stored);\n",
    to: "",
    tests: ["tests/integration/attachments.test.ts"],
  },
  {
    name: "INVITACIÓN: el enlace se acepta SIN consumirlo (sigue vivo en la base tras completar la cuenta)",
    file: "src/modules/staff/invitations.service.ts",
    from: '      const consumed = await consumeToken(rawToken, "invitation", tx);',
    to: '      const consumed = await findLiveToken(rawToken, "invitation");',
    tests: ["tests/integration/invitations.test.ts"],
  },
  {
    name: "INVITACIÓN: no se verifica el resultado del token (se completa una cuenta sin una invitación válida)",
    file: "src/modules/staff/invitations.service.ts",
    from: "      if (!consumed) throw new ApiError(400, INVALID_INVITATION);",
    to: "      if (false as boolean) throw new ApiError(400, INVALID_INVITATION);",
    tests: ["tests/integration/invitations.test.ts"],
  },
  {
    name: "INVITACIÓN: el mensaje revela que el enlace YA SE USÓ (distinto del de un enlace inventado)",
    file: "src/modules/staff/invitations.service.ts",
    from: "      if (!consumed) throw new ApiError(400, INVALID_INVITATION);",
    to: '      if (!consumed) throw new ApiError(400, "Este enlace ya se usó");',
    tests: ["tests/integration/invitations.test.ts"],
  },
  {
    name: "INVITACIÓN: un enlace VENCIDO sirve para ver la invitación",
    file: "src/modules/auth/singleUseTokens.ts",
    from: "    where: { tokenHash: sha256(raw), purpose, usedAt: null, expiresAt: { gt: new Date() } },",
    to: "    where: { tokenHash: sha256(raw), purpose, usedAt: null },",
    tests: ["tests/integration/invitations.test.ts", "tests/integration/recoveryAndMfa.test.ts"],
  },
  {
    name: "INVITACIÓN: completar la cuenta acepta una contraseña que no cumple la política",
    file: "src/modules/staff/invitations.service.ts",
    from: '      if (problems.length) throw new ApiError(400, "La contraseña no cumple la política", problems);',
    to: "",
    tests: ["tests/integration/invitations.test.ts", "tests/integration/kbAndStaff.test.ts"],
  },
  {
    name: "INVITACIÓN: un ADMIN invitado obtiene sesión sin activar la verificación en dos pasos",
    file: "src/modules/auth/auth.service.ts",
    from: '    const staff = await prisma.staffUser.findUniqueOrThrow({ where: { id: staffId } });\n    if (staff.role === "admin") {\n      return { kind: "mfa_enrollment_required", enrollmentToken: await issueToken(staff.id, "mfa_enrollment") };\n    }',
    to: "    const staff = await prisma.staffUser.findUniqueOrThrow({ where: { id: staffId } });",
    tests: ["tests/integration/invitations.test.ts"],
  },
  {
    name: "INVITACIÓN: un asesor puede invitar a otras personas",
    file: "src/modules/staff/staff.routes.ts",
    from: '  "/invitations",\n  requireRole("admin"),',
    to: '  "/invitations",',
    tests: ["tests/integration/invitations.test.ts", "tests/integration/authorization.test.ts"],
  },
  {
    name: "INVITACIÓN: cancelar borra también una cuenta EN USO",
    file: "src/modules/staff/invitations.service.ts",
    from: "    const deleted = await prisma.staffUser.deleteMany({ where: { id, passwordHash: null, deletedAt: null } });",
    to: "    const deleted = await prisma.staffUser.deleteMany({ where: { id, deletedAt: null } });",
    tests: ["tests/integration/invitations.test.ts"],
  },
  {
    name: "INVITACIÓN: una invitación pendiente se activa a mano (PATCH isActive) sin completar la cuenta",
    file: "src/modules/staff/staff.service.ts",
    from: "    if (input.isActive !== undefined) await assertNotPending(id);\n",
    to: "",
    tests: ["tests/integration/invitations.test.ts"],
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
