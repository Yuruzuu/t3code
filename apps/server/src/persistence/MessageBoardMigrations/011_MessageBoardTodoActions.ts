import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE board_todos_next (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL REFERENCES board_posts(id),
    text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('todo','in-progress','blocked','done','cancelled')),
    assignee_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
    metadata_json TEXT NOT NULL DEFAULT '{}'
  )`;
  yield* sql`INSERT INTO board_todos_next(id,root_id,text,status,assignee_json,created_at,updated_at)
    SELECT id,root_id,text,status,assignee_json,created_at,updated_at FROM board_todos`;
  yield* sql`DROP TABLE board_todos`;
  yield* sql`ALTER TABLE board_todos_next RENAME TO board_todos`;
  yield* sql`CREATE INDEX board_todos_root ON board_todos(root_id,created_at,id)`;
  yield* sql`CREATE TABLE board_todo_actions (
    actor_key TEXT NOT NULL,
    request_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    root_id TEXT NOT NULL REFERENCES board_posts(id),
    todo_id TEXT NOT NULL,
    actor_json TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL,
    version INTEGER NOT NULL,
    changed INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY(actor_key,request_key)
  )`;
  yield* sql`CREATE INDEX board_todo_actions_item ON board_todo_actions(root_id,todo_id)`;
});
