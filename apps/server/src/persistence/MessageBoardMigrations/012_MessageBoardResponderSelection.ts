import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE board_responder_selections (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL REFERENCES board_discussions(root_id),
    generation INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'selecting' CHECK(status IN ('selecting','selected','unavailable')),
    context_fingerprint TEXT NOT NULL DEFAULT '',
    roster_fingerprint TEXT NOT NULL DEFAULT '',
    recipient_thread_id TEXT,
    origin_thread_id TEXT,
    method TEXT CHECK(method IS NULL OR method IN ('single','decisions','fallback')),
    fallback_reason TEXT,
    deadline_at TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    call_started_at TEXT,
    started_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE board_responder_selection_posts (
    selection_id TEXT NOT NULL REFERENCES board_responder_selections(id),
    post_id TEXT NOT NULL UNIQUE REFERENCES board_posts(id),
    PRIMARY KEY(selection_id,post_id)
  )`;
  yield* sql`CREATE TRIGGER board_selection_source_scope BEFORE INSERT ON board_responder_selection_posts
    WHEN NOT EXISTS (SELECT 1 FROM board_posts p JOIN board_responder_selections s ON s.root_id=p.root_id
      WHERE s.id=NEW.selection_id AND p.id=NEW.post_id AND json_extract(p.author_json,'$.kind')='user')
    BEGIN SELECT RAISE(ABORT,'Selection source must be a user post in the same discussion'); END`;
  yield* sql`CREATE INDEX board_responder_selections_pending ON board_responder_selections(status,root_id,deadline_at)`;
  yield* sql`ALTER TABLE board_responsibilities ADD COLUMN selection_id TEXT REFERENCES board_responder_selections(id)`;
  yield* sql`ALTER TABLE board_responsibilities ADD COLUMN selection_generation INTEGER`;
  yield* sql`ALTER TABLE board_responsibilities ADD COLUMN availability_reason TEXT`;
  yield* sql`CREATE INDEX board_responsibilities_selection ON board_responsibilities(selection_id,selection_generation)`;
});
