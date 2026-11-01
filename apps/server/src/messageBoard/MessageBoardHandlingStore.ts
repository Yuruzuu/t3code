import {
  BoardHandlingSnapshot,
  BoardPostId,
  MessageBoardError,
  RunId,
  ThreadId,
  BoardHandlingContext,
  BoardHandlingOutcome,
  type BoardViewer,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import * as MessageBoardHandlingEvents from "./MessageBoardHandlingEvents.ts";
import * as MessageBoardSelectionStore from "./MessageBoardSelectionStore.ts";
import * as SqlClient from "effect/sql/SqlClient";

const decodeSnapshot = Schema.decodeUnknownEffect(BoardHandlingSnapshot);
const decodeContextJson = Schema.decodeEffect(Schema.fromJsonString(BoardHandlingContext));
const decodeOutcomeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(BoardHandlingOutcome));
const decodeRequestGenerations = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ id: Schema.String, generation: Schema.Number })),
  ),
);
const encodeOutcomeJson = Schema.encodeEffect(Schema.fromJsonString(BoardHandlingOutcome));

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* MessageBoardHandlingEvents.MessageBoardHandlingEvents;
  const selections = yield* MessageBoardSelectionStore.make;
  const snapshot = Effect.fn("MessageBoardHandlingStore.snapshot")(function* (rootId: BoardPostId) {
    const discussions = yield* sql<{
      revision: number;
      lead_thread_id: string | null;
      suggested_lead_thread_id: string | null;
      lifecycle: string;
      context_json: string;
    }>`SELECT * FROM board_discussions WHERE root_id = ${rootId}`;
    const discussion = discussions[0];
    if (!discussion)
      return yield* new MessageBoardError({ code: "not_found", message: "Discussion not found." });
    const rows = yield* sql<{
      id: string;
      post_id: string;
      recipient_thread_id: string | null;
      generation: number;
      status: string;
      outcome_json: string | null;
      batch_id: string | null;
      run_id: string | null;
      selection_id: string | null;
      availability_reason: string | null;
    }>`SELECT * FROM board_responsibilities WHERE root_id = ${rootId} ORDER BY rowid`;
    return yield* decodeSnapshot({
      rootId,
      revision: discussion.revision,
      leadThreadId: discussion.lead_thread_id,
      suggestedLeadThreadId: discussion.suggested_lead_thread_id,
      lifecycle: discussion.lifecycle,
      context: yield* decodeContextJson(discussion.context_json),
      selections: yield* selections.list(rootId),
      responsibilities: yield* Effect.forEach(
        rows,
        Effect.fnUntraced(function* (row) {
          return {
            id: row.id,
            postId: row.post_id,
            recipientThreadId: row.recipient_thread_id,
            generation: row.generation,
            status: row.status,
            ...(row.outcome_json
              ? {
                  outcome: yield* decodeOutcomeJson(row.outcome_json),
                }
              : {}),
            ...(row.batch_id ? { batchId: row.batch_id } : {}),
            ...(row.run_id ? { runId: row.run_id } : {}),
            ...(row.selection_id ? { selectionId: row.selection_id } : {}),
            ...(row.availability_reason ? { availabilityReason: row.availability_reason } : {}),
          };
        }),
      ),
    });
  });
  const publish = Effect.fn("MessageBoardHandlingStore.publish")(function* (rootId: BoardPostId) {
    yield* PubSub.publish(events.changes, {
      type: "handling-changed",
      handling: yield* snapshot(rootId),
    });
  });
  const conflict = (
    state: BoardHandlingSnapshot,
    kind: NonNullable<MessageBoardError["conflict"]>["kind"],
    responsibilityId?: string,
  ) =>
    new MessageBoardError({
      code: "conflict",
      message: "The discussion changed. Review its current state and try again.",
      conflict: {
        kind,
        rootId: state.rootId,
        revision: state.revision,
        ...(responsibilityId ? { responsibilityId } : {}),
      },
    });
  const guard = Effect.fn("MessageBoardHandlingStore.guard")(function* (
    input: { rootId: BoardPostId; expectedRevision: number; viewer: BoardViewer },
    contribution?: { responsibilityId: string; expectedGeneration: number },
  ) {
    const state = yield* snapshot(input.rootId);
    if (state.revision !== input.expectedRevision) return yield* conflict(state, "revision");
    if (contribution) {
      const request = state.responsibilities.find((r) => r.id === contribution.responsibilityId);
      if (!request || request.generation !== contribution.expectedGeneration)
        return yield* conflict(state, "generation", contribution.responsibilityId);
    }
    if (input.viewer.kind !== "user" && input.viewer.threadId !== state.leadThreadId)
      return yield* conflict(state, "ownership");
    return state;
  });
  const bump = Effect.fn("MessageBoardHandlingStore.bump")(function* (rootId: BoardPostId) {
    yield* sql`UPDATE board_discussions SET revision = revision + 1 WHERE root_id=${rootId}`;
    return yield* snapshot(rootId);
  });
  const createForPost = Effect.fn("MessageBoardHandlingStore.createForPost")(function* (input: {
    rootId: BoardPostId;
    postId: BoardPostId;
    suggestedLeadThreadId: ThreadId | null;
    recipients: ReadonlyArray<ThreadId>;
    requireAssignment?: boolean;
  }) {
    yield* sql`INSERT INTO board_discussions(root_id,lead_thread_id,suggested_lead_thread_id)
      VALUES(${input.rootId},${input.rootId === input.postId ? input.suggestedLeadThreadId : null},${input.suggestedLeadThreadId}) ON CONFLICT(root_id) DO NOTHING`;
    for (const threadId of new Set(input.recipients))
      yield* sql`INSERT INTO board_responsibilities(id,root_id,post_id,recipient_thread_id) VALUES(${`board-request:${input.postId}:${threadId}`},${input.rootId},${input.postId},${threadId}) ON CONFLICT DO NOTHING`;
    if (input.requireAssignment && input.recipients.length === 0)
      yield* sql`INSERT INTO board_responsibilities(id,root_id,post_id,recipient_thread_id,status) VALUES(${`board-request:${input.postId}:unassigned`},${input.rootId},${input.postId},NULL,'needs-attention') ON CONFLICT(id) DO NOTHING`;
    return yield* bump(input.rootId);
  });
  const validateBatch = Effect.fn("MessageBoardHandlingStore.validateBatch")(function* (input: {
    batchId: string;
    threadId: ThreadId;
  }) {
    const rows = yield* sql<{
      requests_json: string;
      root_id: string;
    }>`SELECT requests_json,root_id FROM board_dispatch_batches WHERE id=${input.batchId} AND recipient_thread_id=${input.threadId} AND status IN ('pending','admitted')`;
    if (!rows[0]) return false;
    const expected = yield* decodeRequestGenerations(rows[0].requests_json);
    const state = yield* snapshot(BoardPostId.make(rows[0].root_id));
    return (
      expected.length > 0 &&
      expected.every((item) =>
        state.responsibilities.some(
          (r) =>
            r.id === item.id &&
            r.generation === item.generation &&
            r.recipientThreadId === input.threadId &&
            r.batchId === input.batchId &&
            (r.status === "queued" || r.status === "running"),
        ),
      )
    );
  });
  const bindRun = Effect.fn("MessageBoardHandlingStore.bindRun")(function* (input: {
    batchId: string;
    threadId: ThreadId;
    runId: RunId;
  }) {
    if (!(yield* validateBatch(input))) return false;
    yield* sql`UPDATE board_responsibilities SET run_id=${input.runId} WHERE batch_id=${input.batchId} AND recipient_thread_id=${input.threadId}`;
    yield* sql`UPDATE board_dispatch_batches SET status='admitted' WHERE id=${input.batchId}`;
    return true;
  });
  const execute = Effect.fn("MessageBoardHandlingStore.execute")(function* (input: {
    batchId: string;
    threadId: ThreadId;
    runId?: RunId;
  }) {
    if (!(yield* validateBatch(input))) return null;
    if (input.runId !== undefined) yield* bindRun({ ...input, runId: input.runId });
    const rows = yield* sql<{
      root_id: string;
    }>`SELECT root_id FROM board_dispatch_batches WHERE id=${input.batchId}`;
    const state = yield* snapshot(BoardPostId.make(rows[0]!.root_id));
    const requests = state.responsibilities.filter((r) => r.batchId === input.batchId);
    const ids = new Set([
      state.rootId,
      ...state.context.decisionPostIds,
      ...requests.map((r) => r.postId),
    ]);
    const posts = yield* sql<{
      id: string;
      text: string;
      is_user: number;
      reply_to_id: string | null;
    }>`SELECT id,text,reply_to_id,json_extract(author_json, '$.kind') = 'user' AS is_user FROM board_posts WHERE root_id=${state.rootId} ORDER BY created_at,id`;
    for (const post of posts) {
      if (ids.has(BoardPostId.make(post.id)) && post.reply_to_id !== null)
        ids.add(BoardPostId.make(post.reply_to_id));
    }
    yield* sql`UPDATE board_dispatch_batches SET context_revision=(SELECT context_revision FROM board_discussions WHERE root_id=${state.rootId}) WHERE id=${input.batchId}`;
    yield* sql`UPDATE board_responsibilities SET status='running' WHERE batch_id=${input.batchId}`;
    const current = yield* bump(state.rootId);
    return {
      rootId: state.rootId,
      text: [
        `Board discussion ${state.rootId}, current revision ${current.revision}.`,
        "Write a natural conversational reply to the user in this discussion with board_append before reporting outcomes. Greetings, thanks, corrections and status questions still deserve a reply. Address every retained source message and material question; one post can cover the burst. Read authoritative source posts and pagination as needed. Selecting you grants response responsibility only, not lead, context-editing or closure authority. Do not start unrelated work or wake peers unless their contribution is requested or needed.",
        state.context.text,
        ...posts
          .filter((p) => p.is_user === 1 || ids.has(BoardPostId.make(p.id)))
          .map((p) => `${p.id}: ${p.text}`),
        `Report an explicit outcome for EACH request using board_report_outcome: ${requests.map((r) => `${r.id} (generation ${r.generation})`).join(", ")}. Seen and finishing a turn do not resolve requests.`,
      ].join("\n\n"),
    };
  });
  const executionContext = Effect.fn("MessageBoardHandlingStore.executionContext")(
    function* (input: { batchId: string; threadId: ThreadId; runId?: RunId }) {
      const result = yield* sql.withTransaction(execute(input));
      if (result === null) return null;
      yield* publish(result.rootId);
      return result.text;
    },
  );
  const settleRun = Effect.fn("MessageBoardHandlingStore.completeRun")(function* (input: {
    runId: RunId;
    threadId: ThreadId;
  }) {
    const roots = yield* sql<{
      root_id: string;
    }>`SELECT DISTINCT root_id FROM board_responsibilities WHERE run_id=${input.runId} AND recipient_thread_id=${input.threadId} AND status IN ('queued','running')`;
    yield* sql`UPDATE board_responsibilities SET status='needs-attention' WHERE run_id=${input.runId} AND recipient_thread_id=${input.threadId} AND status IN ('queued','running')`;
    for (const root of roots) {
      yield* bump(BoardPostId.make(root.root_id));
    }
    return roots.map((root) => BoardPostId.make(root.root_id));
  });
  const completeRun = Effect.fn("MessageBoardHandlingStore.completeRun")(function* (input: {
    runId: RunId;
    threadId: ThreadId;
  }) {
    const roots = yield* sql.withTransaction(settleRun(input));
    for (const rootId of roots) yield* publish(rootId);
  });
  const reportOutcome = Effect.fn("MessageBoardHandlingStore.reportOutcome")(function* (input: {
    rootId: BoardPostId;
    expectedRevision: number;
    responsibilityId: string;
    expectedGeneration: number;
    runId: RunId;
    outcome: BoardHandlingOutcome;
    viewer: BoardViewer;
  }) {
    const state = yield* snapshot(input.rootId);
    if (state.revision !== input.expectedRevision) return yield* conflict(state, "revision");
    const request = state.responsibilities.find((r) => r.id === input.responsibilityId);
    if (!request || request.generation !== input.expectedGeneration)
      return yield* conflict(state, "generation", input.responsibilityId);
    if (
      input.viewer.kind !== "thread" ||
      input.viewer.threadId !== request.recipientThreadId ||
      request.runId !== input.runId ||
      request.status !== "running"
    )
      return yield* conflict(state, "ownership", request.id);
    const context = yield* sql<{
      current_revision: number;
      inspected_revision: number | null;
    }>`SELECT d.context_revision AS current_revision,b.context_revision AS inspected_revision FROM board_discussions d LEFT JOIN board_dispatch_batches b ON b.id=${request.batchId ?? ""} WHERE d.root_id=${input.rootId}`;
    if (
      context[0]?.inspected_revision === null ||
      context[0]?.current_revision !== context[0]?.inspected_revision
    )
      return yield* conflict(state, "stale-context", request.id);
    if (request.selectionId !== undefined && input.outcome.kind !== "blocked") {
      const replies = yield* sql`SELECT 1 FROM board_posts WHERE root_id=${input.rootId}
        AND json_extract(author_json,'$.kind')='agent'
        AND json_extract(author_json,'$.threadId')=${request.recipientThreadId}
        AND run_id=${input.runId} LIMIT 1`;
      if (replies.length === 0)
        return yield* new MessageBoardError({
          code: "conflict",
          message:
            "Post your conversational reply in the discussion before completing this response.",
          conflict: {
            kind: "missing-response",
            rootId: state.rootId,
            revision: state.revision,
            responsibilityId: request.id,
          },
        });
    }
    for (const postId of input.outcome.sourcePostIds) {
      const sources =
        yield* sql`SELECT id FROM board_posts WHERE id=${postId} AND root_id=${input.rootId}`;
      if (!sources.length) return yield* conflict(state, "stale-context", request.id);
    }
    yield* sql`UPDATE board_responsibilities SET status=${input.outcome.kind === "blocked" ? "needs-attention" : "completed"},outcome_json=${yield* encodeOutcomeJson(input.outcome)} WHERE id=${request.id}`;
    return yield* bump(input.rootId);
  });
  const hold = Effect.fn("MessageBoardHandlingStore.holdBatch")(function* (input: {
    batchId: string;
    threadId: ThreadId;
  }) {
    const rows = yield* sql<{
      root_id: string;
    }>`SELECT root_id FROM board_dispatch_batches WHERE id=${input.batchId} AND recipient_thread_id=${input.threadId}`;
    yield* sql`UPDATE board_responsibilities SET status='held' WHERE batch_id=${input.batchId} AND recipient_thread_id=${input.threadId} AND status IN ('queued','running')`;
    yield* sql`UPDATE board_dispatch_batches SET status='held' WHERE id=${input.batchId}`;
    if (rows[0]) yield* bump(BoardPostId.make(rows[0].root_id));
    return rows[0] ? BoardPostId.make(rows[0].root_id) : null;
  });
  const holdBatch = Effect.fn("MessageBoardHandlingStore.holdBatch")(function* (input: {
    batchId: string;
    threadId: ThreadId;
  }) {
    const rootId = yield* sql.withTransaction(hold(input));
    if (rootId !== null) yield* publish(rootId);
  });
  const isScopedResume = Effect.fn("MessageBoardHandlingStore.isScopedResume")(function* (input: {
    batchId: string;
    threadId: ThreadId;
  }) {
    const rows = yield* sql<{
      scoped_resume: number;
    }>`SELECT scoped_resume FROM board_dispatch_batches WHERE id=${input.batchId} AND recipient_thread_id=${input.threadId}`;
    return rows[0]?.scoped_resume === 1;
  });
  const resumeStopReceipt = Effect.fn("MessageBoardHandlingStore.resumeStopReceipt")(
    function* (input: { batchId: string; threadId: ThreadId }) {
      const rows = yield* sql<{
        scoped_resume: number;
        scoped_stop_receipt: number;
      }>`SELECT scoped_resume,scoped_stop_receipt FROM board_dispatch_batches WHERE id=${input.batchId} AND recipient_thread_id=${input.threadId}`;
      return rows[0]?.scoped_resume === 1 ? rows[0].scoped_stop_receipt : null;
    },
  );
  return {
    resumeStopReceipt,
    publish,
    holdBatch,
    isScopedResume,
    snapshot,
    conflict,
    guard,
    bump,
    createForPost,
    validateBatch,
    bindRun,
    executionContext,
    completeRun,
    reportOutcome,
  };
});
export type Store = Effect.Success<typeof make>;
