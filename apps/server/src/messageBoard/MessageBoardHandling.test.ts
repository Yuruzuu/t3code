import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MessageBoardError,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type BoardPostId,
  type BoardResponsibility,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as MessageBoardHandlingStore from "./MessageBoardHandlingStore.ts";
import * as MessageBoardService from "./MessageBoardService.ts";

const decodeBoardError = Schema.decodeUnknownSync(MessageBoardError);
const user = { kind: "user" } as const;
const firstAgent = ThreadId.make("handling-first");
const secondAgent = ThreadId.make("handling-second");
const leadAgent = ThreadId.make("handling-lead");

const layerTest = MessageBoardService.layer.pipe(
  Layer.provideMerge(EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  Layer.provide(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: () =>
        Effect.succeed({
          thread: { archivedAt: null, deletedAt: null, lineage: { relationshipToParent: "root" } },
          runs: [],
          turnItems: [],
        } as never),
      getThreadShell: (id) =>
        Effect.succeed({
          id,
          deletedAt: null,
          projectId: ProjectId.make("handling-project"),
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

const queueRequest = Effect.fn("test.queueHandlingRequest")(function* (
  rootId: BoardPostId,
  request: BoardResponsibility,
  batchId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO board_dispatch_batches(id,root_id,recipient_thread_id,requests_json) VALUES(${batchId},${rootId},${request.recipientThreadId},${JSON.stringify([{ id: request.id, generation: request.generation }])})`;
  yield* sql`UPDATE board_responsibilities SET batch_id=${batchId},status='queued' WHERE id=${request.id}`;
});

it.effect(
  "cannot complete an automatically selected response without a visible reply from its run",
  () =>
    Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const handling = yield* MessageBoardHandlingStore.make;
      const sql = yield* SqlClient.SqlClient;
      const root = yield* board.post({
        author: yield* board.agentAuthor(firstAgent),
        destination: { kind: "channel", channelName: "visible-reply" },
        text: "Discuss here.",
      });
      const sent = yield* board.postAndNotify({
        author: user,
        destination: { kind: "reply", rootId: root.id },
        text: "Thanks!",
      });
      const state = yield* board.readHandling({ rootId: root.id, viewer: user });
      const request = state.responsibilities.find((item) => item.postId === sent.post.id)!;
      const runId = RunId.make("reply-run");
      yield* queueRequest(root.id, request, "reply-batch");
      yield* handling.executionContext({ batchId: "reply-batch", threadId: firstAgent, runId });
      const current = yield* board.readHandling({ rootId: root.id, viewer: user });
      const input = {
        rootId: root.id,
        expectedRevision: current.revision,
        responsibilityId: request.id,
        expectedGeneration: request.generation,
        runId,
        viewer: { kind: "thread" as const, threadId: firstAgent },
        outcome: { kind: "answered" as const, text: "Acknowledged", sourcePostIds: [sent.post.id] },
      };
      const silent = yield* board.reportOutcome(input).pipe(Effect.result);
      assert.ok(Result.isFailure(silent));
      if (Result.isFailure(silent))
        assert.equal(decodeBoardError(silent.failure).conflict?.kind, "missing-response");
      yield* sql`INSERT INTO board_posts(id,root_id,channel_name,author_json,text,created_at,run_id) VALUES('visible-response',${root.id},'visible-reply',${JSON.stringify(yield* board.agentAuthor(firstAgent))},'You are welcome.','2026-10-30T00:00:01.000Z',${runId})`;
      const answered = yield* board.reportOutcome(input);
      assert.equal(answered.responsibilities[0]!.status, "completed");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("assigns new discussions to their creating agent and routes ordinary user replies", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const author = yield* board.agentAuthor(firstAgent);
    const root = yield* board.post({
      author,
      destination: { kind: "channel", channelName: "automatic-lead" },
      text: "Coordinate the parser review here.",
    });
    const initial = yield* board.readHandling({ rootId: root.id, viewer: user });
    assert.equal(initial.leadThreadId, firstAgent);
    const updated = yield* board.updateContext({
      rootId: root.id,
      expectedRevision: initial.revision,
      viewer: { kind: "thread", threadId: firstAgent },
      context: { text: "Use the latest parser decision.", decisionPostIds: [root.id] },
    });
    const reply = yield* board.postAndNotify({
      author: user,
      destination: { kind: "reply", rootId: root.id },
      text: "Please check the error case too.",
    });
    const final = yield* board.readHandling({ rootId: root.id, viewer: user });
    assert.equal(
      final.responsibilities.find((request) => request.postId === reply.post.id)?.recipientThreadId,
      firstAgent,
    );
    assert.deepEqual(final.context, updated.context);
    assert.lengthOf(final.responsibilities, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("lets one agent claim an unassigned discussion and adopt only unassigned requests", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const sql = yield* SqlClient.SqlClient;
    const root = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "claim-lead" },
      text: "Please coordinate this review.",
    });
    const addressed = yield* board.post({
      author: user,
      destination: { kind: "reply", rootId: root.id },
      text: `@Second[${secondAgent}] check the tests.`,
    });
    yield* sql`DELETE FROM board_responder_selection_posts WHERE post_id=${root.id}`;
    yield* sql`DELETE FROM board_responder_selections WHERE root_id=${root.id}`;
    const legacy = yield* MessageBoardHandlingStore.make;
    yield* legacy.createForPost({
      rootId: root.id,
      postId: root.id,
      suggestedLeadThreadId: null,
      recipients: [],
      requireAssignment: true,
    });
    const initial = yield* board.readHandling({ rootId: root.id, viewer: user });
    const impersonated = yield* board
      .assignLead({
        rootId: root.id,
        expectedRevision: initial.revision,
        leadThreadId: secondAgent,
        viewer: { kind: "thread", threadId: firstAgent },
      })
      .pipe(Effect.result);
    assert.ok(Result.isFailure(impersonated));
    if (Result.isFailure(impersonated))
      assert.equal(decodeBoardError(impersonated.failure).conflict?.kind, "ownership");
    yield* sql`CREATE TRIGGER reject_adoption BEFORE INSERT ON orchestration_v2_effect_outbox
      WHEN NEW.effect_id LIKE 'board-adopt:%' BEGIN SELECT RAISE(ABORT, 'adoption failed'); END`;
    const rejected = yield* board
      .assignLead({
        rootId: root.id,
        expectedRevision: initial.revision,
        leadThreadId: firstAgent,
        viewer: { kind: "thread", threadId: firstAgent },
      })
      .pipe(Effect.result);
    assert.ok(Result.isFailure(rejected));
    assert.deepEqual(yield* board.readHandling({ rootId: root.id, viewer: user }), initial);
    yield* sql`DROP TRIGGER reject_adoption`;
    const claims = yield* Effect.forEach(
      [firstAgent, secondAgent],
      (threadId) =>
        board
          .assignLead({
            rootId: root.id,
            expectedRevision: initial.revision,
            leadThreadId: threadId,
            viewer: { kind: "thread", threadId },
          })
          .pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    const accepted = claims.filter(Result.isSuccess);
    assert.lengthOf(accepted, 1);
    const claimed = accepted[0]!.success;
    assert.equal(
      claimed.responsibilities.find((request) => request.postId === root.id)?.recipientThreadId,
      claimed.leadThreadId,
    );
    assert.equal(
      claimed.responsibilities.find((request) => request.postId === addressed.id)
        ?.recipientThreadId,
      secondAgent,
    );
    assert.lengthOf(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, 2);
    const takeover = yield* board
      .assignLead({
        rootId: root.id,
        expectedRevision: claimed.revision,
        leadThreadId: claimed.leadThreadId === firstAgent ? secondAgent : firstAgent,
        viewer: {
          kind: "thread",
          threadId: claimed.leadThreadId === firstAgent ? secondAgent : firstAgent,
        },
      })
      .pipe(Effect.result);
    assert.ok(Result.isFailure(takeover));
    if (Result.isFailure(takeover))
      assert.equal(decodeBoardError(takeover.failure).conflict?.kind, "ownership");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "routes new replies in legacy discussions without assigning history or turning notes into work",
  () =>
    Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const sql = yield* SqlClient.SqlClient;
      const root = yield* board.post({
        author: yield* board.agentAuthor(firstAgent),
        destination: { kind: "channel", channelName: "legacy-coordinator" },
        text: "Original discussion context.",
      });
      yield* sql`UPDATE board_discussions SET lead_thread_id=NULL WHERE root_id=${root.id}`;
      const initial = yield* board.readHandling({ rootId: root.id, viewer: user });
      assert.isNull(initial.leadThreadId);
      assert.lengthOf(initial.responsibilities, 0);
      yield* board.postAndNotify({
        author: user,
        destination: { kind: "reply", rootId: root.id },
        text: "A reference note.",
        mode: "note",
      });
      assert.lengthOf(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, 0);
      const reply = yield* board.postAndNotify({
        author: user,
        destination: { kind: "reply", rootId: root.id },
        text: "Please check this change.",
      });
      const state = yield* board.readHandling({ rootId: root.id, viewer: user });
      assert.isNull(state.leadThreadId);
      assert.lengthOf(state.responsibilities, 1);
      assert.equal(state.responsibilities[0]!.postId, reply.post.id);
      assert.equal(state.responsibilities[0]!.recipientThreadId, firstAgent);
      assert.lengthOf(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "builds request context from the discussion and reply source without manual context fields",
  () =>
    Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const handling = yield* MessageBoardHandlingStore.make;
      const root = yield* board.post({
        author: yield* board.agentAuthor(firstAgent),
        destination: { kind: "channel", channelName: "automatic-context" },
        text: "The goal is to review parser recovery.",
      });
      const source = yield* board.post({
        author: yield* board.agentAuthor(secondAgent),
        destination: { kind: "reply", rootId: root.id },
        text: "The previous parser proposal needs a correction.",
      });
      const reply = yield* board.post({
        author: user,
        destination: { kind: "reply", rootId: root.id },
        replyToId: source.id,
        text: "Use the corrected parser behavior.",
      });
      const state = yield* board.readHandling({ rootId: root.id, viewer: user });
      const request = state.responsibilities.find((item) => item.postId === reply.id)!;
      yield* queueRequest(root.id, request, "automatic-context-batch");
      const execution = yield* handling.executionContext({
        batchId: "automatic-context-batch",
        threadId: secondAgent,
        runId: RunId.make("automatic-context-run"),
      });
      assert.include(execution!, root.text);
      assert.include(execution!, source.text);
      assert.include(execution!, reply.text);
      assert.equal(state.context.text, "");
      assert.lengthOf(state.context.decisionPostIds, 0);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "rejects stale recipient generations and a lead resolving another agent's contribution",
  () =>
    Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const handling = yield* MessageBoardHandlingStore.make;
      const root = yield* board.post({
        author: user,
        destination: { kind: "channel", channelName: "ownership" },
        text: "Review this",
        mode: "note",
      });
      yield* board.postAndNotify({
        author: user,
        destination: { kind: "reply", rootId: root.id },
        text: `@First[${firstAgent}] review`,
      });
      const initial = yield* board.readHandling({ rootId: root.id, viewer: user });
      const original = initial.responsibilities[0]!;
      const assigned = yield* board.assignLead({
        rootId: root.id,
        viewer: user,
        expectedRevision: initial.revision,
        leadThreadId: leadAgent,
      });
      const foreign = yield* board
        .reassignRequest({
          rootId: root.id,
          viewer: { kind: "thread", threadId: secondAgent },
          expectedRevision: assigned.revision,
          responsibilityId: original.id,
          expectedGeneration: original.generation,
          recipientThreadId: secondAgent,
        })
        .pipe(Effect.result);
      assert.ok(Result.isFailure(foreign));
      if (Result.isFailure(foreign))
        assert.deepInclude(foreign.failure, {
          code: "conflict",
          conflict: { kind: "ownership", rootId: root.id, revision: assigned.revision },
        });
      yield* queueRequest(root.id, original, "old-assignment");
      const reassigned = yield* board.reassignRequest({
        rootId: root.id,
        viewer: { kind: "thread", threadId: leadAgent },
        expectedRevision: assigned.revision,
        responsibilityId: original.id,
        expectedGeneration: original.generation,
        recipientThreadId: secondAgent,
      });
      const request = reassigned.responsibilities[0]!;
      assert.equal(request.generation, original.generation + 1);
      assert.equal(request.recipientThreadId, secondAgent);
      assert.isNull(
        yield* handling.executionContext({
          batchId: "old-assignment",
          threadId: firstAgent,
          runId: RunId.make("old-run"),
        }),
      );
      const stale = yield* board
        .reassignRequest({
          rootId: root.id,
          viewer: user,
          expectedRevision: reassigned.revision,
          responsibilityId: original.id,
          expectedGeneration: original.generation,
          recipientThreadId: firstAgent,
        })
        .pipe(Effect.result);
      assert.ok(Result.isFailure(stale));
      if (Result.isFailure(stale))
        assert.equal(decodeBoardError(stale.failure).conflict?.kind, "generation");
      yield* queueRequest(root.id, request, "new-assignment");
      const runId = RunId.make("recipient-run");
      assert.isNotNull(
        yield* handling.executionContext({
          batchId: "new-assignment",
          threadId: secondAgent,
          runId,
        }),
      );
      const running = yield* board.readHandling({ rootId: root.id, viewer: user });
      const outcome = {
        rootId: root.id,
        expectedRevision: running.revision,
        responsibilityId: request.id,
        expectedGeneration: request.generation,
        runId,
        outcome: { kind: "answered" as const, text: "Reviewed", sourcePostIds: [request.postId] },
      };
      const leadOutcome = yield* board
        .reportOutcome({ ...outcome, viewer: { kind: "thread", threadId: leadAgent } })
        .pipe(Effect.result);
      assert.ok(Result.isFailure(leadOutcome));
      if (Result.isFailure(leadOutcome))
        assert.equal(decodeBoardError(leadOutcome.failure).conflict?.kind, "ownership");
      const completed = yield* board.reportOutcome({
        ...outcome,
        viewer: { kind: "thread", threadId: secondAgent },
      });
      assert.equal(completed.responsibilities[0]!.status, "completed");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("scoped resume authorizes only the selected held responsibility", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const handling = yield* MessageBoardHandlingStore.make;
    const sql = yield* SqlClient.SqlClient;
    const root = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "resume" },
      text: "Two requests",
      mode: "note",
    });
    for (const text of ["First", "Second"])
      yield* board.postAndNotify({
        author: user,
        destination: { kind: "reply", rootId: root.id },
        text: `@First[${firstAgent}] ${text}`,
      });
    const initial = yield* board.readHandling({ rootId: root.id, viewer: user });
    for (const [index, request] of initial.responsibilities.entries()) {
      const batchId = `held-${index}`;
      yield* queueRequest(root.id, request, batchId);
      yield* handling.holdBatch({ batchId, threadId: firstAgent });
    }
    const held = yield* board.readHandling({ rootId: root.id, viewer: user });
    const selected = held.responsibilities[0]!;
    const untouched = held.responsibilities[1]!;
    const resumed = yield* board.resumeRequest({
      rootId: root.id,
      viewer: user,
      expectedRevision: held.revision,
      responsibilityId: selected.id,
      expectedGeneration: selected.generation,
    });
    assert.deepEqual(
      resumed.responsibilities.find((request) => request.id === untouched.id),
      untouched,
    );
    const request = resumed.responsibilities.find((request) => request.id === selected.id)!;
    assert.equal(request.status, "queued");
    assert.equal(request.generation, selected.generation + 1);
    const batches = yield* sql<{
      requests_json: string;
      scoped_resume: number;
    }>`SELECT requests_json,scoped_resume FROM board_dispatch_batches WHERE id=${request.batchId!}`;
    assert.equal(batches[0]!.scoped_resume, 1);
    assert.deepEqual(JSON.parse(batches[0]!.requests_json), [
      { id: selected.id, generation: selected.generation + 1 },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "keeps an older unresolved gap open after a later request is answered and reassigned",
  () =>
    Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const handling = yield* MessageBoardHandlingStore.make;
      const root = yield* board.post({
        author: user,
        destination: { kind: "channel", channelName: "gaps" },
        text: "Track all requests",
        mode: "note",
      });
      const before = yield* board.readHandling({ rootId: root.id, viewer: user });
      const earlier = yield* board.postAndNotify({
        author: user,
        destination: { kind: "reply", rootId: root.id },
        text: `@First[${firstAgent}] Older request`,
      });
      const staleClose = yield* board
        .closeDiscussion({ rootId: root.id, viewer: user, expectedRevision: before.revision })
        .pipe(Effect.result);
      assert.ok(Result.isFailure(staleClose));
      if (Result.isFailure(staleClose))
        assert.equal(decodeBoardError(staleClose.failure).conflict?.kind, "revision");
      const later = yield* board.postAndNotify({
        author: user,
        destination: { kind: "reply", rootId: root.id },
        text: `@Second[${secondAgent}] Later request`,
      });
      const state = yield* board.readHandling({ rootId: root.id, viewer: user });
      const latestRequest = state.responsibilities.find(
        (request) => request.postId === later.post.id,
      )!;
      yield* queueRequest(root.id, latestRequest, "later-batch");
      const runId = RunId.make("later-run");
      yield* handling.executionContext({ batchId: "later-batch", threadId: secondAgent, runId });
      const running = yield* board.readHandling({ rootId: root.id, viewer: user });
      const answered = yield* board.reportOutcome({
        rootId: root.id,
        viewer: { kind: "thread", threadId: secondAgent },
        expectedRevision: running.revision,
        responsibilityId: latestRequest.id,
        expectedGeneration: latestRequest.generation,
        runId,
        outcome: { kind: "answered", text: "Later answer", sourcePostIds: [later.post.id] },
      });
      const older = answered.responsibilities.find(
        (request) => request.postId === earlier.post.id,
      )!;
      const moved = yield* board.reassignRequest({
        rootId: root.id,
        viewer: user,
        expectedRevision: answered.revision,
        responsibilityId: older.id,
        expectedGeneration: older.generation,
        recipientThreadId: secondAgent,
      });
      const close = yield* board
        .closeDiscussion({ rootId: root.id, viewer: user, expectedRevision: moved.revision })
        .pipe(Effect.result);
      assert.ok(Result.isFailure(close));
      if (Result.isFailure(close))
        assert.equal(decodeBoardError(close.failure).conflict?.kind, "unresolved");
      const final = yield* board.readThread({ rootId: root.id, viewer: user });
      assert.equal(final.handling?.lifecycle, "open");
      assert.equal(
        final.handling?.responsibilities.find((request) => request.postId === later.post.id)
          ?.status,
        "completed",
      );
      assert.equal(
        final.handling?.responsibilities.find((request) => request.postId === earlier.post.id)
          ?.status,
        "pending",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "rolls back the post and all responsibilities when durable dispatch intent cannot commit",
  () =>
    Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const sql = yield* SqlClient.SqlClient;
      const root = yield* board.post({
        author: user,
        destination: { kind: "channel", channelName: "outbox-rollback" },
        text: "Discussion",
        mode: "note",
      });
      const before = yield* board.readHandling({ rootId: root.id, viewer: user });
      yield* sql`CREATE TRIGGER reject_board_dispatch BEFORE INSERT ON orchestration_v2_effect_outbox WHEN NEW.effect_type = 'board-dispatch' BEGIN SELECT RAISE(ABORT, 'reject dispatch'); END`;
      const input = {
        author: user,
        destination: { kind: "reply" as const, rootId: root.id },
        text: `@First[${firstAgent}] request`,
        requestKey: "rollback-dispatch",
      };
      const failed = yield* board.postAndNotify(input).pipe(Effect.result);
      assert.ok(Result.isFailure(failed));
      assert.lengthOf(yield* sql`SELECT id FROM board_posts`, 1);
      assert.lengthOf(yield* sql`SELECT id FROM board_responsibilities`, 0);
      assert.lengthOf(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, 0);
      assert.lengthOf(yield* sql`SELECT post_id FROM board_post_requests`, 0);
      assert.equal(
        (yield* board.readHandling({ rootId: root.id, viewer: user })).revision,
        before.revision,
      );
      yield* sql`DROP TRIGGER reject_board_dispatch`;
      const retried = yield* board.postAndNotify(input);
      assert.equal(retried.post.text, input.text);
      assert.lengthOf(yield* sql`SELECT id FROM board_posts`, 2);
      assert.lengthOf(yield* sql`SELECT id FROM board_responsibilities`, 1);
      assert.lengthOf(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "adopts legacy unassigned requests without using lead assignment as response selection",
  () =>
    Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const sql = yield* SqlClient.SqlClient;
      const root = yield* board.postAndNotify({
        author: user,
        destination: { kind: "channel", channelName: "unassigned" },
        text: "Please review this decision",
      });
      yield* sql`DELETE FROM board_responder_selection_posts WHERE post_id=${root.post.id}`;
      yield* sql`DELETE FROM board_responder_selections WHERE root_id=${root.post.id}`;
      const legacy = yield* MessageBoardHandlingStore.make;
      yield* legacy.createForPost({
        rootId: root.post.id,
        postId: root.post.id,
        suggestedLeadThreadId: null,
        recipients: [],
        requireAssignment: true,
      });
      const initial = yield* board.readHandling({ rootId: root.post.id, viewer: user });
      assert.lengthOf(initial.responsibilities, 1);
      const request = initial.responsibilities[0]!;
      assert.isNull(request.recipientThreadId);
      assert.equal(request.status, "needs-attention");
      assert.lengthOf(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, 0);
      const blocked = yield* board
        .closeDiscussion({
          rootId: root.post.id,
          viewer: user,
          expectedRevision: initial.revision,
        })
        .pipe(Effect.result);
      assert.ok(Result.isFailure(blocked));
      if (Result.isFailure(blocked))
        assert.equal(decodeBoardError(blocked.failure).conflict?.kind, "unresolved");
      yield* board.postAndNotify({
        author: user,
        destination: { kind: "reply", rootId: root.post.id },
        text: `@First[${firstAgent}] for reference only`,
        mode: "note",
      });
      const noted = yield* board.readHandling({ rootId: root.post.id, viewer: user });
      assert.deepEqual(noted.responsibilities, initial.responsibilities);
      assert.lengthOf(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, 0);
      const led = yield* board.assignLead({
        rootId: root.post.id,
        viewer: user,
        expectedRevision: noted.revision,
        leadThreadId: leadAgent,
      });
      assert.equal(led.responsibilities[0]!.recipientThreadId, leadAgent);
      assert.equal(led.responsibilities[0]!.status, "pending");
      const assigned = yield* board.reassignRequest({
        rootId: root.post.id,
        viewer: user,
        expectedRevision: led.revision,
        responsibilityId: request.id,
        expectedGeneration: led.responsibilities[0]!.generation,
        recipientThreadId: firstAgent,
      });
      assert.equal(assigned.responsibilities[0]!.recipientThreadId, firstAgent);
      assert.equal(assigned.responsibilities[0]!.status, "pending");
      assert.lengthOf(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, 2);
      const next = yield* board.postAndNotify({
        author: user,
        destination: { kind: "reply", rootId: root.post.id },
        text: "Follow up with the lead",
      });
      const final = yield* board.readHandling({ rootId: root.post.id, viewer: user });
      assert.isUndefined(final.responsibilities.find((item) => item.postId === next.post.id));
      assert.equal(
        final.selections?.find((item) => item.sourcePostIds.includes(next.post.id))?.status,
        "unavailable",
      );
    }).pipe(Effect.provide(layerTest)),
);
