import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE board_channels (
      name TEXT PRIMARY KEY NOT NULL,
      description TEXT,
      created_by_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE board_posts (
      id TEXT PRIMARY KEY NOT NULL,
      channel_name TEXT NOT NULL REFERENCES board_channels(name),
      root_id TEXT NOT NULL REFERENCES board_posts(id),
      author_json TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX board_posts_channel_created ON board_posts(channel_name, created_at)`;
  yield* sql`CREATE INDEX board_posts_root_created ON board_posts(root_id, created_at)`;
  yield* sql`
    CREATE TABLE board_read_markers (
      viewer_key TEXT NOT NULL,
      channel_name TEXT NOT NULL REFERENCES board_channels(name),
      read_at TEXT NOT NULL,
      PRIMARY KEY (viewer_key, channel_name)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE board_subscriptions (
      viewer_key TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('channel', 'thread')),
      target TEXT NOT NULL,
      PRIMARY KEY (viewer_key, target_kind, target)
    ) WITHOUT ROWID
  `;
});
