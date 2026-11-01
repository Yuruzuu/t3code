import {
  type OrchestrationV2ThreadProjection,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

export const withBoardHandlingLock = Effect.fn("BoardHandlingGuard.withLock")(function* <A, E, R>(
  threadId: ThreadId,
  effect: Effect.Effect<A, E, R>,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const ancestors: Array<ThreadId> = [];
  const visited = new Set<ThreadId>();
  let current: ThreadId | null = threadId;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    ancestors.push(current);
    const projection: Pick<OrchestrationV2ThreadProjection, "thread"> =
      yield* projections.getThreadRecords(current, []);
    current =
      projection.thread.lineage.relationshipToParent === "subagent"
        ? projection.thread.lineage.parentThreadId
        : null;
  }
  let locked = effect;
  // Stop takes ancestors before descendants; provider acceptance uses the same order.
  for (const ancestor of ancestors) locked = executor.withLock(ancestor, locked);
  return yield* locked;
});

export const isBoardHandlingStopped = Effect.fn("BoardHandlingGuard.isStopped")(function* (input: {
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly resumeStopReceipt?: number | null;
}) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const visited = new Set<ThreadId>();
  let threadId: ThreadId | null = input.threadId;
  while (threadId !== null) {
    if (visited.has(threadId)) return true;
    visited.add(threadId);
    const projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "turnItems"> =
      yield* projections.getThreadRecords(threadId, ["runs", "turnItems"], {
        turnItemTypes: ["run_interrupt_request"],
      });
    if (
      threadId === input.threadId &&
      input.runId !== undefined &&
      projection.turnItems.some((item) => item.runId === input.runId)
    )
      return true;
    const latest = projection.runs
      .filter((run) => run.id !== input.runId && run.status !== "queued")
      .sort((left, right) => right.ordinal - left.ordinal)[0];
    if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return true;
    const targetResumed = threadId === input.threadId && input.resumeStopReceipt != null;
    {
      // A Stop on an idle thread has a receipt but no run interrupt item.
      const held = yield* sql`SELECT 1 FROM orchestration_command_receipts stopped
        WHERE stopped.aggregate_kind='thread' AND stopped.aggregate_id=${threadId}
          AND stopped.command_type='thread.stop' AND stopped.status='accepted'
          AND stopped.rowid > ${targetResumed ? input.resumeStopReceipt! : 0}
          AND NOT EXISTS (SELECT 1 FROM orchestration_events resumed
            WHERE resumed.aggregate_kind='thread' AND resumed.stream_id=${threadId}
              AND resumed.sequence > stopped.result_sequence
              AND resumed.event_type='message.updated'
              AND json_extract(resumed.payload_json,'$.createdBy')='user'
              AND json_extract(resumed.payload_json,'$.boardBatchId') IS NULL
              AND json_extract(resumed.payload_json,'$.creationSource') IN ('web','mobile'))
          AND NOT EXISTS (SELECT 1 FROM orchestration_command_receipts resumed
            WHERE resumed.aggregate_kind='thread' AND resumed.aggregate_id=${threadId}
              AND resumed.command_type='queue.resume' AND resumed.status='accepted'
              AND resumed.rowid > stopped.rowid)
        LIMIT 1`;
      if (held.length > 0) return true;
    }
    if (
      !targetResumed &&
      (projection.runs.some((run) => run.status === "queued" && run.queueHeld === true) ||
        (latest !== undefined && projection.turnItems.some((item) => item.runId === latest.id)))
    )
      return true;
    threadId =
      projection.thread.lineage.relationshipToParent === "subagent"
        ? projection.thread.lineage.parentThreadId
        : null;
  }
  return false;
});
