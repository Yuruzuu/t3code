import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { runMessageBoardMigrations } from "./MessageBoardMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import MessageBoard from "./MessageBoardMigrations/001_MessageBoard.ts";
import MessageBoardRoles from "./MessageBoardMigrations/002_MessageBoardRoles.ts";
import MessageBoardThreadReads from "./MessageBoardMigrations/003_MessageBoardThreadReads.ts";
import MessageBoardSubscriptionOptOut from "./MessageBoardMigrations/004_MessageBoardSubscriptionOptOut.ts";
import MessageBoardRepliesReactions from "./MessageBoardMigrations/005_MessageBoardRepliesReactions.ts";
import MessageBoardPostWorkedMs from "./MessageBoardMigrations/006_MessageBoardPostWorkedMs.ts";
import MessageBoardPostRunId from "./MessageBoardMigrations/007_MessageBoardPostRunId.ts";
import MessageBoardTodos from "./MessageBoardMigrations/008_MessageBoardTodos.ts";

const seedLegacyBoards = Effect.fn("test.seedLegacyBoards")(function* () {
  yield* runMigrations({ toMigrationInclusive: 69 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord({
      "70_MessageBoard": MessageBoard,
      "71_MessageBoardRoles": MessageBoardRoles,
      "72_MessageBoardThreadReads": MessageBoardThreadReads,
    }),
  });
});

