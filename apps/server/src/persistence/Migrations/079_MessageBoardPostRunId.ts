import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE board_posts ADD COLUMN run_id TEXT`;
  // Earlier agent posts: the author's latest run that had started by the time it posted.
  yield* sql`
    UPDATE board_posts AS p SET run_id = (
      SELECT r.run_id FROM orchestration_v2_projection_runs AS r
      WHERE r.thread_id = json_extract(p.author_json, '$.threadId')
        AND json_extract(r.payload_json, '$.startedAt') <= p.created_at
      ORDER BY json_extract(r.payload_json, '$.startedAt') DESC
      LIMIT 1
    )
    WHERE json_extract(p.author_json, '$.kind') = 'agent'
  `;
});
