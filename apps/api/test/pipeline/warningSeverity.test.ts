import { describe, expect, it } from "vitest";
import { publicPlan } from "../../src/pipeline/orchestrator.js";
import type { PipelineRecoveryPlan as PipelinePlan } from "../../src/pipeline/types.js";

function planWith(
  warnings: Array<{
    symptom: string;
    action: string;
    severity?: "call-doctor" | "emergency";
  }>,
): PipelinePlan {
  return {
    documentId: "doc",
    generatedAt: new Date().toISOString(),
    medications: [],
    appointments: [],
    warnings: warnings.map((warning, index) => ({
      id: `w${index}`,
      symptom: warning.symptom,
      action: warning.action,
      severity: warning.severity,
      sourceLines: [1],
      confidence: 80,
    })),
    timeline: [],
    explanations: [],
    overallConfidence: 80,
  } as unknown as PipelinePlan;
}

const actionOf = (
  warning: Parameters<typeof planWith>[0][number],
): string => publicPlan(planWith([warning])).warnings[0]!.action;

/**
 * The stage's own `severity` is the authority. Text matching is a fallback and
 * used to run on bare substrings, which broke in both directions at once.
 */
describe("warning action mapping", () => {
  it("honours severity over the wording", () => {
    expect(actionOf({ symptom: "chest pain", action: "Seek urgent care", severity: "emergency" })).toBe(
      "emergency_room",
    );
    expect(actionOf({ symptom: "mild rash", action: "Go to the ER", severity: "call-doctor" })).toBe(
      "call_provider",
    );
  });

  it("does not escalate on 'er' inside an ordinary word", () => {
    // "provider" contains "er"; this used to report an ER visit.
    expect(actionOf({ symptom: "redness", action: "Call your provider", severity: "call-doctor" })).toBe(
      "call_provider",
    );
    expect(actionOf({ symptom: "swelling", action: "Call the surgery" })).toBe("call_provider");
  });

  it("still routes explicit emergency numbers to call_911", () => {
    expect(actionOf({ symptom: "slurred speech", action: "Call 911", severity: "emergency" })).toBe(
      "call_911",
    );
    expect(actionOf({ symptom: "collapse", action: "Call 999 immediately" })).toBe("call_911");
  });

  it("falls back to the wording when severity is absent", () => {
    expect(actionOf({ symptom: "fever", action: "Go to the ER" })).toBe("emergency_room");
    expect(actionOf({ symptom: "bleeding", action: "Seek urgent care" })).toBe("emergency_room");
    expect(actionOf({ symptom: "itching", action: "Call your doctor" })).toBe("call_provider");
  });
});
