import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BoardPostId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as HandlingEvents from "./MessageBoardHandlingEvents.ts";
import * as Handling from "./MessageBoardHandlingStore.ts";
import * as Dispatch from "./MessageBoardDispatchService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";

const rootId = BoardPostId.make("discussion");
const recipient = ThreadId.make("worker");
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO board_channels(name,created_by_json,created_at) VALUES('test','{"kind":"user"}','2026-10-30')`;
  for (const id of [rootId, "request-a", "request-b"])
    yield* sql`INSERT INTO board_posts(id,root_id,channel_name,author_json,text,created_at) VALUES(${id},${rootId},'test','{"kind":"user"}',${id},'2026-10-30')`;
  const store = yield* Handling.make;
  for (const postId of ["request-a", "request-b"])
    yield* store.createForPost({
      rootId,
      postId: BoardPostId.make(postId),
      suggestedLeadThreadId: null,
      recipients: [recipient],
    });
});
const layer = SqlitePersistence.layerMemory.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(HandlingEvents.layer),
  Layer.provideMerge(Layer.mock(ProjectionStore.ProjectionStoreV2)({})),
  Layer.provideMerge(EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
);

it.effect(
  "batches every request and reuses dispatch identity after a failed send and restart",
  () => {
    const admitted: Array<string> = [];
    let fail = true;
    return Effect.gen(function* () {
      yield* seed;
      const first = yield* Dispatch.make;
      const failed = yield* first.dispatchPending().pipe(Effect.result);
      assert.equal(failed._tag, "Failure");
      const restarted = yield* Dispatch.make;
      yield* restarted.dispatchPending();
      yield* restarted.dispatchPending();
      assert.lengthOf(admitted, 2);
      assert.equal(admitted[0], admitted[1]);
      const store = yield* Handling.make;
      const state = yield* store.snapshot(rootId);
      assert.lengthOf(state.responsibilities, 2);
      assert.equal(state.responsibilities[0]!.batchId, state.responsibilities[1]!.batchId);
      assert.isTrue(yield* store.validateBatch({ batchId: admitted[0]!, threadId: recipient }));
    }).pipe(
      Effect.provide(
        Layer.merge(
          layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Effect.succeed({ projectId: ProjectId.make("project") } as never),
            sendToThread: (input) =>
              Effect.suspend(() => {
                admitted.push(input.commandId);
                if (fail) {
                  fail = false;
                  return new ThreadManagementService.ThreadManagementProjectionLoadError({
                    projectId: ProjectId.make("project"),
                    threadId: recipient,
                    cause: new Error("send interrupted"),
                  });
                }
                return Effect.succeed({} as never);
              }),
          }),
        ),
      ),
    );
  },
);

it.effect(
  "rebuilds corrected context and rejects stale outcomes without scheduling more work",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Handling.make;
      const state = yield* store.snapshot(rootId);
      const request = state.responsibilities[0]!;
      yield* sql`INSERT INTO board_dispatch_batches(id,root_id,recipient_thread_id,requests_json) VALUES('batch',${rootId},${recipient},${`[{"id":"${request.id}","generation":0}]`})`;
      yield* sql`UPDATE board_responsibilities SET batch_id='batch',status='queued' WHERE id=${request.id}`;
      yield* sql`INSERT INTO board_posts(id,root_id,channel_name,author_json,text,created_at) VALUES('correction',${rootId},'test','{"kind":"user"}','Use the corrected source','2026-10-31')`;
      const context = yield* store.executionContext({
        batchId: "batch",
        threadId: recipient,
        runId: RunId.make("run"),
      });
      assert.include(context, "Use the corrected source");
      yield* sql`UPDATE board_discussions SET context_revision=context_revision+1 WHERE root_id=${rootId}`;
      const current = yield* store.snapshot(rootId);
      const stale = yield* store
        .reportOutcome({
          rootId,
          expectedRevision: current.revision,
          responsibilityId: request.id,
          expectedGeneration: 0,
          runId: RunId.make("run"),
          viewer: { kind: "thread", threadId: recipient },
          outcome: { kind: "completed", text: "Done", sourcePostIds: [] },
        })
        .pipe(Effect.result);
      assert.equal(stale._tag, "Failure");
      if (stale._tag === "Failure") assert.equal(stale.failure._tag, "MessageBoardError");
      yield* store.completeRun({ runId: RunId.make("run"), threadId: recipient });
      const finished = yield* store.snapshot(rootId);
      assert.equal(finished.responsibilities[0]!.status, "needs-attention");
      assert.equal(finished.responsibilities[1]!.status, "pending");
    }).pipe(Effect.provide(layer)),
);
