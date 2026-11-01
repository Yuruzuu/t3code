import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BoardPostId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SelectionStore from "./MessageBoardSelectionStore.ts";

const rootId = BoardPostId.make("discussion");
const now = "2026-10-30T00:00:00.000Z";
const layer = SqlitePersistence.layerMemory.pipe(Layer.provideMerge(NodeServices.layer));
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO board_channels(name,created_by_json,created_at) VALUES('test','{"kind":"user"}',${now})`;
  for (const id of [rootId, "a", "b"])
    yield* sql`INSERT INTO board_posts(id,root_id,channel_name,author_json,text,created_at) VALUES(${id},${rootId},'test','{"kind":"user"}',${id},${now})`;
});

it.effect("commits exact source membership with its post transaction and claims only once", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* SelectionStore.make;
    yield* sql.withTransaction(store.createIntent({ rootId, postId: BoardPostId.make("a"), now }));
    const [selection] = yield* store.list(rootId);
    assert.isDefined(selection);
    assert.deepEqual(selection!.sourcePostIds, [BoardPostId.make("a")]);
    const claims = yield* Effect.forEach([1, 2], () => store.claim(selection!.id, now), {
      concurrency: 2,
    });
    assert.equal(claims.filter(Boolean).length, 1);
    const aborted = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* store.createIntent({ rootId, postId: BoardPostId.make("b"), now });
          return yield* Effect.fail("abort");
        }),
      )
      .pipe(Effect.result);
    assert.equal(aborted._tag, "Failure");
    assert.equal((yield* store.list(rootId)).length, 1);
  }).pipe(Effect.provide(layer)),
);

import { ThreadId, ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as HandlingEvents from "./MessageBoardHandlingEvents.ts";
import * as Responder from "./MessageBoardResponderSelection.ts";
import * as Decisions from "./OpenAIDecisionsClient.ts";

const first = ThreadId.make("first");
const second = ThreadId.make("second");
const serviceLayer = EffectOutbox.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(HandlingEvents.layer),
  Layer.provideMerge(NodeServices.layer),
);
const projections = (archived = new Set<string>()) =>
  Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThreadShell: (id) =>
      Effect.succeed({
        id,
        title: id,
        projectId: ProjectId.make("project"),
        archivedAt: archived.has(id) ? now : null,
        deletedAt: null,
      } as never),
    getThreadRecords: (id) =>
      Effect.succeed({
        thread: {
          archivedAt: archived.has(id) ? now : null,
          deletedAt: null,
          lineage: { relationshipToParent: "root" },
        },
        runs: [],
        turnItems: [],
      } as never),
  });
const subscribe = Effect.fn("test.subscribeResponder")(function* (...ids: ThreadId[]) {
  const sql = yield* SqlClient.SqlClient;
  for (const id of ids)
    yield* sql`INSERT INTO board_subscriptions(viewer_key,target_kind,target,enabled) VALUES(${`thread:${id}`},'thread',${rootId},1)`;
});
const intent = Effect.gen(function* () {
  const store = yield* SelectionStore.make;
  yield* store.createIntent({ rootId, postId: BoardPostId.make("a"), now });
});

it.effect("keeps durable selection running when its posting request disconnects", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* subscribe(first, second);
    yield* intent;
    const called = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const events = yield* HandlingEvents.MessageBoardHandlingEvents;
    const updates = yield* PubSub.subscribe(events.changes);
    const responder = yield* Responder.make.pipe(
      Effect.provideService(Decisions.OpenAIDecisionsClient, {
        choose: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(called, undefined);
            yield* Deferred.await(release);
            return { kind: "selected" as const, label: "candidate-1", probability: 0.99 };
          }).pipe(Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined))),
      }),
    );
    const request = yield* responder.activate(rootId).pipe(Effect.forkChild);
    yield* Deferred.await(called);
    yield* Fiber.interrupt(request);
    assert.ok(Option.isNone(yield* Deferred.poll(cancelled)));
    yield* Deferred.succeed(release, undefined);
    yield* PubSub.take(updates);
    const [selected] = yield* (yield* SelectionStore.make).list(rootId);
    assert.equal(selected!.status, "selected");
    assert.equal(selected!.method, "decisions");
  }).pipe(Effect.provide(Layer.merge(serviceLayer, projections()))),
);

it.effect(
  "recovers retained unavailable work on fresh activation without repeating a model call",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* intent;
      const service = yield* Responder.make;
      yield* service.activate(rootId);
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* (yield* SelectionStore.make).list(rootId))[0]!.status, "unavailable");
      yield* service.activate(rootId);
      assert.lengthOf(
        yield* sql`SELECT id FROM board_posts WHERE json_extract(author_json,'$.kind')='system'`,
        1,
      );
      yield* subscribe(first);
      yield* service.activate(rootId);
      const [selected] = yield* (yield* SelectionStore.make).list(rootId);
      assert.equal(selected!.status, "selected");
      assert.equal(selected!.recipientThreadId, first);
      assert.equal(selected!.generation, 1);
      assert.deepEqual(selected!.sourcePostIds, [BoardPostId.make("a")]);
      assert.lengthOf(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, 1);
    }).pipe(Effect.provide(Layer.merge(serviceLayer, projections()))),
);

it.effect(
  "selects the only eligible participant once and commits its real dispatch without a lead",
  () => {
    let calls = 0;
    return Effect.gen(function* () {
      yield* seed;
      yield* subscribe(first);
      yield* intent;
      const service = yield* Responder.make;
      yield* Effect.forEach([1, 2], () => service.activate(rootId), { concurrency: 2 });
      const sql = yield* SqlClient.SqlClient;
      const [selection] = yield* (yield* SelectionStore.make).list(rootId);
      assert.equal(selection!.recipientThreadId, first);
      assert.equal(selection!.method, "single");
      assert.equal(calls, 0);
      assert.lengthOf(yield* sql`SELECT * FROM board_responsibilities`, 1);
      assert.lengthOf(
        yield* sql`SELECT * FROM orchestration_v2_effect_outbox WHERE thread_id=${first}`,
        1,
      );
      assert.deepEqual(yield* sql`SELECT lead_thread_id FROM board_discussions`, [
        { lead_thread_id: null },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          serviceLayer,
          projections(),
          Layer.succeed(Decisions.OpenAIDecisionsClient, {
            choose: () =>
              Effect.sync(() => {
                calls++;
                return { kind: "selected" as const, label: "candidate-0", probability: 1 };
              }),
          }),
        ),
      ),
    );
  },
);

it.effect(
  "falls back to the most recent known respondent without inspecting unrelated threads",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* subscribe(first, second);
      yield* intent;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO board_posts(id,root_id,channel_name,author_json,text,created_at) VALUES('response',${rootId},'test',${JSON.stringify({ kind: "agent", threadId: second })},'Known response',${now})`;
      yield* sql`INSERT INTO board_subscriptions(viewer_key,target_kind,target,enabled) VALUES('thread:private','thread','unrelated',1)`;
      yield* (yield* Responder.make).activate(rootId);
      const [selection] = yield* (yield* SelectionStore.make).list(rootId);
      assert.equal(selection!.recipientThreadId, second);
      assert.equal(selection!.fallbackReason, "missing-key");
    }).pipe(Effect.provide(Layer.merge(serviceLayer, projections()))),
);

