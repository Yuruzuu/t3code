import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE board_todo_revisions (root_id TEXT PRIMARY KEY REFERENCES board_posts(id), revision INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE board_todos (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL REFERENCES board_posts(id),
    text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('todo', 'in-progress', 'done')),
    assignee_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX board_todos_root ON board_todos(root_id, created_at, id)`;
});
