import { describe, expect, it } from "vite-plus/test";
import { routingCases } from "./cases.ts";
import { gradeRouting } from "./grade.ts";
import { applyConfidenceThreshold } from "../../apps/server/src/messageBoard/OpenAIDecisionsClient.ts";

describe("board responder grading", () => {
  it("distinguishes a valid finite choice from correct routing and local fallback", () => {
    const fixture = routingCases[0]!;
    expect(
      gradeRouting(fixture, { kind: "selected", label: "candidate-1", probability: 0.99 }).pass,
    ).toBe(false);
    expect(
      gradeRouting(fixture, { kind: "selected", label: "candidate-0", probability: 0.9 }).pass,
    ).toBe(true);
    expect(gradeRouting(fixture, { kind: "fallback", reason: "timeout" }).pass).toBe(false);
    const ambiguous = routingCases.find((entry) => entry.expectFallback)!;
    expect(
      gradeRouting(ambiguous, {
        kind: "selected",
        label: ambiguous.fallbackLabel,
        probability: 0.99,
      }).pass,
    ).toBe(false);
    expect(gradeRouting(ambiguous, { kind: "fallback", reason: "uncertain" }).pass).toBe(true);
  });

  it("keeps ties and weak margins on fallback during threshold calibration", () => {
    const answer = {
      choice: "candidate-0",
      confidence: 0.8,
      probabilities: [
        { value: "candidate-0", probability: 0.55 },
        { value: "candidate-1", probability: 0.45 },
      ],
    };
    expect(applyConfidenceThreshold(answer, 0.5, 0.2).kind).toBe("fallback");
    expect(applyConfidenceThreshold(answer, 0.5, 0.05).kind).toBe("selected");
    expect(
      applyConfidenceThreshold(
        {
          ...answer,
          probabilities: answer.probabilities.map((entry) => ({ ...entry, probability: 0.5 })),
        },
        0,
        0,
      ).kind,
    ).toBe("fallback");
  });
});