it.effect(
  "recovers after call-start with deterministic fallback and never repeats the paid call",
  () => {
    let calls = 0;
    return Effect.gen(function* () {
      yield* seed;
      yield* subscribe(first, second);
      yield* intent;
      const store = yield* SelectionStore.make;
      const [selection] = yield* store.list(rootId);
      yield* store.claim(selection!.id, now);
      yield* store.recordCallStarted({
        id: selection!.id,
        generation: 0,
        now,
        contextFingerprint: "old",
        rosterFingerprint: "old",
      });
      yield* (yield* Responder.make).recover();
      yield* (yield* Responder.make).recover();
      const [recovered] = yield* store.list(rootId);
      assert.equal(recovered!.status, "selected");
      assert.equal(recovered!.fallbackReason, "interrupted");
      assert.equal(calls, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          serviceLayer,
          projections(),
          Layer.succeed(Decisions.OpenAIDecisionsClient, {
            choose: () =>
              Effect.sync(() => {
                calls++;
                return { kind: "selected" as const, label: "candidate-1", probability: 1 };
              }),
          }),
        ),
      ),
    );
  },
);

it.effect("rejects a stale API choice against the current roster without another call", () => {
  const archived = new Set<string>();
  let calls = 0;
  return Effect.gen(function* () {
    yield* seed;
    yield* subscribe(first, second);
    yield* intent;
    yield* (yield* Responder.make).activate(rootId);
    const [selection] = yield* (yield* SelectionStore.make).list(rootId);
    assert.equal(selection!.recipientThreadId, second);
    assert.equal(selection!.fallbackReason, "stale-context");
    assert.equal(calls, 1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        serviceLayer,
        projections(archived),
        Layer.succeed(Decisions.OpenAIDecisionsClient, {
          choose: () =>
            Effect.sync(() => {
              calls++;
              archived.add(first);
              return { kind: "selected" as const, label: "candidate-0", probability: 1 };
            }),
        }),
      ),
    ),
  );
});

