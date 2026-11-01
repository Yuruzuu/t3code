import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as OpenAIDecisionsClient from "./OpenAIDecisionsClient.ts";

const input = {
  candidates: [
    { label: "option-a", name: "Database reviewer", role: "Persistence" },
    { label: "option-b", name: "Interface reviewer", role: "Accessibility" },
  ],
  context: "Latest user post: Please review the database migration.",
};
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      model: Schema.String,
      questions: Schema.Array(
        Schema.Struct({
          choices: Schema.Array(
            Schema.Struct({ value: Schema.String, description: Schema.String }),
          ),
        }),
      ),
      tools: Schema.optional(Schema.Unknown),
    }),
  ),
);
const answer = (choice = "option-a", probability = 0.99) => ({
  model: "gpt-6-luna",
  answers: [
    {
      type: "choice",
      name: "responder",
      choice,
      confidence: probability,
      probabilities: [
        { value: "option-a", probability },
        { value: "option-b", probability: 1 - probability },
      ],
    },
  ],
});

describe("OpenAIDecisionsClient", () => {
  it.effect("accepts only the supplied finite choice from the Decisions endpoint", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          expect(request.method).toBe("POST");
          expect(request.headers.authorization).toBe("Bearer fixture-key");
          if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON body");
          const body = decodeRequest(new TextDecoder().decode(request.body.body));
          expect(body.model).toBe("gpt-6-luna");
          expect(body.questions[0]!.choices).toEqual([
            { value: "option-a", description: "Database reviewer: Persistence" },
            { value: "option-b", description: "Interface reviewer: Accessibility" },
          ]);
          expect(body.tools).toBeUndefined();
          return HttpClientResponse.fromWeb(request, Response.json(answer()));
        }),
      );
      const result = yield* Effect.gen(function* () {
        return yield* (yield* OpenAIDecisionsClient.OpenAIDecisionsClient).choose(input);
      }).pipe(
        Effect.provide(
          OpenAIDecisionsClient.layerWithConfig({ apiKey: Redacted.make("fixture-key") }),
        ),
        Effect.provideService(HttpClient.HttpClient, http),
      );
      expect(result).toEqual({ kind: "selected", label: "option-a", probability: 0.99 });
      expect(requests).toEqual(["https://api.openai.com/v1/decisions"]);
    }),
  );

  it.effect("falls back once for rejected HTTP and invalid or uncertain answers", () =>
    Effect.gen(function* () {
      const unknown = answer("outsider");
      const duplicate = answer();
      duplicate.answers[0]!.probabilities[1]!.value = "option-a";
      const inconsistent = answer("option-b");
      const invalidProbability = answer("option-a", 1.5);
      const missingProbability = answer();
      missingProbability.answers[0]!.probabilities.pop();
      const lowConfidence = answer("option-a", 0.91);
      lowConfidence.answers[0]!.confidence = 0.69;
      const cases = [
        { response: Response.json({}, { status: 429 }), reason: "rate-limit" },
        {
          response: Response.json({ error: { code: "insufficient_quota" } }, { status: 429 }),
          reason: "budget-exhausted",
        },
        { response: Response.json({}, { status: 402 }), reason: "budget-exhausted" },
        { response: Response.json({}, { status: 503 }), reason: "http-error" },
        {
          response: Response.json({ answers: [{ type: "refusal", name: "responder" }] }),
          reason: "refusal",
        },
        { response: Response.json({ answers: [] }), reason: "incomplete" },
        { response: new Response("not json"), reason: "malformed-response" },
        { response: Response.json(unknown), reason: "unknown-label" },
        { response: Response.json(duplicate), reason: "malformed-response" },
        { response: Response.json(inconsistent), reason: "malformed-response" },
        { response: Response.json(invalidProbability), reason: "malformed-response" },
        { response: Response.json(missingProbability), reason: "incomplete" },
        { response: Response.json(answer("option-a", 0.5)), reason: "uncertain" },
        { response: Response.json(answer("option-a", 0.65)), reason: "uncertain" },
        { response: Response.json(lowConfidence), reason: "uncertain" },
        { response: new Response("x".repeat(65_537)), reason: "malformed-response" },
      ];
      for (const fixture of cases) {
        let attempts = 0;
        const result = yield* Effect.gen(function* () {
          return yield* (yield* OpenAIDecisionsClient.OpenAIDecisionsClient).choose(input);
        }).pipe(
          Effect.provide(
            OpenAIDecisionsClient.layerWithConfig({ apiKey: Redacted.make("fixture-key") }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              attempts += 1;
              return Effect.succeed(HttpClientResponse.fromWeb(request, fixture.response));
            }),
          ),
        );
        expect(result).toEqual({ kind: "fallback", reason: fixture.reason });
        expect(attempts).toBe(1);
      }
    }),
  );

  it.effect("maps transport failures without exposing the request or retrying", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const result = yield* Effect.gen(function* () {
        return yield* (yield* OpenAIDecisionsClient.OpenAIDecisionsClient).choose(input);
      }).pipe(
        Effect.provide(
          OpenAIDecisionsClient.layerWithConfig({ apiKey: Redacted.make("fixture-key") }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            attempts += 1;
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: new Error("fixture-key must never escape"),
                }),
              }),
            );
          }),
        ),
      );
      expect(result).toEqual({ kind: "fallback", reason: "transport-error" });
      expect(attempts).toBe(1);
    }),
  );

  it.effect("makes no network call with a missing key or out-of-bounds evidence", () =>
    Effect.gen(function* () {
      const http = HttpClient.make(() => Effect.die("No request is allowed"));
      for (const fixture of [
        { config: {}, request: input, reason: "missing-key" },
        { config: { apiKey: Redacted.make(" ") }, request: input, reason: "missing-key" },
        {
          config: { apiKey: Redacted.make("fixture-key") },
          request: { ...input, context: "x".repeat(16_001) },
          reason: "invalid-input",
        },
        {
          config: { apiKey: Redacted.make("fixture-key") },
          request: { ...input, candidates: [input.candidates[0]!, input.candidates[0]!] },
          reason: "invalid-input",
        },
      ]) {
        const result = yield* Effect.gen(function* () {
          return yield* (yield* OpenAIDecisionsClient.OpenAIDecisionsClient).choose(
            fixture.request,
          );
        }).pipe(
          Effect.provide(OpenAIDecisionsClient.layerWithConfig(fixture.config)),
          Effect.provideService(HttpClient.HttpClient, http),
        );
        expect(result).toEqual({ kind: "fallback", reason: fixture.reason });
      }
    }),
  );

  it.effect("interrupts one stalled HTTP attempt at its finite deadline", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let attempts = 0;
      const fiber = yield* Effect.gen(function* () {
        return yield* (yield* OpenAIDecisionsClient.OpenAIDecisionsClient).choose(input);
      }).pipe(
        Effect.provide(
          OpenAIDecisionsClient.layerWithConfig({ apiKey: Redacted.make("fixture-key") }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.gen(function* () {
              attempts += 1;
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber)).toEqual({ kind: "fallback", reason: "timeout" });
      expect(attempts).toBe(1);
    }),
  );
});
