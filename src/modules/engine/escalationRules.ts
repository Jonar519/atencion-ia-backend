import type { EscalationReason, EscalationTrigger, MessageIntent, MessageSentiment } from "@prisma/client";

/**
 * Motor de escalamiento: REGLAS + SEÑALES DE IA → ¿pasa a un humano?
 *
 * Función PURA (sin base de datos ni red): recibe las señales del turno y el
 * historial reciente, y devuelve la decisión con su evidencia. Así cada regla
 * se prueba sola (tests/unit/escalationRules.test.ts) y el registro en la base
 * (escalation.service.ts) se ocupa aparte de no duplicar escalamientos.
 *
 * Reglas, en orden de prioridad (gana la primera que aplica):
 *
 *  1. Posible fraude (confianza ≥ 0.6)             → possible_fraud    prio 90  ai_signal
 *  2. Pide explícitamente un humano                → human_requested   prio 60  customer_request
 *  3. Cliente enojado (confianza ≥ 0.6)            → angry_customer    prio 70  ai_signal
 *  4. Reclamo repetido (2 turnos seguidos)         → complaint         prio 55  rule
 *  5. Misma intención no resuelta 3 turnos seguidos → repeated_failure  prio 50  rule
 *  6. La IA no encontró apoyo en la KB 2 veces seguidas → low_confidence prio 40 rule
 *  7. El proveedor de IA falló o declinó           → low_confidence    prio 45  rule
 *
 * Por qué ese orden: el fraude es urgente aunque el cliente esté calmado; un
 * pedido explícito de humano se respeta siempre; el enojo se atiende antes que
 * un reclamo tranquilo. Un reclamo AISLADO no escala: la IA puede orientar
 * (plazos, cómo radicar) y solo si insiste pasa a un asesor.
 */

export const MIN_SIGNAL_CONFIDENCE = 0.6;

export interface TurnSignals {
  intent: MessageIntent | null;
  sentiment: MessageSentiment | null;
  confidence: number | null;
}

export interface EscalationInput {
  current: TurnSignals;
  /** Turnos ANTERIORES del cliente en esta conversación, del más reciente al más antiguo. */
  previousCustomerTurns: TurnSignals[];
  /** Respuestas previas de la IA sin ningún fragmento de la KB, consecutivas y más recientes. */
  consecutiveUnsupportedAiReplies: number;
  /** Este turno: ¿se encontró contexto en la KB? (null = no se buscó, p. ej. conversación con humano). */
  kbSupportFound: boolean | null;
  /** El proveedor de IA falló o declinó al responder este turno. */
  aiFailure: "unavailable" | "refusal" | null;
}

export type EscalationDecision =
  | { escalate: false }
  | {
      escalate: true;
      reason: EscalationReason;
      trigger: EscalationTrigger;
      priority: number;
      /** Evidencia que se guarda en escalations.signal (sin texto del cliente). */
      signal: Record<string, string | number | boolean | null>;
    };

const confident = (turn: TurnSignals) => (turn.confidence ?? 0) >= MIN_SIGNAL_CONFIDENCE;

export function decideEscalation(input: EscalationInput): EscalationDecision {
  const { current } = input;
  const evidence = {
    intent: current.intent,
    sentiment: current.sentiment,
    confidence: current.confidence,
  };

  if (current.intent === "possible_fraud" && confident(current)) {
    return {
      escalate: true,
      reason: "possible_fraud",
      trigger: "ai_signal",
      priority: 90,
      signal: { rule: "fraud_signal", ...evidence },
    };
  }
  if (current.intent === "human_request") {
    return {
      escalate: true,
      reason: "human_requested",
      trigger: "customer_request",
      priority: 60,
      signal: { rule: "explicit_request", ...evidence },
    };
  }
  if (current.sentiment === "angry" && confident(current)) {
    return {
      escalate: true,
      reason: "angry_customer",
      trigger: "ai_signal",
      priority: 70,
      signal: { rule: "angry_sentiment", ...evidence },
    };
  }

  const previous = input.previousCustomerTurns[0];
  if (current.intent === "complaint" && previous?.intent === "complaint") {
    return {
      escalate: true,
      reason: "complaint",
      trigger: "rule",
      priority: 55,
      signal: { rule: "repeated_complaint", ...evidence },
    };
  }

  const lastTwo = input.previousCustomerTurns.slice(0, 2);
  if (
    current.intent &&
    current.intent !== "general_inquiry" &&
    current.intent !== "other" &&
    lastTwo.length === 2 &&
    lastTwo.every((turn) => turn.intent === current.intent)
  ) {
    return {
      escalate: true,
      reason: "repeated_failure",
      trigger: "rule",
      priority: 50,
      signal: { rule: "repeated_intent", repeats: 3, ...evidence },
    };
  }

  if (input.kbSupportFound === false && input.consecutiveUnsupportedAiReplies >= 1) {
    return {
      escalate: true,
      reason: "low_confidence",
      trigger: "rule",
      priority: 40,
      signal: { rule: "no_kb_support", unsupportedReplies: input.consecutiveUnsupportedAiReplies + 1, ...evidence },
    };
  }

  if (input.aiFailure) {
    return {
      escalate: true,
      reason: "low_confidence",
      trigger: "rule",
      priority: 45,
      signal: { rule: `ai_${input.aiFailure}`, ...evidence },
    };
  }

  return { escalate: false };
}

/**
 * Mensaje que ve el cliente al escalar (plantilla fija, sin LLM: rápido,
 * gratis y sin riesgo de que el modelo prometa algo indebido).
 */
export function handoffMessage(reason: EscalationReason): string {
  switch (reason) {
    case "possible_fraud":
      return (
        "Por tu seguridad, si no reconoces un cargo bloquea tu tarjeta ahora mismo desde la app (Tarjetas > Bloquear) " +
        "o en la Línea Cordillera. Te estoy comunicando con un asesor para revisar tu caso. Nunca te pediremos tu clave."
      );
    case "human_requested":
      return "Claro, te comunico con un asesor. En un momento te atiende una persona de nuestro equipo.";
    case "angry_customer":
    case "complaint":
      return "Lamento mucho la situación. Te comunico con un asesor para que revise tu caso personalmente.";
    default:
      return "Para ayudarte mejor, te comunico con un asesor. En un momento te atiende una persona de nuestro equipo.";
  }
}