it.effect("bounds an interrupted network request by the persisted selection deadline", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* subscribe(first, second);
    const store = yield* SelectionStore.make;
    yield* store.createIntent({
      rootId,
      postId: BoardPostId.make("a"),
      now: "1970-01-01T00:00:00.000Z",
      deadlineAt: "1970-01-01T00:00:05.000Z",
    });
    const called = yield* Deferred.make<void>();
    const service = yield* Responder.make.pipe(
      Effect.provideService(Decisions.OpenAIDecisionsClient, {
        choose: () => Deferred.succeed(called, undefined).pipe(Effect.andThen(Effect.never)),
      }),
    );
    const running = yield* service.activate(rootId).pipe(Effect.forkChild);
    yield* Deferred.await(called);
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(running);
    const [selection] = yield* store.list(rootId);
    assert.equal(selection!.status, "selected");
    assert.equal(selection!.fallbackReason, "timeout");
  }).pipe(Effect.provide(Layer.merge(serviceLayer, projections()))),
);

it.effect("persists one honest system acknowledgement when no participant is available", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* intent;
    const service = yield* Responder.make;
    yield* service.activate(rootId);
    yield* service.recover();
    const sql = yield* SqlClient.SqlClient;
    const [selection] = yield* (yield* SelectionStore.make).list(rootId);
    assert.equal(selection!.status, "unavailable");
    assert.deepEqual(selection!.sourcePostIds, [BoardPostId.make("a")]);
    assert.lengthOf(yield* sql`SELECT * FROM board_responsibilities`, 0);
    assert.lengthOf(
      yield* sql`SELECT * FROM board_posts WHERE json_extract(author_json,'$.kind')='system'`,
      1,
    );
    assert.lengthOf(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`, 0);
  }).pipe(Effect.provide(Layer.merge(serviceLayer, projections()))),
);

it.effect("batches only unclaimed user posts and freezes exact membership before a paid call", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* subscribe(first);
    const store = yield* SelectionStore.make;
    const id = yield* store.createIntent({ rootId, postId: BoardPostId.make("a"), now });
    assert.equal(yield* store.createIntent({ rootId, postId: BoardPostId.make("b"), now }), id);
    const selected = yield* (yield* Responder.make).activate(rootId);
    assert.deepEqual(selected[0]!.sourcePostIds, [BoardPostId.make("a"), BoardPostId.make("b")]);
    const sql = yield* SqlClient.SqlClient;
    assert.lengthOf(yield* sql`SELECT * FROM board_responsibilities WHERE selection_id=${id}`, 2);
    assert.lengthOf(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`, 1);
    yield* sql`INSERT INTO board_posts(id,root_id,channel_name,author_json,text,created_at) VALUES('agent-post',${rootId},'test',${JSON.stringify({ kind: "agent", threadId: first })},'Agent chatter',${now})`;
    const rejected = yield* store
      .createIntent({ rootId, postId: BoardPostId.make("agent-post"), now })
      .pipe(Effect.result);
    assert.equal(rejected._tag, "Failure");
    assert.lengthOf(yield* store.list(rootId), 1);
  }).pipe(Effect.provide(Layer.merge(serviceLayer, projections()))),
);

it.effect(
  "rolls back a failed selected dispatch and leaves a durable unavailable acknowledgement",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* subscribe(first);
      yield* intent;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER reject_selection_dispatch BEFORE INSERT ON orchestration_v2_effect_outbox
      WHEN NEW.effect_id LIKE 'board-selected:%' BEGIN SELECT RAISE(ABORT,'dispatch rejected'); END`;
      yield* (yield* Responder.make).activate(rootId);
      const [selection] = yield* (yield* SelectionStore.make).list(rootId);
      assert.equal(selection!.status, "unavailable");
      assert.equal(selection!.fallbackReason, "interrupted");
      assert.lengthOf(yield* sql`SELECT * FROM board_responsibilities`, 0);
      assert.lengthOf(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`, 0);
      assert.lengthOf(
        yield* sql`SELECT * FROM board_posts WHERE json_extract(author_json,'$.kind')='system'`,
        1,
      );
    }).pipe(Effect.provide(Layer.merge(serviceLayer, projections()))),
);

