import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BOARD_POST_TEXT_MAX_CHARS,
  BoardPostId,
  MessageBoardError,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  type BoardAuthor,
  type BoardViewer,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as MessageBoardService from "./MessageBoardService.ts";
import * as OpenAIDecisionsClient from "./OpenAIDecisionsClient.ts";
import * as MessageBoardTodoStore from "./MessageBoardTodoStore.ts";
import { boardPersona } from "@t3tools/shared/boardPersona";

const user = { kind: "user" } as const;
const isMessageBoardError = Schema.is(MessageBoardError);
const threadViewer: BoardViewer = { kind: "thread", threadId: ThreadId.make("thread:board") };
const agent: BoardAuthor = {
  kind: "agent",
  threadId: ThreadId.make("thread:board"),
  projectId: ProjectId.make("project:board"),
  title: "Board agent",
  driver: ProviderDriverKind.make("codex"),
};

it("resolves a selected identity without fanning out to agents sharing its persona name", () => {
  const names = new Map<string, string>();
  let collision: [string, string] | undefined;
  for (let index = 0; index < 100; index += 1) {
    const id = `collision-${index}`;
    const name = boardPersona(id).name;
    const previous = names.get(name);
    if (previous) {
      collision = [previous, id];
      break;
    }
    names.set(name, id);
  }
  assert.isDefined(collision);
  const [first, second] = collision!;
  const name = boardPersona(first).name;
  const candidates = [ThreadId.make(first), ThreadId.make(second)];
  assert.deepEqual(MessageBoardService.resolveMentions(`@${name}[${first}]`, candidates), [
    ThreadId.make(first),
  ]);
  assert.deepEqual(MessageBoardService.resolveMentions(`@${name}`, candidates), []);
});

it.effect("replays retry keys and rejects changed payloads without another post", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const input = {
      author: user,
      destination: { kind: "channel" as const, channelName: "retries" },
      text: "One finding",
      requestKey: "finding-1",
    };
    const [first, second] = yield* Effect.all([board.post(input), board.post(input)], {
      concurrency: "unbounded",
    });
    assert.equal(second.id, first.id);
    const conflict = yield* board.post({ ...input, text: "Changed" }).pipe(Effect.result);
    assert.equal(conflict._tag, "Failure");
    const posts = yield* board.searchPosts({ viewer: user, channelName: "retries" });
    assert.lengthOf(posts, 1);
    const wrongOperation = yield* board.postAndNotify(input).pipe(Effect.result);
    assert.equal(wrongOperation._tag, "Failure");
    const independent = yield* board.post({ ...input, author: agent });
    assert.notEqual(independent.id, first.id);
  }).pipe(Effect.provide(layerTest)),
);
const layerTest = MessageBoardService.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThreadShell: () => Effect.succeed(null) }),
  ),
  Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
  Layer.provide(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(null),
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const layerTodoOwners = MessageBoardService.layer.pipe(
  Layer.provideMerge(EffectOutbox.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: () =>
        Effect.succeed({
          thread: {
            archivedAt: null,
            deletedAt: null,
            lineage: { relationshipToParent: "root", parentThreadId: null },
          },
          runs: [],
          turnItems: [],
        } as never),
      getThreadShell: (id) =>
        Effect.succeed({
          id,
          deletedAt: null,
          projectId: ProjectId.make("project:board"),
          title: id,
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
        } as never),
    }),
  ),
  Layer.provide(
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  ),
  Layer.provide(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(null),
    }),
  ),
  Layer.provide(NodeServices.layer),
);

it.effect("keeps a selected existing agent's identity before it joins the channel", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const selected = ThreadId.make("selected-outsider");
    const post = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "mentions" },
      text: `@${boardPersona(selected).name}[${selected}] please review`,
    });
    assert.deepEqual(post.mentions, [selected]);
  }).pipe(Effect.provide(layerTodoOwners)),
);

it.effect(
  "selects one conversational responder atomically without assigning discussion management",
  () => {
    let calls = 0;
    return Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const sql = yield* SqlClient.SqlClient;
      const root = yield* board.post({
        author: agent,
        destination: { kind: "channel", channelName: "automatic-replies" },
        text: "Discuss the parser here.",
      });
      const reviewer = { ...agent, threadId: ThreadId.make("reviewer") };
      yield* board.post({
        author: reviewer,
        destination: { kind: "reply", rootId: root.id },
        text: "I reviewed retry behavior.",
      });
      yield* sql`UPDATE board_discussions SET lead_thread_id=NULL WHERE root_id=${root.id}`;
      const input = {
        author: user,
        destination: { kind: "reply" as const, rootId: root.id },
        text: "Thanks! What happens next?",
        requestKey: "conversational",
      };
      const sent = yield* board.postAndNotify(input);
      yield* board.postAndNotify(input);
      const state = yield* board.readHandling({ rootId: root.id, viewer: user });
      assert.isNull(state.leadThreadId);
      assert.equal(calls, 1);
      assert.lengthOf(state.selections ?? [], 1);
      assert.lengthOf(state.responsibilities, 1);
      assert.equal(state.responsibilities[0]!.recipientThreadId, reviewer.threadId);
      assert.equal(state.responsibilities[0]!.postId, sent.post.id);
      assert.deepEqual(state.selections![0]!.sourcePostIds, [sent.post.id]);
      assert.lengthOf(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, 1);
      const management = yield* board
        .updateContext({
          rootId: root.id,
          expectedRevision: state.revision,
          viewer: { kind: "thread", threadId: reviewer.threadId },
          context: { text: "Cannot acquire management by responding.", decisionPostIds: [] },
        })
        .pipe(Effect.result);
      assert.ok(Result.isFailure(management));
    }).pipe(
      Effect.provide(layerTodoOwners),
      Effect.provideService(OpenAIDecisionsClient.OpenAIDecisionsClient, {
        choose: () =>
          Effect.sync(() => {
            calls++;
            return { kind: "selected" as const, label: "candidate-1", probability: 0.99 };
          }),
      }),
    );
  },
);

it.effect("replays committed todo actions before version checks and rejects stale claims", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "versioned-todos" },
      text: "Scope",
    });
    const create = {
      rootId: root.id,
      requestKey: "create-one",
      viewer: threadViewer,
      action: { type: "create" as const, text: "Review serializer" },
    };
    const created = yield* board.applyTodoAction(create);
    const replayed = yield* board.applyTodoAction(create);
    assert.equal(replayed.todoId, created.todoId);
    assert.isTrue(replayed.replay);
    assert.equal(replayed.todosRevision, created.todosRevision);
    const claims = yield* Effect.forEach(
      ["worker-a", "worker-b"],
      (threadId) =>
        board
          .applyTodoAction({
            rootId: root.id,
            requestKey: "claim",
            viewer: { kind: "thread", threadId: ThreadId.make(threadId) },
            action: { type: "start", todoId: created.todoId, expectedVersion: created.version },
          })
          .pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    assert.lengthOf(claims.filter(Result.isSuccess), 1);
    assert.lengthOf(claims.filter(Result.isFailure), 1);
    const winner = claims.find(Result.isSuccess)!;
    assert.isTrue(winner.success.item?.assigneeThreadId !== null);
    const retried = yield* board.applyTodoAction({
      rootId: root.id,
      requestKey: "claim",
      viewer: { kind: "thread", threadId: winner.success.item!.assigneeThreadId! },
      action: { type: "start", todoId: created.todoId, expectedVersion: created.version },
    });
    assert.deepEqual(retried, { ...winner.success, replay: true });
  }).pipe(Effect.provide(layerTodoOwners)),
);

