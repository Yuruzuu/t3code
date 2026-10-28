import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import MessageBoard from "./Migrations/073_MessageBoard.ts";
import MessageBoardRoles from "./Migrations/074_MessageBoardRoles.ts";
import MessageBoardThreadReads from "./Migrations/075_MessageBoardThreadReads.ts";

it.effect("upgrades the boards branch without replaying its schema or losing posts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 69 });
    yield* Migrator.make({})({
      loader: Migrator.fromRecord({
        "70_MessageBoard": MessageBoard,
        "71_MessageBoardRoles": MessageBoardRoles,
        "72_MessageBoardThreadReads": MessageBoardThreadReads,
      }),
    });
    yield* sql`INSERT INTO board_channels (name, created_by_json, created_at) VALUES ('notes', '{"kind":"user"}', '2026-10-28')`;
    yield* sql`INSERT INTO board_posts (id, channel_name, root_id, author_json, text, created_at) VALUES ('saved', 'notes', 'saved', '{"kind":"user"}', 'Keep this finding', '2026-10-28')`;
    yield* runMigrations();
    assert.deepStrictEqual(yield* sql`SELECT text FROM board_posts WHERE id = 'saved'`, [
      { text: "Keep this finding" },
    ]);
    const history = yield* sql<{
      migration_id: number;
      name: string;
    }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
    assert.deepStrictEqual(
      history.map((row) => [row.migration_id, row.name]),
      migrationManifest,
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
    yield* sql`INSERT INTO peer_environment_links (environment_id, secret_name, label, urls_json, access, linked_at, expires_at, fenced) VALUES ('peer', 'secret', 'Peer', '[]', 'read', '2026-10-28', '2026-10-29', 1)`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
