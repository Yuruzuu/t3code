#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Decisions from "../../apps/server/src/messageBoard/OpenAIDecisionsClient.ts";
import { routingCases } from "./cases.ts";
import { gradeRouting } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "gpt-6-luna" },
    baseline: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
    "dry-run": { type: "boolean", default: false },
  },
});
if (!values.out || values.model !== "gpt-6-luna") {
  throw new Error("Use --out <directory>; only the Decisions model gpt-6-luna is supported.");
}
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 1 || samples > 5)
  throw new Error("Use 1 to 5 samples.");
const requested = values.case?.split(",");
const fixtures = routingCases.filter((fixture) => !requested || requested.includes(fixture.id));
if (
  fixtures.length === 0 ||
  requested?.some((id) => !fixtures.some((fixture) => fixture.id === id))
) {
  throw new Error("Unknown or empty case selection.");
}
const outputDirectory = NodePath.resolve(values.out);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const finiteProbability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const ObservedResponse = Schema.Struct({
  answers: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("choice"),
      name: Schema.Literal("responder"),
      choice: Schema.String,
      confidence: finiteProbability,
      probabilities: Schema.Array(
        Schema.Struct({ value: Schema.String, probability: finiteProbability }),
      ),
    }),
  ),
  usage: Schema.optional(
    Schema.Struct({
      input_tokens: Schema.Number,
      output_tokens: Schema.Number,
      total_tokens: Schema.Number,
    }),
  ),
});
const decodeObserved = Schema.decodeUnknownOption(Schema.fromJsonString(ObservedResponse));
const BaselineRow = Schema.Struct({
  id: Schema.String,
  sample: Schema.Number,
  pass: Schema.Boolean,
});
const decodeBaselineRow = Schema.decodeUnknownSync(Schema.fromJsonString(BaselineRow));

type Result = Effect.Success<ReturnType<Decisions.OpenAIDecisionsClient["Service"]["choose"]>>;
type Row = ReturnType<typeof gradeRouting> & {
  id: string;
  split: "calibration" | "held-out";
  sample: number;
  result: Result;
  schemaValid: boolean;
  infrastructureFailure: boolean;
  rawAnswer?: (typeof ObservedResponse.Type)["answers"][number];
  usage?: (typeof ObservedResponse.Type)["usage"];
};

