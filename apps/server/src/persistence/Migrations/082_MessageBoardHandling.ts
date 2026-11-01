import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE board_discussions (
    root_id TEXT PRIMARY KEY REFERENCES board_posts(id),
    revision INTEGER NOT NULL DEFAULT 0,
    lead_thread_id TEXT,
    suggested_lead_thread_id TEXT,
    lifecycle TEXT NOT NULL DEFAULT 'open',
    context_revision INTEGER NOT NULL DEFAULT 0,
    context_json TEXT NOT NULL DEFAULT '{"text":"","decisionPostIds":[]}'
  )`;
  yield* sql`INSERT INTO board_discussions (root_id, suggested_lead_thread_id)
    SELECT id, CASE WHEN json_extract(author_json, '$.kind') = 'agent'
      THEN json_extract(author_json, '$.threadId') ELSE NULL END
    FROM board_posts WHERE id = root_id`;
  yield* sql`CREATE TABLE board_responsibilities (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL REFERENCES board_discussions(root_id),
    post_id TEXT NOT NULL REFERENCES board_posts(id),
    recipient_thread_id TEXT,
    generation INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    outcome_json TEXT,
    batch_id TEXT,
    run_id TEXT,
    UNIQUE(post_id, recipient_thread_id)
  )`;
  yield* sql`CREATE INDEX board_responsibilities_pending ON board_responsibilities(root_id, recipient_thread_id, status)`;
  yield* sql`CREATE TABLE board_dispatch_batches (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL REFERENCES board_discussions(root_id),
    recipient_thread_id TEXT NOT NULL,
    requests_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    scoped_resume INTEGER NOT NULL DEFAULT 0,
    scoped_stop_receipt INTEGER NOT NULL DEFAULT 0,
    context_revision INTEGER
  )`;
});
