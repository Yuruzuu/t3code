import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import { BoardPostId, CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as MessageBoardHandlingStore from "./MessageBoardHandlingStore.ts";
import * as MessageBoardResponderSelection from "./MessageBoardResponderSelection.ts";

const encodeRequestGenerations = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ id: Schema.String, generation: Schema.Number })),
  ),
);
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const handling = yield* MessageBoardHandlingStore.make;
  const selection = yield* MessageBoardResponderSelection.makeExecutionGuard;
  const dispatchPending = Effect.fn("MessageBoardDispatchService.dispatchPending")(function* (
    input: { rootId?: string | undefined; recipientThreadId?: ThreadId | undefined } = {},
  ) {
    const groups = yield* sql<{
      root_id: string;
      recipient_thread_id: string;
    }>`SELECT DISTINCT root_id,recipient_thread_id FROM board_responsibilities WHERE status IN ('pending','queued') AND ${input.rootId === undefined ? sql`1` : sql`root_id=${input.rootId}`} AND ${input.recipientThreadId === undefined ? sql`1` : sql`recipient_thread_id=${input.recipientThreadId}`}`;
    for (const group of groups) {
      const rootId = BoardPostId.make(group.root_id);
      const threadId = ThreadId.make(group.recipient_thread_id);
      const batchId = yield* sql.withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql<{
            id: string;
          }>`SELECT id FROM board_dispatch_batches WHERE root_id=${rootId} AND recipient_thread_id=${threadId} AND status='pending' ORDER BY rowid LIMIT 1`;
          if (existing[0]) return existing[0].id;
          const pending = yield* sql<{
            id: string;
            generation: number;
          }>`SELECT id,generation FROM board_responsibilities WHERE root_id=${rootId} AND recipient_thread_id=${threadId} AND status='pending' ORDER BY rowid`;
          if (!pending.length) return null;
          const identity = yield* encodeRequestGenerations(pending);
          const id = `board-batch:${Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(`${rootId}:${threadId}:${identity}`)))}`;
          yield* sql`INSERT INTO board_dispatch_batches(id,root_id,recipient_thread_id,requests_json) VALUES(${id},${rootId},${threadId},${yield* encodeRequestGenerations(pending)})`;
          for (const request of pending)
            yield* sql`UPDATE board_responsibilities SET status='queued',batch_id=${id} WHERE id=${request.id} AND generation=${request.generation}`;
          yield* handling.bump(rootId);
          return id;
        }),
      );
      if (batchId === null) continue;
      if (!(yield* selection.reselectBeforeStart({ batchId, threadId }))) continue;
      const thread = yield* threads.getThreadShell(threadId);
      if (thread === null) {
        yield* handling.holdBatch({ batchId, threadId });
        continue;
      }
      yield* threads
        .sendToThread({
          commandId: CommandId.make(batchId),
          messageId: MessageId.make(batchId),
          threadId,
          projectId: thread.projectId,
          boardBatchId: batchId,
          text: `Handle the pending requests in board discussion ${rootId}. Read its current handling state and report an explicit outcome for every assigned request.`,
          attachments: [],
          mode: "queue",
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const rows = yield* sql<{
                status: string;
              }>`SELECT status FROM board_dispatch_batches WHERE id=${batchId}`;
              if (rows[0]?.status !== "held") return yield* error;
            }),
          ),
        );
      yield* sql`UPDATE board_dispatch_batches SET status='admitted' WHERE id=${batchId} AND status='pending'`;
    }
  });
  return { dispatchPending };
});