it.effect(
  "suppresses noop and replay events, rejects stale same-value edits, and replays after service reconstruction",
  () =>
    Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const sql = yield* SqlClient.SqlClient;
      const root = yield* board.post({
        author: user,
        destination: { kind: "channel", channelName: "quiet-todos" },
        text: "Scope",
      });
      const pull = yield* Stream.toPull(board.events.pipe(Stream.rechunk(1)));
      const firstEvent = yield* pull.pipe(Effect.forkChild({ startImmediately: true }));
      const create = {
        rootId: root.id,
        viewer: threadViewer,
        requestKey: "create",
        action: { type: "create" as const, text: "Original" },
      };
      const created = yield* board.applyTodoAction(create);
      assert.equal((yield* Fiber.join(firstEvent))[0]?.type, "todos-changed");
      yield* board.applyTodoAction({
        ...create,
        requestKey: "noop",
        action: {
          type: "edit",
          todoId: created.todoId,
          expectedVersion: created.version,
          text: "Original",
        },
      });
      const edit = {
        ...create,
        requestKey: "edit",
        action: {
          type: "edit" as const,
          todoId: created.todoId,
          expectedVersion: created.version,
          text: "Current",
        },
      };
      const edited = yield* board.applyTodoAction(edit);
      const event = (yield* pull)[0];
      assert.equal(event?.type, "todos-changed");
      if (event?.type === "todos-changed") assert.equal(event.todosRevision, 2);
      const stale = yield* board
        .applyTodoAction({ ...edit, requestKey: "stale-same-value" })
        .pipe(Effect.flip);
      assert.deepInclude(stale, { code: "conflict" });
      yield* board.applyTodoAction(edit);
      yield* board.applyTodoAction({
        ...create,
        requestKey: "remove",
        action: {
          type: "remove",
          todoId: created.todoId,
          expectedVersion: edited.version,
          reason: "Temporary",
        },
      });
      const removal = (yield* pull)[0];
      if (removal?.type === "todos-changed") {
        assert.equal(removal.todosRevision, 3);
        assert.deepEqual(removal.todos, []);
      } else assert.fail("Expected removal snapshot");
      const restarted = yield* MessageBoardTodoStore.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(SqlClient.SqlClient, sql),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
            NodeServices.layer,
          ),
        ),
      );
      assert.deepEqual((yield* restarted.apply(create)).result, { ...created, replay: true });
    }).pipe(Effect.scoped, Effect.provide(layerTodoOwners)),
);

it.effect("rejects ambiguous todo completion payloads before committing an action", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "completion-input" },
      text: "Scope",
    });
    const created = yield* board.applyTodoAction({
      rootId: root.id,
      viewer: threadViewer,
      requestKey: "create",
      action: { type: "create", text: "Task" },
    });
    const started = yield* board.applyTodoAction({
      rootId: root.id,
      viewer: threadViewer,
      requestKey: "start",
      action: { type: "start", todoId: created.todoId, expectedVersion: created.version },
    });
    const result = yield* board
      .applyTodoAction({
        rootId: root.id,
        viewer: threadViewer,
        requestKey: "ambiguous",
        action: {
          type: "complete",
          todoId: started.todoId,
          expectedVersion: started.version,
          completion: { text: "Result", sourcePostId: root.id },
        },
      } as never)
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(
      (yield* board.getTodo({ rootId: root.id, todoId: created.todoId, viewer: threadViewer })).item
        ?.status,
      "in-progress",
    );
  }).pipe(Effect.provide(layerTodoOwners)),
);

it.effect("enforces todo transitions, ownership, reservation and explicit overrides", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const sql = yield* SqlClient.SqlClient;
    const root = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "transitions" },
      text: "Scope",
      mode: "note",
    });
    const first = { kind: "thread" as const, threadId: ThreadId.make("worker-a") };
    const second = { kind: "thread" as const, threadId: ThreadId.make("worker-b") };
    let sequence = 0;
    const apply = (
      action: typeof import("@t3tools/contracts").BoardTodoAction.Type,
      viewer: BoardViewer = first,
    ) =>
      board.applyTodoAction({
        rootId: root.id,
        requestKey: `action-${sequence++}`,
        action,
        viewer,
      });
    let item = (yield* apply({
      type: "create",
      text: "Future work",
      status: "blocked",
      reason: "Waiting for API",
      assigneeThreadId: first.threadId,
    })).item!;
    assert.equal(item.status, "blocked");
    assert.equal(item.blockerReason, "Waiting for API");
    assert.deepInclude(
      yield* apply({ type: "start", todoId: item.id, expectedVersion: item.version }).pipe(
        Effect.flip,
      ),
      { code: "conflict" },
    );
    item = (yield* apply({ type: "release", todoId: item.id, expectedVersion: item.version }))
      .item!;
    assert.isNull(item.assigneeThreadId);
    assert.equal(item.status, "blocked");
    assert.equal(item.blockerReason, "Waiting for API");
    item = (yield* apply({ type: "unblock", todoId: item.id, expectedVersion: item.version }))
      .item!;
    assert.equal(item.status, "todo");
    assert.isUndefined(item.blockerReason);
    item = (yield* apply({
      type: "reassign",
      todoId: item.id,
      expectedVersion: item.version,
      assigneeThreadId: second.threadId,
      reason: "Tests ownership",
    })).item!;
    assert.equal(item.status, "todo");
    assert.equal(item.assigneeThreadId, second.threadId);
    for (const action of [
      { type: "start" as const },
      { type: "edit" as const, text: "Steal" },
      { type: "block" as const, reason: "Steal" },
    ])
      assert.deepInclude(
        yield* apply({ ...action, todoId: item.id, expectedVersion: item.version }).pipe(
          Effect.flip,
        ),
        { code: "conflict" },
      );
    item = (yield* apply({
      type: "edit",
      todoId: item.id,
      expectedVersion: item.version,
      text: "Corrected scope",
      override: true,
      reason: "Coordinator correction",
    })).item!;
    assert.isUndefined(item.reason);
    assert.equal(item.assigneeThreadId, second.threadId);
    item = (yield* apply({ type: "start", todoId: item.id, expectedVersion: item.version }, second))
      .item!;
    assert.deepInclude(
      yield* apply({ type: "complete", todoId: item.id, expectedVersion: item.version }).pipe(
        Effect.flip,
      ),
      { code: "conflict" },
    );
    item = (yield* apply(
      {
        type: "complete",
        todoId: item.id,
        expectedVersion: item.version,
        completion: { sourcePostId: root.id },
      },
      second,
    )).item!;
    assert.equal(item.status, "done");
    assert.deepEqual(item.completion, { sourcePostId: root.id });
    item = (yield* apply({
      type: "reopen",
      todoId: item.id,
      expectedVersion: item.version,
      status: "blocked",
      reason: "New dependency",
    })).item!;
    assert.equal(item.status, "blocked");
    assert.isNull(item.assigneeThreadId);
    assert.isUndefined(item.completion);
    item = (yield* apply({
      type: "cancel",
      todoId: item.id,
      expectedVersion: item.version,
      reason: "Withdrawn scope",
    })).item!;
    assert.equal(item.status, "cancelled");
    assert.equal(item.reason, "Withdrawn scope");
    assert.isTrue(
      item.history.some(
        (entry) => entry.action === "edit" && entry.reason === "Coordinator correction",
      ),
    );
    assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM board_posts`, [{ count: 1 }]);
    for (const table of [
      "board_responsibilities",
      "board_post_read_markers",
      "orchestration_v2_effect_outbox",
    ]) {
      if (table === "board_post_read_markers") continue;
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM ${sql.literal(table)}`, [
        { count: 0 },
      ]);
    }
  }).pipe(Effect.provide(layerTodoOwners)),
);

it.effect(
  "rejects stale completion after edits, ABA, reassignment and removal without invalidating unrelated items",
  () =>
    Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const root = yield* board.post({
        author: user,
        destination: { kind: "channel", channelName: "versions" },
        text: "Scope",
      });
      let sequence = 0;
      const apply = (action: typeof import("@t3tools/contracts").BoardTodoAction.Type) =>
        board.applyTodoAction({
          rootId: root.id,
          requestKey: `version-${sequence++}`,
          viewer: threadViewer,
          action,
        });
      let item = (yield* apply({ type: "create", text: "Task" })).item!;
      item = (yield* apply({ type: "start", todoId: item.id, expectedVersion: item.version }))
        .item!;
      const staleVersion = item.version;
      yield* apply({ type: "create", text: "Unrelated task" });
      item = (yield* apply({
        type: "edit",
        todoId: item.id,
        expectedVersion: item.version,
        text: "New scope",
      })).item!;
      assert.deepInclude(
        yield* apply({ type: "complete", todoId: item.id, expectedVersion: staleVersion }).pipe(
          Effect.flip,
        ),
        { code: "conflict" },
      );
      const beforeAba = item.version;
      item = (yield* apply({ type: "release", todoId: item.id, expectedVersion: item.version }))
        .item!;
      item = (yield* apply({ type: "start", todoId: item.id, expectedVersion: item.version }))
        .item!;
      assert.deepInclude(
        yield* apply({ type: "complete", todoId: item.id, expectedVersion: beforeAba }).pipe(
          Effect.flip,
        ),
        { code: "conflict" },
      );
      const beforeReassign = item.version;
      item = (yield* apply({
        type: "reassign",
        todoId: item.id,
        expectedVersion: item.version,
        assigneeThreadId: null,
        reason: "Handoff",
      })).item!;
      assert.deepInclude(
        yield* apply({ type: "complete", todoId: item.id, expectedVersion: beforeReassign }).pipe(
          Effect.flip,
        ),
        { code: "conflict" },
      );
      const removed = yield* apply({
        type: "remove",
        todoId: item.id,
        expectedVersion: item.version,
        reason: "Temporary item",
      });
      assert.isTrue(removed.removed);
      assert.isNull(removed.item);
      const missing = yield* apply({
        type: "complete",
        todoId: item.id,
        expectedVersion: item.version,
      }).pipe(Effect.flip);
      assert.isTrue(isMessageBoardError(missing));
      if (isMessageBoardError(missing)) assert.equal(missing.todoConflict?.kind, "missing");
    }).pipe(Effect.provide(layerTodoOwners)),
);