const prepareAutomaticBatch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [selection] = yield* (yield* SelectionStore.make).list(rootId);
  yield* sql`INSERT INTO board_dispatch_batches(id,root_id,recipient_thread_id,requests_json) VALUES('batch',${rootId},${first},'[]')`;
  yield* sql`UPDATE board_responsibilities SET batch_id='batch',status='running',run_id='prepared-run' WHERE selection_id=${selection!.id}`;
});

it.effect(
  "reselects prestart automatic duties and preserves explicit recipients in a mixed batch",
  () => {
    const archived = new Set<string>();
    return Effect.gen(function* () {
      yield* seed;
      yield* subscribe(first, second);
      yield* intent;
      const service = yield* Responder.make;
      yield* service.activate(rootId);
      yield* prepareAutomaticBatch;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO board_responsibilities(id,root_id,post_id,recipient_thread_id,status,batch_id,run_id) VALUES('explicit',${rootId},'b',${first},'running','batch','prepared-run')`;
      archived.add(first);
      assert.isFalse(yield* service.reselectBeforeStart({ batchId: "batch", threadId: first }));
      const [selection] = yield* (yield* SelectionStore.make).list(rootId);
      assert.equal(selection!.generation, 1);
      assert.equal(selection!.recipientThreadId, second);
      assert.deepEqual(
        yield* sql`SELECT recipient_thread_id,status,generation,batch_id,run_id FROM board_responsibilities WHERE id='explicit'`,
        [
          {
            recipient_thread_id: first,
            status: "pending",
            generation: 1,
            batch_id: null,
            run_id: null,
          },
        ],
      );
      assert.deepEqual(
        yield* sql`SELECT recipient_thread_id,generation,selection_generation FROM board_responsibilities WHERE selection_id=${selection!.id}`,
        [{ recipient_thread_id: second, generation: 1, selection_generation: 1 }],
      );
      assert.deepEqual(yield* sql`SELECT status FROM board_dispatch_batches WHERE id='batch'`, [
        { status: "superseded" },
      ]);
      assert.lengthOf(
        yield* sql`SELECT * FROM orchestration_v2_effect_outbox WHERE effect_id LIKE 'board-reselect-explicit:%'`,
        1,
      );
    }).pipe(Effect.provide(Layer.merge(serviceLayer, projections(archived))));
  },
);

it.effect("records provider start only once and never reselects a started reply", () => {
  const archived = new Set<string>();
  return Effect.gen(function* () {
    yield* seed;
    yield* subscribe(first, second);
    yield* intent;
    const service = yield* Responder.make;
    yield* service.activate(rootId);
    yield* prepareAutomaticBatch;
    const store = yield* SelectionStore.make;
    const starts = yield* Effect.forEach(
      [1, 2],
      () => store.markStarted({ batchId: "batch", threadId: first }),
      { concurrency: 2 },
    );
    assert.equal(starts.filter(Boolean).length, 1);
    archived.add(first);
    assert.isTrue(yield* service.reselectBeforeStart({ batchId: "batch", threadId: first }));
    const [selection] = yield* store.list(rootId);
    assert.equal(selection!.generation, 0);
    assert.equal(selection!.recipientThreadId, first);
    assert.isNotNull(selection!.startedAt);
  }).pipe(Effect.provide(Layer.merge(serviceLayer, projections(archived))));
});

it.effect(
  "distinguishes unavailable targets and ancestor Stop while allowing busy and finished participants",
  () =>
    Effect.gen(function* () {
      for (const name of [
        "missing",
        "archived",
        "deleted",
        "stopped",
        "parent-stopped",
        "busy",
        "finished",
      ] as const) {
        const reason = yield* Responder.classifyAvailability(ThreadId.make(name));
        assert.equal(reason, name === "busy" || name === "finished" ? null : name);
      }
    }).pipe(
      Effect.provide(
        Layer.merge(
          layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: (id) =>
              Effect.succeed(
                id === "missing"
                  ? null
                  : ({
                      id,
                      archivedAt: id === "archived" ? now : null,
                      deletedAt: id === "deleted" ? now : null,
                    } as never),
              ),
            getThreadRecords: (id) =>
              Effect.succeed({
                thread: {
                  archivedAt: null,
                  deletedAt: null,
                  lineage:
                    id === "parent-stopped"
                      ? {
                          relationshipToParent: "subagent",
                          parentThreadId: ThreadId.make("parent"),
                        }
                      : { relationshipToParent: "root" },
                },
                runs: [
                  { id: "latest", ordinal: 1, status: id === "busy" ? "running" : "completed" },
                ],
                turnItems: id === "stopped" || id === "parent" ? [{ runId: "latest" }] : [],
              } as never),
          }),
        ),
      ),
    ),
);
