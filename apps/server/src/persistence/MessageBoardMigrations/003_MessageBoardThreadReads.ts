import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE board_thread_read_markers (
      viewer_key TEXT NOT NULL,
      root_id TEXT NOT NULL REFERENCES board_posts(id),
      read_at TEXT NOT NULL,
      PRIMARY KEY (viewer_key, root_id)
    ) WITHOUT ROWID
  `;
});