it.effect(
  "preserves historical retry results after removal and records true noops without revision growth",
  () =>
    Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const sql = yield* SqlClient.SqlClient;
      const root = yield* board.post({
        author: user,
        destination: { kind: "channel", channelName: "receipts" },
        text: "Scope",
      });
      const create = {
        rootId: root.id,
        viewer: threadViewer,
        requestKey: "retry-create",
        action: { type: "create" as const, text: "Stable task" },
      };
      const created = yield* board.applyTodoAction(create);
      const item = created.item!;
      const noop = yield* board.applyTodoAction({
        rootId: root.id,
        viewer: threadViewer,
        requestKey: "noop",
        action: { type: "edit", todoId: item.id, expectedVersion: item.version, text: item.text },
      });
      assert.equal(noop.version, item.version);
      assert.equal(noop.todosRevision, created.todosRevision);
      const started = yield* board.applyTodoAction({
        ...create,
        requestKey: "start",
        action: { type: "start", todoId: item.id, expectedVersion: item.version },
      });
      const complete = {
        ...create,
        requestKey: "complete",
        action: {
          type: "complete" as const,
          todoId: item.id,
          expectedVersion: started.version,
          completion: { text: "Finished" },
        },
      };
      const completed = yield* board.applyTodoAction(complete);
      const removal = {
        rootId: root.id,
        viewer: threadViewer,
        requestKey: "remove",
        action: {
          type: "remove" as const,
          todoId: item.id,
          expectedVersion: completed.version,
          reason: "Temporary",
        },
      };
      const removed = yield* board.applyTodoAction(removal);
      assert.deepEqual(yield* board.applyTodoAction(removal), { ...removed, replay: true });
      assert.deepEqual(yield* board.applyTodoAction(create), { ...created, replay: true });
      assert.deepEqual(yield* board.applyTodoAction(complete), { ...completed, replay: true });
      assert.deepInclude(
        yield* board
          .applyTodoAction({ ...create, action: { type: "create", text: "Changed" } })
          .pipe(Effect.flip),
        { code: "conflict" },
      );
      assert.deepInclude(
        yield* board
          .applyTodoAction({
            ...create,
            action: { type: "remove", todoId: item.id, expectedVersion: 1, reason: "Collision" },
          })
          .pipe(Effect.flip),
        { code: "conflict" },
      );
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM board_todos`, [{ count: 0 }]);
      assert.deepEqual(
        yield* sql`SELECT revision FROM board_todo_revisions WHERE root_id=${root.id}`,
        [{ revision: 4 }],
      );
      const stale = yield* board
        .applyTodoAction({
          rootId: root.id,
          viewer: threadViewer,
          requestKey: "stale",
          action: { type: "edit", todoId: item.id, expectedVersion: 0, text: item.text },
        })
        .pipe(Effect.flip);
      assert.deepInclude(stale, { code: "conflict" });
      const legacy = yield* board
        .createTodo({ rootId: root.id, text: "Unsafe cached tool" })
        .pipe(Effect.flip);
      assert.deepInclude(legacy, { code: "compatibility" });
    }).pipe(Effect.provide(layerTodoOwners)),
);

it.effect(
  "lists compact task pages with root, filter and revision bound cursors without marking posts read",
  () =>
    Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const sql = yield* SqlClient.SqlClient;
      const root = yield* board.post({
        author: user,
        destination: { kind: "channel", channelName: "task-pages" },
        text: "Scope",
      });
      const other = yield* board.post({
        author: user,
        destination: { kind: "channel", channelName: "task-pages" },
        text: "Other",
      });
      for (let index = 0; index < 4; index++)
        yield* board.applyTodoAction({
          rootId: root.id,
          viewer: threadViewer,
          requestKey: `page-create-${index}`,
          action:
            index === 0
              ? { type: "create", text: `Task ${index}`, status: "blocked", reason: "Wait" }
              : { type: "create", text: `Task ${index}` },
        });
      const page = yield* board.listTodos({
        rootId: root.id,
        filter: "available",
        limit: 1,
        viewer: threadViewer,
      });
      assert.lengthOf(page.items, 1);
      assert.isNotNull(page.nextCursor);
      assert.notProperty(page.items[0], "assignee");
      assert.equal(
        (yield* board.getTodo({ rootId: root.id, todoId: page.items[0]!.id, viewer: threadViewer }))
          .item?.id,
        page.items[0]!.id,
      );
      assert.deepInclude(
        yield* board
          .listTodos({
            rootId: other.id,
            filter: "available",
            cursor: page.nextCursor!,
            viewer: threadViewer,
          })
          .pipe(Effect.flip),
        { code: "invalid_input" },
      );
      assert.deepInclude(
        yield* board
          .listTodos({
            rootId: root.id,
            filter: "open",
            cursor: page.nextCursor!,
            viewer: threadViewer,
          })
          .pipe(Effect.flip),
        { code: "invalid_input" },
      );
      yield* board.applyTodoAction({
        rootId: root.id,
        viewer: threadViewer,
        requestKey: "new-during-page",
        action: { type: "create", text: "New work" },
      });
      const changed = yield* board
        .listTodos({
          rootId: root.id,
          filter: "available",
          cursor: page.nextCursor!,
          viewer: threadViewer,
        })
        .pipe(Effect.flip);
      if (isMessageBoardError(changed)) assert.equal(changed.todoConflict?.kind, "list_changed");
      else assert.fail("Expected structured list conflict");
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM board_thread_read_markers`, [
        { count: 0 },
      ]);
    }).pipe(Effect.provide(layerTodoOwners)),
);

const traceSqlStatements = () => {
  const statements: Array<string> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") statements.push(query);
      };
      return span;
    },
  });
  return { statements, tracer };
};

