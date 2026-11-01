# Board responder

Evaluates whether the Decisions-only selector chooses the right existing discussion participant. The runner imports the production client and confidence policy; it does not use a provider registry, Responses, a proxy, or tool execution. All cases are authored synthetic data for the automatic board responder request.

From `evals/`:

```sh
pnpm board-responder --case migration-review --samples 1 --dry-run --out runs/board-preflight
pnpm board-responder --case migration-review --samples 1 --out runs/board-one
pnpm board-responder --samples 3 --out runs/board-full
pnpm board-responder --samples 3 --baseline runs/board-full/results.jsonl --out runs/board-compare
```

Supply `OPENAI_API_KEY` securely in the process environment. The script does not read credential files. Dry runs need no key and make no calls. Use a new output directory for every live run; existing result files are rejected.

| Model        | Endpoint                                   |
| ------------ | ------------------------------------------ |
| `gpt-6-luna` | `POST https://api.openai.com/v1/decisions` |

Flags are `--out` (required), `--model` (only the model above), `--case` (comma-separated ids), `--samples` (1–5, default 3), `--baseline` (earlier `results.jsonl`), and `--dry-run`. A full default run makes at most 30 sequential paid requests, each with one attempt, a 10-second deadline, and bounded request/response bytes. The run stops after its first transport, timeout, HTTP, rate-limit, or budget failure. Those samples are excluded from routing scores. Refusals and uncertain answers exercise the local fallback policy.

The runner records token usage when available. Dollar cost is not estimated: inspect billed usage for this model. A dry run costs $0. Never paste a key into arguments or commit results.

`results.jsonl` separates structural choice validity, accepted model choices, correct accepted choices, and routing after each case's authored deterministic fallback label. A schema-valid choice can still route to the wrong participant. `summary.json` also reports that authored fallback baseline, case majority verdicts, baseline regressions, and a threshold sweep. Half or more failed samples fail a case.

Calibration cases choose a proposed probability/margin threshold. Held-out cases only report its performance; they do not choose it. Acceptance requires both overall confidence and winning-choice probability of at least 0.95, with a 0.3 winning margin. These conservative defaults were chosen from the calibration cases, including an ambiguous case whose high winning-choice probability overstated confidence. The held-out checks still expose preferred-responder misses after deterministic fallback; these thresholds are not a production accuracy guarantee. The proposed threshold is a report, not an automatic production change. With ten small synthetic cases, neither high validity nor high accuracy establishes general routing quality. These client-boundary cases use opaque `candidate-N` labels and the production evidence envelope (`context`, `sourcePostIds`, `posts`) with authored discussion summaries and participant roles. They do not run the database roster/context builder or its fallback ordering.

Cases cover role-specific routing, origin and recent work context, greetings, status requests, acknowledgements that still deserve conversational replies, ambiguous evidence, and injected instructions in evidence or participant descriptions. Add cases to `cases.ts` with a source, fixed split, expected labels, and deterministic fallback label. The calibration split must remain separate from held-out cases. Keep authored data free of user transcripts or identifiers.

Explicit reply and mention bypass, single/zero eligibility, durable selection, Stop, stale roster validation, and delivery are exercised by the selection/service tests; this model replay does not reimplement those paths. Client tests cover missing keys, malformed/refused/incomplete responses, unknown labels, uncertain distributions, limits, one attempt, and timeout with mocked HTTP. Run those offline with:

```sh
vp test run apps/server/src/messageBoard/OpenAIDecisionsClient.test.ts evals/board-responder/grade.test.ts
```
