import { BoardPostId, ThreadId, BoardResponderSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export type Selection = BoardResponderSelection;
const decodeSelection = Schema.decodeUnknownEffect(BoardResponderSelection);
const decodeSourcePosts = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(BoardPostId)));

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const list = Effect.fn("MessageBoardSelectionStore.list")(function* (rootId?: BoardPostId) {
    const rows = yield* sql<{
      id: string;
      root_id: string;
      generation: number;
      status: string;
      context_fingerprint: string;
      roster_fingerprint: string;
      recipient_thread_id: string | null;
      origin_thread_id: string | null;
      method: string | null;
      fallback_reason: string | null;
      deadline_at: string;
      attempt_count: number;
      call_started_at: string | null;
      started_at: string | null;
      source_posts_json: string;
    }>`SELECT s.*,(SELECT json_group_array(post_id) FROM
      (SELECT post_id FROM board_responder_selection_posts p WHERE p.selection_id=s.id ORDER BY p.rowid)) AS source_posts_json
      FROM board_responder_selections s WHERE ${rootId === undefined ? sql`1` : sql`s.root_id=${rootId}`} ORDER BY s.rowid`;
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        return yield* decodeSelection({
          id: row.id,
          rootId: row.root_id,
          generation: row.generation,
          status: row.status,
          contextFingerprint: row.context_fingerprint,
          rosterFingerprint: row.roster_fingerprint,
          recipientThreadId: row.recipient_thread_id,
          originThreadId: row.origin_thread_id,
          method: row.method,
          fallbackReason: row.fallback_reason,
          deadlineAt: row.deadline_at,
          attemptCount: row.attempt_count,
          callStartedAt: row.call_started_at,
          startedAt: row.started_at,
          sourcePostIds: yield* decodeSourcePosts(row.source_posts_json),
        });
      }),
    );
  });
  const createIntent = Effect.fn("MessageBoardSelectionStore.createIntent")(function* (input: {
    rootId: BoardPostId;
    postId: BoardPostId;
    now: string;
    deadlineAt?: string;
    originThreadId?: ThreadId | null;
  }) {
    yield* sql`INSERT INTO board_discussions(root_id) VALUES(${input.rootId}) ON CONFLICT DO NOTHING`;
    const existing = yield* sql<{
      selection_id: string;
    }>`SELECT selection_id FROM board_responder_selection_posts WHERE post_id=${input.postId}`;
    if (existing[0] !== undefined) return existing[0].selection_id;
    const pending = yield* sql<{
      id: string;
    }>`SELECT s.id FROM board_responder_selections s WHERE s.root_id=${input.rootId} AND s.status='selecting' AND s.attempt_count=0 AND (SELECT COUNT(*) FROM board_responder_selection_posts p WHERE p.selection_id=s.id)<16 ORDER BY s.rowid LIMIT 1`;
    const id = pending[0]?.id ?? `board-selection:${input.postId}`;
    const origins = yield* sql<{
      thread_id: string | null;
    }>`SELECT CASE WHEN json_extract(author_json,'$.kind')='agent' THEN json_extract(author_json,'$.threadId') ELSE NULL END AS thread_id FROM board_posts WHERE id=${input.rootId}`;
    const originThreadId = input.originThreadId ?? origins[0]?.thread_id ?? null;
    const deadline =
      input.deadlineAt ??
      DateTime.formatIso(DateTime.addDuration(DateTime.makeUnsafe(input.now), "15 seconds"));
    yield* sql`INSERT INTO board_responder_selections(id,root_id,origin_thread_id,deadline_at,created_at,updated_at)
      VALUES(${id},${input.rootId},${originThreadId},${deadline},${input.now},${input.now}) ON CONFLICT DO NOTHING`;
    yield* sql`INSERT INTO board_responder_selection_posts(selection_id,post_id) VALUES(${id},${input.postId}) ON CONFLICT DO NOTHING`;
    return id;
  }, sql.withTransaction);
  const claim = Effect.fn("MessageBoardSelectionStore.claim")(function* (id: string, now: string) {
    const rows =
      yield* sql`UPDATE board_responder_selections SET attempt_count=attempt_count+1,updated_at=${now}
      WHERE id=${id} AND status='selecting' AND attempt_count=0 RETURNING id`;
    return rows.length === 1;
  });
  const recordCallStarted = Effect.fn("MessageBoardSelectionStore.recordCallStarted")(
    function* (input: {
      id: string;
      generation: number;
      contextFingerprint: string;
      rosterFingerprint: string;
      now: string;
    }) {
      const rows =
        yield* sql`UPDATE board_responder_selections SET call_started_at=${input.now},context_fingerprint=${input.contextFingerprint},roster_fingerprint=${input.rosterFingerprint},updated_at=${input.now}
      WHERE id=${input.id} AND generation=${input.generation} AND status='selecting' AND call_started_at IS NULL RETURNING id`;
      return rows.length === 1;
    },
  );
  const markStarted = Effect.fn("MessageBoardSelectionStore.markStarted")(function* (input: {
    batchId: string;
    threadId: ThreadId;
    now?: string;
  }) {
    const invalid =
      yield* sql`SELECT 1 FROM board_responsibilities r LEFT JOIN board_responder_selections s ON s.id=r.selection_id
      WHERE r.batch_id=${input.batchId} AND r.recipient_thread_id=${input.threadId} AND r.selection_id IS NOT NULL
      AND (s.status != 'selected' OR s.generation != r.selection_generation OR s.recipient_thread_id != r.recipient_thread_id OR s.started_at IS NOT NULL) LIMIT 1`;
    if (invalid.length > 0) return false;
    const now = input.now ?? DateTime.formatIso(yield* DateTime.now);
    yield* sql`UPDATE board_responder_selections SET started_at=${now}
      WHERE id IN (SELECT selection_id FROM board_responsibilities WHERE batch_id=${input.batchId} AND recipient_thread_id=${input.threadId})`;
    return true;
  }, sql.withTransaction);
  return { list, createIntent, claim, recordCallStarted, markStarted };
});
