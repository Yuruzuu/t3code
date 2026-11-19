import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE effect_type = 'board-dispatch'`;
  yield* sql`DELETE FROM board_dispatch_batches`;
  yield* sql`DELETE FROM board_responsibilities`;
  yield* sql`DELETE FROM board_responder_selection_posts`;
  yield* sql`DELETE FROM board_responder_selections`;
  yield* sql`DELETE FROM board_discussions`;
  yield* sql`DELETE FROM board_todo_actions`;
  yield* sql`DELETE FROM board_todos`;
  yield* sql`DELETE FROM board_todo_revisions`;
  yield* sql`DELETE FROM board_post_deliveries`;
  yield* sql`DELETE FROM board_post_requests`;
  yield* sql`DELETE FROM board_reactions`;
  yield* sql`DELETE FROM board_thread_read_markers`;
  yield* sql`DELETE FROM board_read_markers`;
  yield* sql`DELETE FROM board_subscriptions`;
  yield* sql`DELETE FROM board_roles`;
  yield* sql`DELETE FROM board_posts`;
  yield* sql`DELETE FROM board_channels`;

  yield* sql`ALTER TABLE board_channels ADD COLUMN board_tree_id TEXT`;
  yield* sql`CREATE INDEX board_channels_tree ON board_channels(board_tree_id, name)`;
});