async function run() {
  await NodeFSP.mkdir(outputDirectory, { recursive: true });
  if (values["dry-run"]) {
    await NodeFSP.writeFile(
      NodePath.join(outputDirectory, "requests.json"),
      encodeJson({
        model: values.model,
        samples,
        maximumCalls: samples * fixtures.length,
        fixtures,
      }),
    );
    await Effect.runPromise(
      Console.log(
        `${fixtures.length} authored cases, at most ${samples * fixtures.length} paid calls; no calls made.`,
      ),
    );
    return;
  }
  if (!process.env.OPENAI_API_KEY?.trim())
    throw new Error("Provide OPENAI_API_KEY securely in the process environment.");
  const baseline = values.baseline
    ? (await NodeFSP.readFile(values.baseline, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => decodeBaselineRow(line))
    : undefined;
  if (baseline && fixtures.some((fixture) => !baseline.some((row) => row.id === fixture.id))) {
    throw new Error("Baseline is missing selected cases.");
  }
  const rows: Row[] = [];
  const resultsFile = await NodeFSP.open(NodePath.join(outputDirectory, "results.jsonl"), "wx");
  await resultsFile.close();
  let calls = 0;
  const underlyingFetch = await Effect.runPromise(FetchHttpClient.Fetch);
  const liveLayer = Decisions.layer.pipe(Layer.provide(FetchHttpClient.layer));
  caseLoop: for (const fixture of fixtures) {
    for (let sample = 1; sample <= samples; sample += 1) {
      let capturedText = "";
      let capturedBytes = 0;
      const decoder = new TextDecoder();
      const observedFetch: typeof fetch = async (url, init) => {
        calls += 1;
        const response = await underlyingFetch(url, init);
        if (response.body === null) return response;
        return new Response(
          response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                capturedBytes += chunk.byteLength;
                if (capturedBytes <= 65_536)
                  capturedText += decoder.decode(chunk, { stream: true });
                controller.enqueue(chunk);
              },
              flush() {
                capturedText += decoder.decode();
              },
            }),
          ),
          { status: response.status, headers: response.headers },
        );
      };
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Decisions.OpenAIDecisionsClient).choose(fixture.input);
        }).pipe(
          Effect.provide(liveLayer),
          Effect.provideService(FetchHttpClient.Fetch, observedFetch),
        ),
      );
      const observed = capturedBytes <= 65_536 ? decodeObserved(capturedText) : Option.none();
      const parsed = Option.getOrUndefined(observed);
      const rawAnswer = parsed?.answers.length === 1 ? parsed.answers[0] : undefined;
      const row: Row = {
        id: fixture.id,
        split: fixture.split,
        sample,
        result,
        schemaValid: rawAnswer !== undefined,
        infrastructureFailure:
          result.kind === "fallback" &&
          [
            "missing-key",
            "rate-limit",
            "budget-exhausted",
            "http-error",
            "transport-error",
            "timeout",
          ].includes(result.reason),
        ...gradeRouting(fixture, result),
        ...(rawAnswer ? { rawAnswer } : {}),
        ...(parsed?.usage ? { usage: parsed.usage } : {}),
      };
      rows.push(row);
      await NodeFSP.appendFile(
        NodePath.join(outputDirectory, "results.jsonl"),
        `${encodeJson(row)}\n`,
      );
      await Effect.runPromise(
        Console.log(
          `${fixture.id} sample ${sample}: ${row.pass ? "pass" : "fail"} (${result.kind})`,
        ),
      );
      if (row.infrastructureFailure) break caseLoop;
    }
  }
  const policies = [];
  const scoredRows = rows.filter((row) => !row.infrastructureFailure);
  for (const minimumProbability of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99]) {
    for (const minimumMargin of [0.1, 0.2, 0.3]) {
      const scored = scoredRows.map((row) => {
        const fixture = fixtures.find((entry) => entry.id === row.id)!;
        const usable =
          row.rawAnswer &&
          !["malformed-response", "unknown-label", "incomplete"].includes(
            row.result.kind === "fallback" ? row.result.reason : "",
          );
        const result = usable
          ? Decisions.applyConfidenceThreshold(row.rawAnswer!, minimumProbability, minimumMargin)
          : row.result;
        return {
          split: row.split,
          ...gradeRouting(fixture, result),
          selected: result.kind === "selected",
        };
      });
      policies.push({
        minimumProbability,
        minimumMargin,
        calibrationPasses: scored.filter((row) => row.split === "calibration" && row.pass).length,
        heldOutPasses: scored.filter((row) => row.split === "held-out" && row.pass).length,
        accepted: scored.filter((row) => row.selected).length,
      });
    }
  }
  policies.sort(
    (left, right) =>
      right.calibrationPasses - left.calibrationPasses ||
      right.minimumProbability - left.minimumProbability ||
      right.minimumMargin - left.minimumMargin,
  );
  const selected = scoredRows.filter((row) => row.result.kind === "selected");
  const summary = {
    model: values.model,
    calls,
    samples,
    completedSamples: rows.length,
    scoredSamples: scoredRows.length,
    infrastructureFailures: rows
      .filter((row) => row.infrastructureFailure)
      .map((row) => ({ id: row.id, sample: row.sample, result: row.result })),
    structurallyValidChoices: rows.filter((row) => row.schemaValid).length,
    acceptedChoices: selected.length,
    correctAcceptedChoices: selected.filter((row) => row.routingCorrect).length,
    routingPassesWithAuthoredFallback: scoredRows.filter((row) => row.pass).length,
    authoredDeterministicBaselinePasses: scoredRows.filter((row) =>
      fixtures
        .find((fixture) => fixture.id === row.id)!
        .expectedLabels.includes(fixtures.find((fixture) => fixture.id === row.id)!.fallbackLabel),
    ).length,
    caseVerdicts: fixtures.map((fixture) => {
      const samplesForCase = scoredRows.filter((row) => row.id === fixture.id);
      return {
        id: fixture.id,
        samples: samplesForCase.length,
        pass:
          samplesForCase.length > 0
            ? samplesForCase.filter((row) => row.pass).length > samplesForCase.length / 2
            : null,
      };
    }),
    baselineRegressions: baseline
      ? fixtures
          .filter((fixture) => {
            const before = baseline.filter((row) => row.id === fixture.id);
            const after = scoredRows.filter((row) => row.id === fixture.id);
            return (
              after.length > 0 &&
              before.filter((row) => row.pass).length > before.length / 2 &&
              after.filter((row) => row.pass).length <= after.length / 2
            );
          })
          .map((fixture) => fixture.id)
      : null,
    tokens: rows.reduce((sum, row) => sum + (row.usage?.total_tokens ?? 0), 0),
    cost: "Billed by OpenAI; dollar cost not estimated. Token usage may be absent for failed calls.",
    proposedThresholdFromCalibrationOnly: scoredRows.some((row) => row.split === "calibration")
      ? policies[0]
      : null,
    thresholdSweep: policies,
    limitation:
      "Synthetic client-boundary cases use the production evidence envelope with authored summaries/roles and fixed fallback labels; they do not execute the database roster/fallback path. Schema validity is not routing accuracy. Held-out scores do not choose thresholds. Missing-key/transport/refusal/malformed/timeout behavior and explicit reply/mention bypass are covered by focused source tests, not this paid model replay.",
  };
  await NodeFSP.writeFile(NodePath.join(outputDirectory, "summary.json"), encodeJson(summary));
  await Effect.runPromise(
    Console.log(
      `Wrote ${rows.length} rows and summary.json. Schema validity and routing accuracy are reported separately.`,
    ),
  );
}

await run().catch(async () => {
  await Effect.runPromise(
    Console.error(
      "Board responder eval failed. Check arguments, output directory, and securely supplied OPENAI_API_KEY; credentials and upstream errors are omitted.",
    ),
  );
  process.exitCode = 1;
});
