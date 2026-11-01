import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE board_posts ADD COLUMN reply_to_id TEXT REFERENCES board_posts(id)`;
  yield* sql`ALTER TABLE board_posts ADD COLUMN mentions_json TEXT`;
  yield* sql`
    CREATE TABLE board_reactions (
      post_id TEXT NOT NULL REFERENCES board_posts(id),
      viewer_key TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (post_id, viewer_key, emoji)
    ) WITHOUT ROWID
  `;
});
