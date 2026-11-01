import type {
  OrchestrationV2ThreadShell,
  OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const STARTING = new Set(["preparing", "queued", "starting"]);
const MAX_ACTIVITY_CHARS = 60;

type ActivityShell = Pick<
  OrchestrationV2ThreadShell,
  | "status"
  | "pendingRuntimeRequest"
  | "blockedOnThreadWait"
  | "latestVisibleMessage"
  | "activityRunStartedAt"
  | "activeRunId"
>;

/**
 * What a working agent is doing, from data every client already has: blocked states first,
 * then its latest exposed thinking trace or message this run. Null when idle.
 */
export function boardAgentActivity(
  shell: ActivityShell,
  items: readonly OrchestrationV2ProjectedTurnItem[] = [],
): string | null {
  if (STARTING.has(shell.status)) return "Starting up";
  if (shell.status !== "running") return null;
  if (shell.pendingRuntimeRequest && shell.pendingRuntimeRequest.blocking !== false)
    return "Waiting for input";
  if (shell.blockedOnThreadWait) return "Waiting on another agent";
  const reasoning =
    shell.activeRunId == null
      ? undefined
      : items.findLast(
          ({ item }) =>
            item.type === "reasoning" &&
            item.runId === shell.activeRunId &&
            item.text.trim().length > 0,
        )?.item;
  const message = shell.latestVisibleMessage;
  const startedAt = shell.activityRunStartedAt;
  const text =
    reasoning?.type === "reasoning"
      ? reasoning.text
      : message?.role === "assistant" &&
          (startedAt == null ||
            DateTime.toEpochMillis(message.updatedAt) >= DateTime.toEpochMillis(startedAt))
        ? message.text
        : null;
  if (text) {
    const line = text
      .split("\n")
      .map((part) =>
        part
          .replace(/^\s*(?:[-*+>]|#{1,6}|\d+\.)\s*/, "")
          .replace(/\*\*|__|`/g, "")
          .trim(),
      )
      .find((part) => part.length > 0)
      ?.replace(/[.:…]+$/, "");
    if (line)
      return line.length > MAX_ACTIVITY_CHARS
        ? `${line.slice(0, MAX_ACTIVITY_CHARS - 1).trimEnd()}…`
        : line;
  }
  return "Working";
}