it.effect("loads a discussion once and rejects missing or reply ids", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "general" },
      text: "Root",
    });
    const reply = yield* board.post({
      author: user,
      destination: { kind: "reply", rootId: root.id },
      text: "Reply",
    });
    const { statements, tracer } = traceSqlStatements();
    const detail = yield* board
      .readThread({ viewer: user, rootId: root.id })
      .pipe(Effect.withTracer(tracer));
    assert.deepEqual(detail.posts, [root, reply]);
    assert.isAtMost(statements.length, 9);
    for (const rootId of [BoardPostId.make("missing"), reply.id]) {
      const error = yield* board.readThread({ viewer: user, rootId }).pipe(Effect.flip);
      assert.deepInclude(error, { code: "not_found" });
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("pages discussion replies by a stable snapshot while keeping complete metadata", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const sql = yield* SqlClient.SqlClient;
    const root = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "paged" },
      text: "Root",
    });
    const replies = yield* Effect.forEach([0, 1, 2, 3, 4], (index) =>
      board.post({
        author: index % 2 === 0 ? agent : user,
        destination: { kind: "reply", rootId: root.id },
        text: `Reply ${index}`,
      }),
    );
    const tiedAt = replies[0]!.createdAt;
    yield* sql`UPDATE board_posts SET created_at = ${tiedAt} WHERE root_id = ${root.id} AND id != ${root.id}`;
    const ordered = [...replies].sort((left, right) => left.id.localeCompare(right.id));
    yield* board.react({ viewer: user, postId: ordered[1]!.id, emoji: "👍", active: true });
    const latest = yield* board.readThread({ viewer: user, rootId: root.id, limit: 2 });
    assert.deepEqual(
      latest.posts.map((post) => post.id),
      [root.id, ...ordered.slice(-2).map((post) => post.id)],
    );
    assert.isString(latest.olderPostsCursor);
    assert.equal(latest.summary.replyCount, 5);
    assert.equal(latest.summary.latestReply?.id, ordered[4]!.id);
    assert.deepEqual(latest.summary.participants, [user, agent]);
    assert.deepEqual(
      latest.members.map((member) => [
        member.author.kind === "agent" ? member.author.threadId : null,
        member.postCount,
      ]),
      [[agent.threadId, 3]],
    );

    const concurrent = yield* board.post({
      author: user,
      destination: { kind: "reply", rootId: root.id },
      text: "Arrived after snapshot",
    });
    const middle = yield* board.readThread({
      viewer: user,
      rootId: root.id,
      limit: 2,
      cursor: latest.olderPostsCursor!,
    });
    assert.deepEqual(
      middle.posts.map((post) => post.id),
      [root.id, ...ordered.slice(1, 3).map((post) => post.id)],
    );
    assert.deepEqual(middle.posts[1]!.reactions, [{ emoji: "👍", by: [user] }]);
    assert.equal(middle.summary.replyCount, 6);
    assert.equal(middle.summary.latestReply?.id, concurrent.id);
    assert.deepEqual(middle.members, latest.members);
    const oldest = yield* board.readThread({
      viewer: user,
      rootId: root.id,
      limit: 2,
      cursor: middle.olderPostsCursor!,
    });
    assert.deepEqual(
      oldest.posts.map((post) => post.id),
      [root.id, ordered[0]!.id],
    );
    assert.isNull(oldest.olderPostsCursor);
    assert.equal((yield* board.readThread({ viewer: user, rootId: root.id })).posts.length, 7);

    for (const input of [
      { rootId: root.id, limit: 0 },
      { rootId: root.id, limit: 101 },
      { rootId: root.id, limit: 2, cursor: "{}" },
      { rootId: root.id, limit: 2, cursor: "x".repeat(2049) },
      { rootId: ordered[0]!.id, limit: 2, cursor: latest.olderPostsCursor! },
    ]) {
      assert.deepInclude(yield* board.readThread({ viewer: user, ...input }).pipe(Effect.flip), {
        code: "invalid_input",
      });
    }
    const rootOnly = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "paged" },
      text: "No replies",
    });
    const empty = yield* board.readThread({ viewer: user, rootId: rootOnly.id, limit: 2 });
    assert.deepEqual(empty.posts, [rootOnly]);
    assert.isNull(empty.olderPostsCursor);
    assert.isNull(empty.summary.latestReply);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("auto-creates channels and persists roots and replies with distinct authors", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "general" },
      text: "Root",
    });
    const reply = yield* board.post({
      author: agent,
      destination: { kind: "reply", rootId: root.id },
      text: "Reply",
    });
    assert.equal(root.rootId, root.id);
    assert.equal(reply.rootId, root.id);
    assert.equal(reply.channelName, "general");
    assert.deepEqual(yield* board.readPost({ postId: reply.id }), reply);
    const detail = yield* board.readThread({ viewer: user, rootId: root.id });
    assert.deepEqual(detail.posts, [root, reply]);
    assert.equal(detail.summary.replyCount, 1);
    assert.deepEqual(detail.summary.latestReply, reply);
    assert.deepEqual(detail.summary.participants, [user, agent]);
    assert.deepEqual(detail.members, [
      { author: agent, subscribed: false, postCount: 1, lastPostedAt: reply.createdAt },
    ]);
    const [channel] = yield* board.listChannels({ viewer: user });
    assert.equal(channel?.postCount, 2);
    assert.equal(channel?.threadCount, 1);
    assert.equal(channel?.unreadCount, 2);
    assert.deepEqual(channel?.createdBy, user);
    assert.deepEqual(
      (yield* board.listChannels({ viewer: user, query: "GEN" })).map((value) => value.name),
      ["general"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("limits recent previews to matching channels and skips unmatched post queries", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    yield* board.createChannel({ author: user, name: "general", description: "Main discussion" });
    yield* board.createChannel({ author: user, name: "empty" });
    const posts = yield* Effect.forEach(
      Array.from({ length: 14 }, (_, index) => index),
      (index) =>
        board.post({
          author: index < 2 ? user : agent,
          destination: { kind: "channel", channelName: "general" },
          text: `Post ${index}`,
        }),
    );
    yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "other" },
      text: "Other channel",
    });
    const channels = yield* board.listChannels({ viewer: user, query: "MAIN" });
    assert.equal(channels.length, 1);
    assert.deepInclude(channels[0], {
      name: "general",
      postCount: 14,
      unreadCount: 14,
      latestPost: posts.at(-1)!,
      recentAuthors: [agent],
    });
    const empty = yield* board.listChannels({ viewer: user, query: "empty" });
    assert.isNull(empty[0]?.latestPost);
    assert.deepEqual(empty[0]?.recentAuthors, []);
    const { statements, tracer } = traceSqlStatements();
    assert.deepEqual(
      yield* board.listChannels({ viewer: user, query: "missing" }).pipe(Effect.withTracer(tracer)),
      [],
    );
    assert.isAtMost(statements.length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("unions posting agents and resolvable thread subscribers by latest post", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const silent = { ...agent, threadId: ThreadId.make("silent") };
    const other = { ...agent, threadId: ThreadId.make("other") };
    const root = yield* board.post({
      author: agent,
      destination: { kind: "channel", channelName: "general" },
      text: "Root",
    });
    const target = { kind: "thread", rootId: root.id } as const;
    for (const threadId of [
      agent.threadId,
      other.threadId,
      silent.threadId,
      ThreadId.make("missing"),
      ThreadId.make("deleted"),
    ]) {
      yield* board.subscribe({ viewer: { kind: "thread", threadId }, target });
    }
    yield* board.subscribe({ viewer: user, target });
    yield* board.subscribe({
      viewer: { kind: "thread", threadId: ThreadId.make("channel-only") },
      target: { kind: "channel", channelName: "general" },
    });
    yield* board.post({
      author: other,
      destination: { kind: "reply", rootId: root.id },
      text: "Other",
    });
    const updated = { ...agent, title: "Updated attribution" };
    const latest = yield* board.post({
      author: updated,
      destination: { kind: "reply", rootId: root.id },
      text: "Latest agent post",
    });
    yield* board.post({
      author: user,
      destination: { kind: "reply", rootId: root.id },
      text: "User reply",
    });
    yield* board.unsubscribe({ viewer: threadViewer, target });
    const detail = yield* board.readThread({
      viewer: { kind: "thread", threadId: ThreadId.make("reader") },
      rootId: root.id,
    });
    assert.deepEqual(detail.members, [
      { author: updated, subscribed: false, postCount: 2, lastPostedAt: latest.createdAt },
      { author: other, subscribed: true, postCount: 1, lastPostedAt: detail.posts[1]!.createdAt },
      {
        author: { ...silent, model: "gpt-5.5" },
        subscribed: true,
        postCount: 0,
        lastPostedAt: null,
      },
    ]);
    assert.isFalse(
      (yield* board.listSubscribers(target)).some(
        (viewer) => viewer.kind === "thread" && viewer.threadId === "reader",
      ),
    );
  }).pipe(
    Effect.provide(
      MessageBoardService.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: (threadId) =>
              Effect.succeed(
                threadId === "silent" || threadId === "deleted"
                  ? ({
                      id: threadId,
                      title: agent.title,
                      projectId: agent.projectId,
                      providerInstanceId: ProviderInstanceId.make("codex"),
                      modelSelection: {
                        instanceId: ProviderInstanceId.make("codex"),
                        model: "gpt-5.5",
                      },
                      deletedAt: threadId === "deleted" ? "2026-10-28T00:00:00.000Z" : null,
                    } as Effect.Success<
                      ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getThreadShell"]>
                    >)
                  : null,
              ),
          }),
        ),
        Layer.provide(
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              { instanceId: ProviderInstanceId.make("codex"), driver: "codex", models: [] },
            ] as unknown as Effect.Success<
              ProviderRegistry.ProviderRegistry["Service"]["getProviders"]
            >),
          }),
        ),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(null),
          }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("keeps read markers per viewer and counts posts after a same-tick mark", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = yield* board.post({
      author: agent,
      destination: { kind: "channel", channelName: "general" },
      text: "Root",
    });
    yield* board.readThread({ viewer: user, rootId: root.id });
    yield* board.searchPosts({ viewer: user, query: "Root" });
    assert.equal((yield* board.listChannels({ viewer: user }))[0]?.unreadCount, 1);
    yield* board.markRead({ viewer: user, channelName: "general" });
    assert.equal((yield* board.listChannels({ viewer: user }))[0]?.unreadCount, 0);
    assert.equal(
      (yield* board.readThread({ viewer: user, rootId: root.id })).summary.unread,
      false,
    );
    assert.equal((yield* board.listChannels({ viewer: threadViewer }))[0]?.unreadCount, 1);
    yield* board.post({
      author: agent,
      destination: { kind: "reply", rootId: root.id },
      text: "Unread reply",
    });
    assert.equal((yield* board.listChannels({ viewer: user }))[0]?.unreadCount, 1);
    assert.equal((yield* board.listChannels({ viewer: threadViewer }))[0]?.unreadCount, 2);
    assert.equal((yield* board.readThread({ viewer: user, rootId: root.id })).summary.unread, true);
    yield* board.markRead({ viewer: threadViewer, channelName: "general" });
    assert.equal((yield* board.listChannels({ viewer: threadViewer }))[0]?.unreadCount, 0);
    assert.equal((yield* board.listChannels({ viewer: user }))[0]?.unreadCount, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("waits for others' unread posts, ignoring the viewer's own, until a timeout", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "general" },
      text: "Root",
    });
    const wait = (timeoutMs: number) =>
      board.waitForPosts({ viewer: threadViewer, rootId: root.id, timeoutMs });
    assert.deepEqual(
      (yield* wait(1_000)).map((post) => post.id),
      [root.id],
    );

    yield* board.markRead({ viewer: threadViewer, channelName: "general" });
    const waiting = yield* wait(60_000).pipe(Effect.forkChild({ startImmediately: true }));
    yield* board.post({
      author: agent,
      destination: { kind: "reply", rootId: root.id },
      text: "My own reply",
    });
    const answer = yield* board.post({
      author: user,
      destination: { kind: "reply", rootId: root.id },
      text: "Answer",
    });
    assert.deepEqual(
      (yield* Fiber.join(waiting)).map((post) => post.id),
      [answer.id],
    );

    yield* board.markRead({ viewer: threadViewer, channelName: "general" });
    const idle = yield* wait(1_000).pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("1 second");
    assert.deepEqual(yield* Fiber.join(idle), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("upserts a channel description while keeping its posts and creator", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const created = yield* board.upsertChannel({
      author: agent,
      name: "plans",
      description: "First draft",
    });
    yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "plans" },
      text: "Kickoff",
    });
    const updated = yield* board.upsertChannel({
      author: user,
      name: "plans",
      description: "Agreed plans only",
    });
    assert.equal(created.description, "First draft");
    assert.deepInclude(updated, {
      description: "Agreed plans only",
      createdBy: agent,
      postCount: 1,
    });
    const failure = yield* board
      .upsertChannel({ author: agent, name: "plans", description: "x".repeat(513) })
      .pipe(Effect.flip);
    assert.deepInclude(failure, { code: "invalid_input" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reading one discussion leaves the channel's other discussions unread", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const read = yield* board.post({
      author: agent,
      destination: { kind: "channel", channelName: "general" },
      text: "Read me",
    });
    yield* board.post({
      author: agent,
      destination: { kind: "reply", rootId: read.id },
      text: "Reply",
    });
    const other = yield* board.post({
      author: agent,
      destination: { kind: "channel", channelName: "general" },
      text: "Still unread",
    });
    yield* board.markRead({ viewer: user, rootId: read.id });
    assert.equal((yield* board.listChannels({ viewer: user }))[0]?.unreadCount, 1);
    const page = yield* board.listThreads({
      viewer: user,
      channelName: "general",
      sort: "created",
    });
    assert.deepEqual(
      page.threads.map((thread) => [thread.root.id, thread.unread]),
      [
        [other.id, true],
        [read.id, false],
      ],
    );
    assert.equal(
      (yield* board.listChannels({ viewer: threadViewer }))[0]?.unreadCount,
      3,
      "other viewers keep their own markers",
    );
    yield* board.post({
      author: agent,
      destination: { kind: "reply", rootId: read.id },
      text: "New reply",
    });
    assert.equal((yield* board.readThread({ viewer: user, rootId: read.id })).summary.unread, true);
    yield* board.markRead({ viewer: user, channelName: "general" });
    assert.equal((yield* board.listChannels({ viewer: user }))[0]?.unreadCount, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("sorts threads by creation or latest activity and paginates without duplicates", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const first = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "general" },
      text: "First",
    });
    const second = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "general" },
      text: "Second",
    });
    yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "other" },
      text: "Other channel",
    });
    yield* board.post({
      author: agent,
      destination: { kind: "reply", rootId: first.id },
      text: "New activity",
    });
    const input = { viewer: user, channelName: "general", sort: "activity" as const };
    const activity = yield* board.listThreads(input);
    assert.deepEqual(
      activity.threads.map((thread) => thread.root.id),
      [first.id, second.id],
    );
    const created = yield* board.listThreads({ ...input, sort: "created" });
    assert.deepEqual(
      created.threads.map((thread) => thread.root.id),
      [second.id, first.id],
    );
    const page = yield* board.listThreads({ ...input, limit: 1 });
    assert.isNotNull(page.nextCursor);
    assert.deepEqual(
      page.threads.map((thread) => thread.root.id),
      [first.id],
    );
    yield* board.post({
      author: user,
      destination: { kind: "reply", rootId: second.id },
      text: "Concurrent activity",
    });
    const next = yield* board.listThreads({ ...input, limit: 1, cursor: page.nextCursor! });
    assert.deepEqual(
      next.threads.map((thread) => thread.root.id),
      [second.id],
    );
    assert.isNull(next.nextCursor);
    assert.isNull(next.threads[0]!.latestReply);
    const channels = yield* board.listChannels({ viewer: user });
    assert.deepEqual(
      channels.map((channel) => channel.name),
      ["general", "other"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "searches case-insensitive literal substrings newest first with channel and limit filters",
  () =>
    Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const first = yield* board.post({
        author: user,
        destination: { kind: "channel", channelName: "general" },
        text: "Hello 100%_done",
      });
      const reply = yield* board.post({
        author: agent,
        destination: { kind: "reply", rootId: first.id },
        text: "hELLo again",
      });
      const other = yield* board.post({
        author: user,
        destination: { kind: "channel", channelName: "other" },
        text: "HELLO",
      });
      assert.deepEqual(
        (yield* board.searchPosts({ viewer: user, query: "hello" })).map((post) => post.id),
        [other.id, reply.id, first.id],
      );
      assert.deepEqual(
        (yield* board.searchPosts({
          viewer: user,
          query: "HELLO",
          channelName: "general",
          limit: 1,
        })).map((post) => post.id),
        [reply.id],
      );
      assert.deepEqual(
        (yield* board.searchPosts({ viewer: user, query: "%_" })).map((post) => post.id),
        [first.id],
      );
      assert.equal((yield* board.searchPosts({ viewer: user, channelName: "general" })).length, 2);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("creates channels idempotently and rejects invalid posts without writing", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const input = { author: user, name: "general", description: "General discussion" };
    const channel = yield* board.createChannel(input);
    assert.deepEqual(yield* board.createChannel(input), channel);
    const conflict = yield* board
      .createChannel({ ...input, description: "Different" })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(conflict));
    for (const text of [" ", "x".repeat(BOARD_POST_TEXT_MAX_CHARS + 1)]) {
      const result = yield* board
        .post({ author: user, destination: { kind: "channel", channelName: "invalid" }, text })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.isTrue(isMessageBoardError(result.failure));
    }
    const missing = yield* board
      .post({
        author: user,
        destination: { kind: "reply", rootId: BoardPostId.make("missing") },
        text: "Reply",
      })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(missing));
    assert.deepEqual(
      (yield* board.listChannels({ viewer: user })).map((value) => value.name),
      ["general"],
    );
    assert.equal((yield* board.listChannels({ viewer: user }))[0]?.postCount, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("subscribes and unsubscribes viewers idempotently for channel and thread targets", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "general" },
      text: "Root",
    });
    const channelTarget = { kind: "channel", channelName: "general" } as const;
    const threadTarget = { kind: "thread", rootId: root.id } as const;
    yield* board.subscribe({ viewer: threadViewer, target: channelTarget });
    yield* board.subscribe({ viewer: threadViewer, target: channelTarget });
    yield* board.subscribe({ viewer: user, target: threadTarget });
    assert.deepEqual(yield* board.listSubscribers(channelTarget), [threadViewer]);
    assert.deepEqual(yield* board.listSubscribers(threadTarget), [user]);
    yield* board.unsubscribe({ viewer: threadViewer, target: channelTarget });
    yield* board.unsubscribe({ viewer: threadViewer, target: channelTarget });
    assert.deepEqual(yield* board.listSubscribers(channelTarget), []);
    assert.deepEqual(yield* board.listSubscribers(threadTarget), [user]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps an unsubscribe when participation would subscribe again", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "general" },
      text: "Root",
    });
    const target = { kind: "thread", rootId: root.id } as const;
    yield* board.subscribe({ viewer: threadViewer, target, implicit: true });
    assert.deepEqual(yield* board.listSubscribers(target), [threadViewer]);
    yield* board.unsubscribe({ viewer: threadViewer, target });
    yield* board.subscribe({ viewer: threadViewer, target, implicit: true });
    assert.deepEqual(yield* board.listSubscribers(target), []);
    yield* board.subscribe({ viewer: threadViewer, target });
    assert.deepEqual(yield* board.listSubscribers(target), [threadViewer]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("publishes posts, channel counts, and only the user's read-marker events", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const pull = yield* Stream.toPull(board.events.pipe(Stream.rechunk(1)));
    const firstEvent = yield* pull.pipe(Effect.forkChild({ startImmediately: true }));
    const root = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "general" },
      text: "Root",
    });
    assert.deepEqual(yield* Fiber.join(firstEvent), [{ type: "post-created", post: root }]);
    const channelEvents = yield* pull;
    assert.equal(channelEvents[0]?.type, "channel-upserted");
    if (channelEvents[0]?.type === "channel-upserted")
      assert.equal(channelEvents[0].channel.unreadCount, 1);
    assert.equal((yield* pull)[0]?.type, "handling-changed");
    yield* board.markRead({ viewer: threadViewer, channelName: "general" });
    yield* board.markRead({ viewer: user, channelName: "general" });
    const markerEvents = yield* pull;
    assert.equal(markerEvents[0]?.type, "read-marker-updated");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("builds agent attribution from the orchestration shell and provider instance", () =>
  Effect.gen(function* () {
    const author = yield* MessageBoardService.agentAuthorForThread(ThreadId.make("thread:board"));
    assert.deepEqual(author, { ...agent, model: "GPT-5.5" });
  }).pipe(
    Effect.provide(
      Layer.merge(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: ThreadId.make("thread:board"),
              title: agent.kind === "agent" ? agent.title : "",
              projectId: ProjectId.make("project:board"),
              providerInstanceId: ProviderInstanceId.make("codex"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
              deletedAt: null,
            } as Awaited<
              Effect.Success<
                ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getThreadShell"]>
              >
            >),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            {
              instanceId: ProviderInstanceId.make("codex"),
              driver: "codex",
              models: [{ slug: "gpt-5.5", name: "GPT-5.5" }],
            },
          ] as unknown as Effect.Success<
            ProviderRegistry.ProviderRegistry["Service"]["getProviders"]
          >),
        }),
      ),
    ),
  ),
);

