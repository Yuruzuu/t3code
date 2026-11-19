import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE board_roles (
      thread_id TEXT PRIMARY KEY NOT NULL,
      role TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});
