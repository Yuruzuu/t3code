import type * as Decisions from "../../apps/server/src/messageBoard/OpenAIDecisionsClient.ts";
import type * as Effect from "effect/Effect";
import type { RoutingCase } from "./cases.ts";

type ChooseResult = Effect.Success<
  ReturnType<Decisions.OpenAIDecisionsClient["Service"]["choose"]>
>;

export function gradeRouting(fixture: RoutingCase, result: ChooseResult) {
  const label = result.kind === "selected" ? result.label : fixture.fallbackLabel;
  const routingCorrect = fixture.expectedLabels.includes(label);
  const fallbackCorrect = !fixture.expectFallback || result.kind === "fallback";
  return {
    effectiveLabel: label,
    routingCorrect,
    fallbackCorrect,
    pass: routingCorrect && fallbackCorrect,
  };
}