it.effect("adds a set role to the agent byline and clears it with an empty role", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const threadId = ThreadId.make("roled");
    yield* board.setRole({ threadId, role: "  Reviewer " });
    assert.deepInclude(yield* board.agentAuthor(threadId), { role: "Reviewer" });
    const tooLong = yield* board.setRole({ threadId, role: "x".repeat(41) }).pipe(Effect.flip);
    assert.deepInclude(tooLong, { code: "invalid_input" });
    yield* board.setRole({ threadId, role: "" });
    assert.notProperty(yield* board.agentAuthor(threadId), "role");
  }).pipe(
    Effect.provide(
      MessageBoardService.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: (threadId) =>
              Effect.succeed({
                id: threadId,
                title: agent.title,
                projectId: agent.projectId,
                providerInstanceId: ProviderInstanceId.make("codex"),
                modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
                deletedAt: null,
              } as Effect.Success<
                ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getThreadShell"]>
              >),
          }),
        ),
        Layer.provide(
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed(
              [] as unknown as Effect.Success<
                ProviderRegistry.ProviderRegistry["Service"]["getProviders"]
              >,
            ),
          }),
        ),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(null),
          }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

type ShellResult = Effect.Success<
  ReturnType<ThreadManagementService.ThreadManagementService["Service"]["getThreadShell"]>
