import { describe, expect, it } from "vitest";
import {
  decideEscalation,
  handoffMessage,
  type EscalationInput,
  type TurnSignals,
} from "../../src/modules/engine/escalationRules";

const turn = (
  intent: TurnSignals["intent"],
  sentiment: TurnSignals["sentiment"] = "neutral",
  confidence = 0.9
): TurnSignals => ({
  intent,
  sentiment,
  confidence,
});

const base = (current: TurnSignals, overrides: Partial<EscalationInput> = {}): EscalationInput => ({
  current,
  previousCustomerTurns: [],
  consecutiveUnsupportedAiReplies: 0,
  kbSupportFound: true,
  aiFailure: null,
  ...overrides,
});

describe("motor de escalamiento: cada regla", () => {
  it("posible fraude con confianza suficiente → prioridad 90, señal de IA", () => {
    expect(decideEscalation(base(turn("possible_fraud")))).toMatchObject({
      escalate: true,
      reason: "possible_fraud",
      trigger: "ai_signal",
      priority: 90,
    });
  });

  it("posible fraude con confianza BAJA no escala por sí solo", () => {
    expect(decideEscalation(base(turn("possible_fraud", "neutral", 0.4))).escalate).toBe(false);
  });

  it("pedir un humano escala siempre, aunque la confianza sea baja (se respeta al cliente)", () => {
    expect(decideEscalation(base(turn("human_request", "neutral", 0.3)))).toMatchObject({
      reason: "human_requested",
      trigger: "customer_request",
      priority: 60,
    });
  });

  it("cliente enojado → angry_customer prioridad 70", () => {
    expect(decideEscalation(base(turn("general_inquiry", "angry")))).toMatchObject({
      reason: "angry_customer",
      priority: 70,
    });
  });

  it("un reclamo AISLADO no escala (la IA orienta); dos seguidos sí", () => {
    expect(decideEscalation(base(turn("complaint", "negative"))).escalate).toBe(false);
    expect(
      decideEscalation(base(turn("complaint", "negative"), { previousCustomerTurns: [turn("complaint", "negative")] }))
    ).toMatchObject({ reason: "complaint", trigger: "rule", priority: 55 });
  });

  it("la misma intención tres turnos seguidos → repeated_failure", () => {
    const previous = [turn("account_access"), turn("account_access")];
    expect(decideEscalation(base(turn("account_access"), { previousCustomerTurns: previous }))).toMatchObject({
      reason: "repeated_failure",
      priority: 50,
    });
  });

  it("…pero no para consultas generales: preguntar varias cosas distintas es normal", () => {
    const previous = [turn("general_inquiry"), turn("general_inquiry")];
    expect(decideEscalation(base(turn("general_inquiry"), { previousCustomerTurns: previous })).escalate).toBe(false);
  });

  it("sin apoyo en la KB dos veces seguidas → low_confidence; la primera vez no", () => {
    expect(decideEscalation(base(turn("general_inquiry"), { kbSupportFound: false })).escalate).toBe(false);
    expect(
      decideEscalation(base(turn("general_inquiry"), { kbSupportFound: false, consecutiveUnsupportedAiReplies: 1 }))
    ).toMatchObject({ reason: "low_confidence", priority: 40 });
  });

  it("si la IA falla o declina, el cliente no queda sin respuesta: escala", () => {
    expect(decideEscalation(base(turn("general_inquiry"), { aiFailure: "unavailable" }))).toMatchObject({
      reason: "low_confidence",
      signal: expect.objectContaining({ rule: "ai_unavailable" }),
    });
    expect(decideEscalation(base(turn("general_inquiry"), { aiFailure: "refusal" }))).toMatchObject({
      signal: expect.objectContaining({ rule: "ai_refusal" }),
    });
  });

  it("sin clasificación (el clasificador falló) solo aplican las reglas que no dependen de ella", () => {
    const unknown: TurnSignals = { intent: null, sentiment: null, confidence: null };
    expect(decideEscalation(base(unknown)).escalate).toBe(false);
    expect(decideEscalation(base(unknown, { aiFailure: "unavailable" })).escalate).toBe(true);
  });
});

describe("motor de escalamiento: precedencia", () => {
  it("fraude gana a todo lo demás (aunque además pida humano y esté enojado)", () => {
    const decision = decideEscalation(
      base(turn("possible_fraud", "angry"), {
        previousCustomerTurns: [turn("human_request")],
        aiFailure: "unavailable",
      })
    );
    expect(decision).toMatchObject({ reason: "possible_fraud", priority: 90 });
  });

  it("pedir humano gana al enojo (se registra lo que el cliente pidió)", () => {
    expect(decideEscalation(base(turn("human_request", "angry")))).toMatchObject({ reason: "human_requested" });
  });

  it("una consulta tranquila con apoyo en la KB no escala", () => {
    expect(decideEscalation(base(turn("general_inquiry", "positive")))).toEqual({ escalate: false });
  });

  it("la evidencia guardada no incluye texto del cliente, solo señales", () => {
    const decision = decideEscalation(base(turn("possible_fraud")));
    if (!decision.escalate) throw new Error("debía escalar");
    expect(Object.keys(decision.signal).sort()).toEqual(["confidence", "intent", "rule", "sentiment"]);
  });
});

describe("mensaje de traspaso", () => {
  it("en fraude incluye la instrucción de seguridad y nunca pide la clave", () => {
    const text = handoffMessage("possible_fraud");
    expect(text).toMatch(/bloquea tu tarjeta/i);
    expect(text).toMatch(/nunca te pediremos tu clave/i);
  });
});
