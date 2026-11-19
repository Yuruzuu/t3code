import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import MessageBoard from "./MessageBoardMigrations/001_MessageBoard.ts";
import MessageBoardRoles from "./MessageBoardMigrations/002_MessageBoardRoles.ts";
import MessageBoardThreadReads from "./MessageBoardMigrations/003_MessageBoardThreadReads.ts";
import MessageBoardSubscriptionOptOut from "./MessageBoardMigrations/004_MessageBoardSubscriptionOptOut.ts";
import MessageBoardRepliesReactions from "./MessageBoardMigrations/005_MessageBoardRepliesReactions.ts";
import MessageBoardPostWorkedMs from "./MessageBoardMigrations/006_MessageBoardPostWorkedMs.ts";
import MessageBoardPostRunId from "./MessageBoardMigrations/007_MessageBoardPostRunId.ts";
import MessageBoardTodos from "./MessageBoardMigrations/008_MessageBoardTodos.ts";
import MessageBoardDeliveryAndRequests from "./MessageBoardMigrations/009_MessageBoardDeliveryAndRequests.ts";
import MessageBoardHandling from "./MessageBoardMigrations/010_MessageBoardHandling.ts";
import MessageBoardTodoActions from "./MessageBoardMigrations/011_MessageBoardTodoActions.ts";
import MessageBoardResponderSelection from "./MessageBoardMigrations/012_MessageBoardResponderSelection.ts";

import MessageBoardAgentTrees from "./MessageBoardMigrations/013_MessageBoardAgentTrees.ts";

const migrations = {
  "1_MessageBoard": MessageBoard,
  "2_MessageBoardRoles": MessageBoardRoles,
  "3_MessageBoardThreadReads": MessageBoardThreadReads,
  "4_MessageBoardSubscriptionOptOut": MessageBoardSubscriptionOptOut,
  "5_MessageBoardRepliesReactions": MessageBoardRepliesReactions,
  "6_MessageBoardPostWorkedMs": MessageBoardPostWorkedMs,
  "7_MessageBoardPostRunId": MessageBoardPostRunId,
  "8_MessageBoardTodos": MessageBoardTodos,
  "9_MessageBoardDeliveryAndRequests": MessageBoardDeliveryAndRequests,
  "10_MessageBoardHandling": MessageBoardHandling,
  "11_MessageBoardTodoActions": MessageBoardTodoActions,
  "12_MessageBoardResponderSelection": MessageBoardResponderSelection,
  "13_MessageBoardAgentTrees": MessageBoardAgentTrees,
};
const names = Object.keys(migrations).map((key) => key.slice(key.indexOf("_") + 1));
const table = "effect_sql_message_board_migrations";
const run = Migrator.make({});
export const runMessageBoardMigrations = (throughId = names.length) =>
  run({
    table,
    loader: Migrator.fromRecord(Object.fromEntries(Object.entries(migrations).slice(0, throughId))),
  });

export const hasPendingMessageBoardMigrations = Effect.fn("hasPendingMessageBoardMigrations")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables =
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
    if (tables.length === 0) return true;
    const [latest] = yield* sql<{ readonly id: number | null }>`
      SELECT MAX(migration_id) AS id FROM ${sql(table)}
    `;
    return (latest?.id ?? 0) < names.length;
  },
);

export const reconcileMessageBoardMigration = Effect.fn("reconcileMessageBoardMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    if (tables.length === 0) return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [first] = yield* sql<{ readonly id: number }>`
          SELECT migration_id AS id FROM effect_sql_migrations
          WHERE migration_id IN (70, 73) AND name = 'MessageBoard'
          ORDER BY migration_id LIMIT 1
        `;
        if (first === undefined) return;
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
          readonly created_at: string;
        }>`
          SELECT migration_id, name, created_at FROM effect_sql_migrations
          WHERE migration_id >= ${first.id} ORDER BY migration_id
        `;
        if (
          !history.every(
            (row, index) => row.migration_id === first.id + index && row.name === names[index],
          )
        ) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message:
              "Cannot upgrade message board migration history with unexpected later migrations.",
          });
        }
        // The old fork used core migration IDs. Move only its ledger rows before applying core migrations.
        yield* runMessageBoardMigrations(0);
        for (const [index, row] of history.entries()) {
          yield* sql`
            INSERT INTO ${sql(table)} (migration_id, name, created_at)
            VALUES (${index + 1}, ${row.name}, ${row.created_at})
          `;
        }
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${first.id}`;
      }),
    );
  },
);
