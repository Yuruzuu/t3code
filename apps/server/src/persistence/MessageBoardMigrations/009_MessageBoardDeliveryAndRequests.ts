import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE board_post_deliveries (
    viewer_key TEXT NOT NULL,
    post_id TEXT NOT NULL REFERENCES board_posts(id),
    ranges_json TEXT NOT NULL,
    complete INTEGER NOT NULL,
    PRIMARY KEY (viewer_key, post_id)
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE board_post_requests (
    author_key TEXT NOT NULL,
    request_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    post_id TEXT NOT NULL REFERENCES board_posts(id),
    PRIMARY KEY (author_key, request_key)
  ) WITHOUT ROWID`;
});
