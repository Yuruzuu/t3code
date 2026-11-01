import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { withBoardHandlingLock } from "./BoardHandlingGuard.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

it.effect("serializes provider acceptance with Stop on every ancestor", () =>
  Effect.gen(function* () {
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const accepted = yield* Deferred.make<void>();
    const stopRequested = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const order: Array<string> = [];
    const provider = yield* withBoardHandlingLock(
      ThreadId.make("child"),
      Effect.gen(function* () {
        order.push("starting");
        yield* Deferred.succeed(accepted, undefined);
        yield* Deferred.await(release);
        order.push("accepted");
      }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(accepted);
    const stop = yield* Effect.gen(function* () {
      yield* Deferred.succeed(stopRequested, undefined);
      yield* executor.withLock(
        ThreadId.make("grandparent"),
        Effect.sync(() => order.push("stopped")),
      );
    }).pipe(Effect.forkChild);
    yield* Deferred.await(stopRequested);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(provider);
    yield* Fiber.join(stop);
    assert.deepEqual(order, ["starting", "accepted", "stopped"]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: (threadId) =>
            Effect.succeed({
              thread: {
                lineage: {
                  relationshipToParent: threadId === "grandparent" ? null : "subagent",
                  parentThreadId:
                    threadId === "child" ? "parent" : threadId === "parent" ? "grandparent" : null,
                },
              },
            } as never),
        }),
      ),
    ),
  ),
);