>;
type SendResult = Effect.Success<
  ReturnType<ThreadManagementService.ThreadManagementService["Service"]["sendToThread"]>
>;

/**
 * A board whose agents in `running` have a live turn; every send is recorded in `sent`.
 * `parents` maps a delegated child thread to the thread that started it.
 */
const notifyingBoard = (
  running: ReadonlySet<string>,
  sent: Array<{ threadId: string; mode: string; text: string }>,
  parents: ReadonlyMap<string, string> = new Map(),
) =>
  MessageBoardService.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThreadShell: () => Effect.succeed(null) }),
    ),
    Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed({
            projectId: ProjectId.make("project:board"),
            status: running.has(threadId) ? "running" : "idle",
            activeRunId: running.has(threadId) ? "run" : null,
            lineage: {
              parentThreadId: parents.get(threadId) ?? null,
              relationshipToParent: parents.has(threadId) ? "subagent" : null,
              rootThreadId: parents.get(threadId) ?? threadId,
            },
          } as unknown as ShellResult),
        getThreadRecords: () => Effect.succeed({ checkpoints: [], turnItems: [] } as never),
        sendToThread: (input) =>
          Effect.sync(() => {
            sent.push({ threadId: input.threadId, mode: input.mode, text: input.text });
            return {} as SendResult;
          }),
        dispatch: (command) =>
          Effect.sync(() => {
            assert.equal(command.type, "message.dispatch");
            if (command.type === "message.dispatch") {
              assert.isTrue(command.notificationOnly);
              assert.deepEqual(command.dispatchMode, {
                type: "steer_active",
                targetRunId: RunId.make("run"),
              });
              sent.push({ threadId: command.threadId, mode: "notify", text: command.text });
            }
            return {} as never;
          }),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

const agentNamed = (threadId: string): BoardAuthor => ({
  ...agent,
  threadId: ThreadId.make(threadId),
  title: threadId,
});

it.effect(
  "tells running subscribers and tagged agents on the intended run, never starting idle ones",
  () => {
    const sent: Array<{ threadId: string; mode: string; text: string }> = [];
    const tagged = "thread:tagged";
    return Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const general = { kind: "channel", channelName: "general" } as const;
      yield* board.post({ author: agentNamed(tagged), destination: general, text: "Hello" });
      for (const threadId of ["thread:active", "thread:idle", "thread:board"]) {
        yield* board.subscribe({
          viewer: { kind: "thread", threadId: ThreadId.make(threadId) },
          target: general,
        });
      }
      const result = yield* board.postAndNotify({
        author: agent,
        destination: general,
        text: `@${boardPersona(tagged).name} please review`,
        notifyThreads: [ThreadId.make("thread:explicit-idle")],
        requestKey: "review-notice",
      });
      assert.deepEqual(result.post.mentions, [ThreadId.make(tagged)]);
      assert.sameMembers([...result.notifiedThreads], ["thread:tagged", "thread:active"]);
      assert.sameMembers([...result.skippedThreads], ["thread:explicit-idle", "thread:idle"]);
      assert.isTrue(sent.every((item) => item.mode === "notify"));
      assert.match(sent.find((item) => item.threadId === tagged)!.text, /^You were mentioned/);
      const replay = yield* board.postAndNotify({
        author: agent,
        destination: general,
        text: `@${boardPersona(tagged).name} please review`,
        notifyThreads: [ThreadId.make("thread:explicit-idle")],
        requestKey: "review-notice",
      });
      assert.equal(replay.post.id, result.post.id);
      assert.lengthOf(sent, 2);
      const changedTargets = yield* board
        .postAndNotify({
          author: agent,
          destination: general,
          text: `@${boardPersona(tagged).name} please review`,
          notifyThreads: [],
          requestKey: "review-notice",
        })
        .pipe(Effect.result);
      assert.equal(changedTargets._tag, "Failure");
      const members = (yield* board.readThread({ viewer: user, rootId: result.post.id })).members;
      assert.isTrue(
        members.some((m) => m.author.kind === "agent" && m.subscribed && m.postCount === 1),
      );
    }).pipe(
      Effect.provide(notifyingBoard(new Set(["thread:active", tagged, "thread:board"]), sent)),
    );
  },
);