it.effect.each([70, 73])(
  "upgrades the boards branch starting at migration %s and clears only the old boards",
  (firstId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (firstId === 70) {
        yield* seedLegacyBoards();
      } else {
        yield* runMigrations({ toMigrationInclusive: 72 });
        yield* runMessageBoardMigrations(12);
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name, created_at)
          SELECT migration_id + 72, name, created_at FROM effect_sql_message_board_migrations
        `;
        yield* sql`DROP TABLE effect_sql_message_board_migrations`;
      }
      yield* sql`INSERT INTO board_channels (name, created_by_json, created_at) VALUES ('notes', '{"kind":"user"}', '2026-10-28')`;
      yield* sql`INSERT INTO board_posts (id, channel_name, root_id, author_json, text, created_at) VALUES ('saved', 'notes', 'saved', '{"kind":"user"}', 'Keep this finding', '2026-10-28')`;
      for (const [id, type] of [
        ["board", "board-dispatch"],
        ["ordinary", "thread-title.generate"],
      ] as const) {
        yield* sql`INSERT INTO orchestration_v2_effect_outbox (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at)
          VALUES (${id}, 'command', 'thread', ${type}, '{}', 'pending', '2026-10-28', '2026-10-28', '2026-10-28')`;
      }
      yield* runMigrations();
      assert.deepStrictEqual(yield* sql`SELECT text FROM board_posts`, []);
      assert.deepStrictEqual(yield* sql`SELECT name FROM board_channels`, []);
      assert.deepStrictEqual(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, [
        { effect_id: "ordinary" },
      ]);
      const history = yield* sql<{
        migration_id: number;
        name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
      assert.lengthOf(yield* sql`SELECT migration_id FROM effect_sql_message_board_migrations`, 13);
      assert.deepStrictEqual(yield* runMigrations(), []);
      yield* sql`INSERT INTO peer_environment_links (environment_id, secret_name, label, urls_json, access, linked_at, expires_at, fenced) VALUES ('peer', 'secret', 'Peer', '[]', 'read', '2026-10-28', '2026-10-29', 1)`;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("resets historical todos through migration 77", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedLegacyBoards();
    yield* Migrator.make({})({
      loader: Migrator.fromRecord({
        "73_MessageBoardSubscriptionOptOut": MessageBoardSubscriptionOptOut,
        "74_MessageBoardRepliesReactions": MessageBoardRepliesReactions,
        "75_MessageBoardPostWorkedMs": MessageBoardPostWorkedMs,
        "76_MessageBoardPostRunId": MessageBoardPostRunId,
        "77_MessageBoardTodos": MessageBoardTodos,
      }),
    });
    yield* sql`INSERT INTO board_channels (name, created_by_json, created_at) VALUES ('notes', '{"kind":"user"}', '2026-10-28')`;
    yield* sql`INSERT INTO board_posts (id, channel_name, root_id, author_json, text, created_at) VALUES ('saved', 'notes', 'saved', '{"kind":"user"}', 'Keep this finding', '2026-10-28')`;
    yield* sql`INSERT INTO board_todos (id, root_id, text, status, created_at, updated_at) VALUES ('task', 'saved', 'Keep this todo', 'in-progress', '2026-10-28', '2026-10-28')`;
    yield* runMigrations();
    assert.deepStrictEqual(yield* sql`SELECT text, status FROM board_todos`, []);
    const history = yield* sql<{
      migration_id: number;
      name: string;
    }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
    assert.deepStrictEqual(
      history.map((row) => [row.migration_id, row.name] as const),
      migrationManifest,
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("rejects unknown fork history without changing migration records", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedLegacyBoards();
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (73, 'UnknownFork')`;
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      before,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("backfills discussion suggestions without historical responsibilities or dispatch", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 99 });
    yield* runMessageBoardMigrations(9);
    yield* sql`INSERT INTO board_channels(name,created_by_json,created_at) VALUES('old','{"kind":"user"}','2026-10-28')`;
    yield* sql`INSERT INTO board_posts(id,root_id,channel_name,author_json,text,created_at) VALUES('old','old','old','{"kind":"agent","threadId":"original"}','Historical request','2026-10-28')`;
    yield* runMessageBoardMigrations(10);
    assert.deepEqual(
      yield* sql`SELECT lead_thread_id,suggested_lead_thread_id,lifecycle,revision FROM board_discussions`,
      [
        {
          lead_thread_id: null,
          suggested_lead_thread_id: "original",
          lifecycle: "open",
          revision: 0,
        },
      ],
    );
    assert.lengthOf(yield* sql`SELECT * FROM board_responsibilities`, 0);
    assert.lengthOf(yield* sql`SELECT * FROM board_dispatch_batches`, 0);
    assert.lengthOf(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "preserves existing todo identity, scope, ownership and collection revision when adding item versions",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 99 });
      yield* runMessageBoardMigrations(10);
      yield* sql`INSERT INTO board_channels(name,created_by_json,created_at) VALUES('tasks','{"kind":"user"}','2026-10-28')`;
      yield* sql`INSERT INTO board_posts(id,root_id,channel_name,author_json,text,created_at) VALUES('tasks','tasks','tasks','{"kind":"user"}','Scope','2026-10-28')`;
      const owner =
        '{"kind":"agent","threadId":"worker","projectId":null,"title":"Worker","driver":null}';
      for (const status of ["todo", "in-progress", "done"])
        yield* sql`INSERT INTO board_todos(id,root_id,text,status,assignee_json,created_at,updated_at) VALUES(${status},'tasks',${`Original ${status}`},${status},${owner},'2026-10-28','2026-10-29')`;
      yield* sql`INSERT INTO board_todo_revisions(root_id,revision) VALUES('tasks',19)`;
      const before =
        yield* sql`SELECT id,root_id,text,status,assignee_json,created_at,updated_at FROM board_todos ORDER BY id`;
      yield* runMessageBoardMigrations(11);
      assert.deepEqual(
        yield* sql`SELECT id,root_id,text,status,assignee_json,created_at,updated_at FROM board_todos ORDER BY id`,
        before,
      );
      assert.deepEqual(yield* sql`SELECT version,metadata_json FROM board_todos`, [
        { version: 1, metadata_json: "{}" },
        { version: 1, metadata_json: "{}" },
        { version: 1, metadata_json: "{}" },
      ]);
      assert.deepEqual(
        yield* sql`SELECT revision FROM board_todo_revisions WHERE root_id='tasks'`,
        [{ revision: 19 }],
      );
      assert.lengthOf(yield* sql`SELECT * FROM board_todo_actions`, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("adds durable automatic selection without rerouting historical explicit requests", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 99 });
    yield* runMessageBoardMigrations(11);
    yield* sql`INSERT INTO board_channels(name,created_by_json,created_at) VALUES('existing','{"kind":"user"}','2026-10-30')`;
    yield* sql`INSERT INTO board_posts(id,root_id,channel_name,author_json,text,created_at) VALUES('existing','existing','existing','{"kind":"user"}','Existing explicit request','2026-10-30')`;
    yield* sql`INSERT INTO board_discussions(root_id,lead_thread_id,revision) VALUES('existing','chosen-lead',5)`;
    yield* sql`INSERT INTO board_responsibilities(id,root_id,post_id,recipient_thread_id,generation,status) VALUES('explicit','existing','existing','chosen-recipient',3,'held')`;
    const before =
      yield* sql`SELECT id,root_id,post_id,recipient_thread_id,generation,status FROM board_responsibilities`;
    yield* runMessageBoardMigrations(12);
    assert.deepEqual(
      yield* sql`SELECT id,root_id,post_id,recipient_thread_id,generation,status FROM board_responsibilities`,
      before,
    );
    assert.deepEqual(
      yield* sql`SELECT selection_id,selection_generation,availability_reason FROM board_responsibilities`,
      [{ selection_id: null, selection_generation: null, availability_reason: null }],
    );
    assert.deepEqual(yield* sql`SELECT lead_thread_id,revision FROM board_discussions`, [
      { lead_thread_id: "chosen-lead", revision: 5 },
    ]);
    assert.lengthOf(yield* sql`SELECT * FROM board_responder_selections`, 0);
    assert.lengthOf(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`, 0);
    assert.deepEqual(yield* runMessageBoardMigrations(12), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
