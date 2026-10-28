import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import PeerLinks from "./Migrations/070_PeerLinks.ts";
import PeerLinkFence from "./Migrations/071_PeerLinkFence.ts";
import WaitingLinkRequestIndex from "./Migrations/072_WaitingLinkRequestIndex.ts";

const legacyNames = [
  "MessageBoard",
  "MessageBoardRoles",
  "MessageBoardThreadReads",
  "MessageBoardSubscriptionOptOut",
  "MessageBoardRepliesReactions",
  "MessageBoardPostWorkedMs",
  "MessageBoardPostRunId",
  "MessageBoardTodos",
];

export const reconcileMessageBoardMigration = Effect.fn("reconcileMessageBoardMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables =
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
        if (tables.length === 0) return [];
        const history = yield* sql<{
          migration_id: number;
          name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 70 ORDER BY migration_id`;
        if (history[0]?.migration_id !== 70 || history[0].name !== "MessageBoard") return [];
        if (
          !history.every(
            (row, index) => row.migration_id === 70 + index && row.name === legacyNames[index],
          )
        ) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message:
              "Cannot upgrade message board migration history with unexpected later migrations.",
          });
        }
        // Boards occupied nightly's peer-link ids; move history without replaying their schema.
        for (const row of history.toReversed()) {
          yield* sql`UPDATE effect_sql_migrations SET migration_id = ${row.migration_id + 3} WHERE migration_id = ${row.migration_id}`;
        }
        yield* PeerLinks;
        yield* PeerLinkFence;
        yield* WaitingLinkRequestIndex;
        const executed = [
          [70, "PeerLinks"],
          [71, "PeerLinkFence"],
          [72, "WaitingLinkRequestIndex"],
        ] as const;
        for (const [id, name] of executed) {
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
        }
        return executed;
      }),
    );
  },
);