it.effect("starts an idle thread only when tagged by its delegating agent or the user", () => {
  const sent: Array<{ threadId: string; mode: string; text: string }> = [];
  const author = agentNamed("thread:author");
  const reviewer = "thread:reviewer";
  const solo = "thread:lone";
  return Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const general = { kind: "channel", channelName: "general" } as const;
    const root = yield* board.post({ author, destination: general, text: "Round 1" });
    const thread = { kind: "reply", rootId: root.id } as const;
    yield* board.post({ author: agentNamed(reviewer), destination: thread, text: "Review" });
    yield* board.post({ author: agentNamed(solo), destination: thread, text: "Notes" });
    yield* board.subscribe({
      viewer: { kind: "thread", threadId: ThreadId.make(reviewer) },
      target: { kind: "thread", rootId: root.id },
    });
    const tag = `@${boardPersona(reviewer).name}`;

    const untagged = yield* board.postAndNotify({ author, destination: thread, text: "Round 2" });
    assert.include([...untagged.skippedThreads], ThreadId.make(reviewer));
    const stranger = yield* board.postAndNotify({
      author: agentNamed("thread:stranger"),
      destination: thread,
      text: `${tag} again?`,
    });
    assert.deepEqual([...stranger.notifiedThreads], []);
    assert.equal(sent.length, 0);

    const owner = yield* board.postAndNotify({
      author,
      destination: thread,
      text: `${tag} round 2`,
    });
    assert.deepEqual([...owner.notifiedThreads], [reviewer]);
    const byUser = yield* board.postAndNotify({
      author: user,
      destination: thread,
      text: `@${boardPersona(solo).name} thoughts?`,
    });
    assert.include([...byUser.notifiedThreads], ThreadId.make(solo));
    assert.deepEqual(
      sent.map((item) => [item.threadId, item.mode]),
      [[reviewer, "auto"]],
    );
    assert.match(sent[0]!.text, /then reply there\.$/);
  }).pipe(Effect.provide(notifyingBoard(new Set(), sent, new Map([[reviewer, "thread:author"]]))));
});

it.effect("user replies persist individual responsibilities without inline paid dispatch", () => {
  const sent: Array<{ threadId: string; mode: string; text: string }> = [];
  return Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const target = agentNamed("thread:reply-target");
    const root = yield* board.post({
      author: target,
      destination: { kind: "channel", channelName: "general" },
      text: "Ready",
    });
    for (const text of ["Please summarize", "One more question"]) {
      const result = yield* board.postAndNotify({
        author: user,
        destination: { kind: "reply", rootId: root.id },
        replyToId: root.id,
        text,
      });
      assert.deepEqual(result.notifiedThreads, [ThreadId.make("thread:reply-target")]);
      assert.deepEqual(result.coalescedThreads, []);
      assert.notProperty(result.post, "mentions");
    }
    assert.deepEqual(
      sent.map(({ mode }) => mode),
      [],
    );
  }).pipe(Effect.provide(notifyingBoard(new Set(), sent)));
});

it.effect("replies preserve wake ownership and do not notify their own author", () => {
  const sent: Array<{ threadId: string; mode: string; text: string }> = [];
  const parent = "thread:parent";
  const child = ThreadId.make("thread:child");
  return Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = yield* board.post({
      author: agentNamed(child),
      destination: { kind: "channel", channelName: "general" },
      text: "Ready",
    });
    for (const author of [agentNamed("thread:stranger"), agentNamed(child), agentNamed(parent)]) {
      const result = yield* board.postAndNotify({
        author,
        destination: { kind: "reply", rootId: root.id },
        replyToId: root.id,
        text: "Follow up",
      });
      assert.deepEqual(
        result.notifiedThreads,
        author.kind === "agent" && author.threadId === parent ? [child] : [],
      );
    }
    assert.deepEqual(
      sent.map(({ threadId, mode }) => [threadId, mode]),
      [[child, "auto"]],
    );
  }).pipe(Effect.provide(notifyingBoard(new Set(), sent, new Map([[child, parent]]))));
});

it.effect("a reply and mention of the same running agent persist one responsibility", () => {
  const sent: Array<{ threadId: string; mode: string; text: string }> = [];
  const target = ThreadId.make("thread:running-reply");
  return Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = yield* board.post({
      author: agentNamed(target),
      destination: { kind: "channel", channelName: "general" },
      text: "Working",
    });
    const result = yield* board.postAndNotify({
      author: user,
      destination: { kind: "reply", rootId: root.id },
      replyToId: root.id,
      text: `@${boardPersona(target).name} follow up`,
    });
    assert.deepEqual(result.notifiedThreads, [target]);
    assert.deepEqual(
      sent.map(({ threadId, mode }) => [threadId, mode]),
      [],
    );
  }).pipe(Effect.provide(notifyingBoard(new Set([target]), sent)));
});

it.effect("records how long an agent worked before each post in its run", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const general = { kind: "channel", channelName: "general" } as const;
    yield* TestClock.adjust("90 seconds");
    const first = yield* board.post({ author: agent, destination: general, text: "Round 1" });
    yield* TestClock.adjust("5 seconds");
    const reply = { kind: "reply", rootId: first.id } as const;
    const second = yield* board.post({ author: agent, destination: reply, text: "Correction" });
    const fromUser = yield* board.post({ author: user, destination: reply, text: "Thanks" });
    assert.closeTo(first.workedMs!, 90_000, 5);
    assert.closeTo(second.workedMs!, 5_000, 5);
    assert.isUndefined(fromUser.workedMs);
  }).pipe(
    Effect.provide(
      MessageBoardService.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: () => Effect.succeed(null),
          }),
        ),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                activityRunStartedAt: DateTime.makeUnsafe(0),
              } as unknown as ShellResult),
          }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("shows a run's own edits once, on its last post in the discussion", () => {
  const mine = { path: "src/shop.luau", kind: "modified", additions: 30, deletions: 17 };
  const theirs = { path: "src/other.luau", kind: "modified", additions: 2, deletions: 0 };
  let activeRunId = "run-edits";
  return Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const general = { kind: "channel", channelName: "general" } as const;
    const root = yield* board.post({ author: agent, destination: general, text: "Round 1" });
    const reply = { kind: "reply", rootId: root.id } as const;
    yield* board.post({ author: agent, destination: reply, text: "Correction" });
    activeRunId = "run-read-only";
    yield* board.post({ author: agent, destination: reply, text: "Review" });
    yield* board.post({ author: user, destination: reply, text: "Ok" });
    const { posts } = yield* board.readThread({ viewer: user, rootId: root.id });
    assert.deepEqual(
      posts.map((post) => post.changes),
      [undefined, { runId: "run-edits" as never, files: [mine] }, undefined, undefined],
    );
    const latest = yield* board.readThread({ viewer: user, rootId: root.id, limit: 1 });
    assert.isTrue(latest.posts.every((post) => post.changes === undefined));
    const review = yield* board.readThread({
      viewer: user,
      rootId: root.id,
      limit: 1,
      cursor: latest.olderPostsCursor!,
    });
    assert.isTrue(review.posts.every((post) => post.changes === undefined));
    const correction = yield* board.readThread({
      viewer: user,
      rootId: root.id,
      limit: 1,
      cursor: review.olderPostsCursor!,
    });
    assert.deepEqual(
      correction.posts.map((post) => post.changes),
      [undefined, { runId: "run-edits" as never, files: [mine] }],
    );
    assert.isNull(correction.olderPostsCursor);
  }).pipe(
    Effect.provide(
      MessageBoardService.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: () => Effect.succeed(null),
          }),
        ),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Effect.succeed({ activeRunId } as unknown as ShellResult),
            // Both runs' checkpoints include another agent's edit to the shared checkout.
            getThreadRecords: () =>
              Effect.succeed({
                checkpoints: [
                  { runId: "run-edits", appRunOrdinal: 1, status: "ready", files: [mine, theirs] },
                  { runId: "run-read-only", appRunOrdinal: 2, status: "ready", files: [theirs] },
                ],
                turnItems: [
                  { type: "file_change", runId: "run-edits", fileName: "/repo/src/shop.luau" },
                ],
              } as never),
          }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

