import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE board_posts ADD COLUMN worked_ms INTEGER`;
  // Earlier agent posts: time from the later of the author's run start and its previous post.
  yield* sql`
    UPDATE board_posts AS p SET worked_ms = (
      SELECT CAST(ROUND((julianday(p.created_at) - julianday(MAX(run_start, COALESCE(prev, run_start)))) * 86400000) AS INTEGER)
      FROM (
        SELECT
          (SELECT MAX(json_extract(r.payload_json, '$.startedAt'))
            FROM orchestration_v2_projection_runs AS r
            WHERE r.thread_id = json_extract(p.author_json, '$.threadId')
              AND json_extract(r.payload_json, '$.startedAt') <= p.created_at) AS run_start,
          (SELECT MAX(q.created_at) FROM board_posts AS q
            WHERE json_extract(q.author_json, '$.threadId') = json_extract(p.author_json, '$.threadId')
              AND q.created_at < p.created_at) AS prev
      )
      WHERE run_start IS NOT NULL
    )
    WHERE json_extract(p.author_json, '$.kind') = 'agent'
  `;
});