it.effect("keeps reply targets inside the same discussion", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const general = { kind: "channel", channelName: "general" } as const;
    const first = yield* board.post({ author: user, destination: general, text: "One" });
    const other = yield* board.post({ author: user, destination: general, text: "Two" });
    const reply = yield* board.post({
      author: agent,
      destination: { kind: "reply", rootId: first.id },
      text: "Answer",
      replyToId: first.id,
    });
    assert.equal((yield* board.readPost({ postId: reply.id })).replyToId, first.id);
    const crossed = yield* board
      .post({
        author: agent,
        destination: { kind: "reply", rootId: first.id },
        text: "Wrong",
        replyToId: other.id,
      })
      .pipe(Effect.flip);
    assert.isTrue(isMessageBoardError(crossed) && crossed.code === "invalid_input");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("groups reactions by emoji and removes only the reactor's own", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = yield* board.post({
      author: agent,
      destination: { kind: "channel", channelName: "general" },
      text: "Ship it?",
    });
    yield* board.react({ viewer: user, postId: root.id, emoji: "👍", active: true });
    yield* board.react({ viewer: threadViewer, postId: root.id, emoji: "👍", active: true });
    yield* board.react({ viewer: threadViewer, postId: root.id, emoji: "🎉", active: true });
    yield* board.react({ viewer: user, postId: root.id, emoji: "👍", active: true });
    const read = () => board.readThread({ viewer: user, rootId: root.id });
    assert.deepEqual((yield* read()).posts[0]?.reactions, [
      { emoji: "👍", by: [user, threadViewer] },
      { emoji: "🎉", by: [threadViewer] },
    ]);
    yield* board.react({ viewer: user, postId: root.id, emoji: "👍", active: false });
    assert.deepEqual((yield* read()).posts[0]?.reactions, [
      { emoji: "👍", by: [threadViewer] },
      { emoji: "🎉", by: [threadViewer] },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reports when each agent last read a discussion", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = yield* board.post({
      author: agent,
      destination: { kind: "channel", channelName: "general" },
      text: "Status?",
    });
    const before = (yield* board.readThread({ viewer: user, rootId: root.id })).members[0];
    assert.isUndefined(before?.readAt);
    yield* board.markRead({ viewer: threadViewer, rootId: root.id });
    const after = (yield* board.readThread({ viewer: user, rootId: root.id })).members[0];
    assert.isAbove(after!.readAt!.localeCompare(root.createdAt), 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("lists an agent's posted and subscribed discussions across channels by activity", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = (channelName: string, text: string) =>
      board.post({ author: user, destination: { kind: "channel", channelName }, text });
    const posted = yield* root("general", "Posted in");
    yield* board.post({
      author: agent,
      destination: { kind: "reply", rootId: posted.id },
      text: "On it",
    });
    const subscribed = yield* root("release", "Subscribed to");
    yield* board.subscribe({
      viewer: threadViewer,
      target: { kind: "thread", rootId: subscribed.id },
    });
    const left = yield* root("general", "Left");
    yield* board.subscribe({ viewer: threadViewer, target: { kind: "thread", rootId: left.id } });
    yield* board.unsubscribe({ viewer: threadViewer, target: { kind: "thread", rootId: left.id } });
    const onlyRead = yield* root("general", "Only read");
    yield* board.markRead({ viewer: threadViewer, rootId: onlyRead.id });
    yield* root("general", "Someone else's");
    yield* board.markRead({ viewer: user, rootId: subscribed.id });
    const releaseThreadReadAt = (yield* board.readThread({ viewer: user, rootId: subscribed.id }))
      .summary.readAt!;
    yield* board.markRead({ viewer: user, channelName: "general" });
    const generalChannelReadAt = (yield* board.readThread({ viewer: user, rootId: posted.id }))
      .summary.readAt!;
    yield* board.markRead({ viewer: user, rootId: posted.id });
    yield* board.markRead({ viewer: user, channelName: "release" });

    const { statements, tracer } = traceSqlStatements();
    const listed = yield* board
      .listAgentThreads({ viewer: user, threadId: agent.threadId })
      .pipe(Effect.withTracer(tracer));
    assert.deepEqual(
      listed.map((summary) => [summary.root.text, summary.root.channelName, summary.unread]),
      [
        ["Subscribed to", "release", false],
        ["Posted in", "general", false],
      ],
    );
    assert.equal(listed[1]?.replyCount, 1);
    assert.isAbove(listed[0]!.readAt!.localeCompare(releaseThreadReadAt), 0);
    assert.isAbove(listed[1]!.readAt!.localeCompare(generalChannelReadAt), 0);
    assert.isAtMost(statements.length, 3);
    const unread = yield* board.listAgentThreads({
      viewer: threadViewer,
      threadId: agent.threadId,
    });
    assert.isTrue(unread.every((summary) => summary.unread && summary.readAt === undefined));
    assert.deepEqual(
      yield* board.listAgentThreads({ viewer: user, threadId: ThreadId.make("nobody") }),
      [],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "folds further posts into one pending notice until the agent reads the discussion",
  () => {
    const sent: Array<{ threadId: string; mode: string; text: string }> = [];
    const listener = ThreadId.make("thread:listener");
    return Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const root = yield* board.post({
        author: user,
        destination: { kind: "channel", channelName: "general" },
        text: "Root",
      });
      yield* board.subscribe({
        viewer: { kind: "thread", threadId: listener },
        target: { kind: "thread", rootId: root.id },
      });
      const reply = (text: string) =>
        board.postAndNotify({
          author: agent,
          destination: { kind: "reply", rootId: root.id },
          text,
        });
      assert.deepEqual((yield* reply("First")).notifiedThreads, [listener]);
      const second = yield* reply("Second");
      assert.deepEqual(second.notifiedThreads, []);
      assert.deepEqual(second.coalescedThreads, [listener]);
      yield* board.markRead({ viewer: { kind: "thread", threadId: listener }, rootId: root.id });
      assert.deepEqual((yield* reply("Third")).notifiedThreads, [listener]);
      // A tag still gets through while a notice is pending.
      const tagged = yield* reply(`@${boardPersona(listener).name} need you`);
      assert.deepEqual(tagged.notifiedThreads, [listener]);
      assert.equal(sent.length, 3);
    }).pipe(Effect.provide(notifyingBoard(new Set([listener]), sent)));
  },
);

it.effect("guards closure against every unresolved request and preserves a concurrent reply", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "closure" },
      text: "Discuss",
      mode: "note",
    });
    const initial = yield* board.readHandling({ rootId: root.id, viewer: user });
    yield* board.closeDiscussion({
      rootId: root.id,
      expectedRevision: initial.revision,
      viewer: user,
    });
    const closed = yield* board.readHandling({ rootId: root.id, viewer: user });
    const rejected = yield* board
      .post({
        author: user,
        destination: { kind: "reply", rootId: root.id },
        text: "Keep my draft",
      })
      .pipe(Effect.result);
    assert.equal(rejected._tag, "Failure");
    const note = yield* board.post({
      author: user,
      destination: { kind: "reply", rootId: root.id },
      text: "A note",
      mode: "note",
    });
    assert.equal(note.text, "A note");
    const stale = yield* board
      .post({
        author: user,
        destination: { kind: "reply", rootId: root.id },
        text: "Reopen",
        mode: "reopen-and-send",
        expectedRevision: closed.revision,
      })
      .pipe(Effect.result);
    assert.equal(stale._tag, "Failure");
    const state = yield* board.readHandling({ rootId: root.id, viewer: user });
    const reopened = yield* board.post({
      author: user,
      destination: { kind: "reply", rootId: root.id },
      text: "Reopen",
      mode: "reopen-and-send",
      expectedRevision: state.revision,
    });
    assert.equal(reopened.text, "Reopen");
    assert.equal((yield* board.readHandling({ rootId: root.id, viewer: user })).lifecycle, "open");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("stores requests durably and rolls them back with a failed outbox intent", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const sql = yield* SqlClient.SqlClient;
    const root = yield* board.post({
      author: agent,
      destination: { kind: "channel", channelName: "durable" },
      text: "Discuss",
    });
    const initial = yield* board.readHandling({ rootId: root.id, viewer: user });
    assert.equal(initial.leadThreadId, agent.threadId);
    assert.equal(initial.suggestedLeadThreadId, agent.threadId);
    assert.lengthOf(initial.responsibilities, 0);
    const input = {
      author: user,
      destination: { kind: "reply" as const, rootId: root.id },
      text: `@Worker[${agent.threadId}] do this`,
      requestKey: "durable-request",
    };
    const posted = yield* board.postAndNotify(input);
    const replay = yield* board.postAndNotify(input);
    assert.equal(posted.post.id, replay.post.id);
    const state = yield* board.readHandling({ rootId: root.id, viewer: user });
    assert.lengthOf(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`, 1);
    assert.lengthOf(state.responsibilities, 1);
    assert.equal(state.responsibilities[0]!.postId, posted.post.id);
    const blocked = yield* board
      .closeDiscussion({ rootId: root.id, expectedRevision: state.revision, viewer: user })
      .pipe(Effect.result);
    assert.equal(blocked._tag, "Failure");
    yield* sql`CREATE TRIGGER reject_request BEFORE INSERT ON orchestration_v2_effect_outbox BEGIN SELECT RAISE(ABORT, 'reject dispatch'); END`;
    const failed = yield* board
      .postAndNotify({
        ...input,
        requestKey: "rollback",
        text: `@Worker[${agent.threadId}] rollback`,
      })
      .pipe(Effect.result);
    assert.equal(failed._tag, "Failure");
    const posts = yield* board.searchPosts({ viewer: user, channelName: "durable" });
    assert.lengthOf(posts, 2);
    assert.equal(
      (yield* board.readHandling({ rootId: root.id, viewer: user })).revision,
      state.revision,
    );
  }).pipe(Effect.provide(layerTodoOwners)),
);
