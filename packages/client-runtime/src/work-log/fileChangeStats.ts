import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import type { WorkLogPresentationEntry } from "./presentation.js";

export function fileChangeStats(
  item: OrchestrationV2TurnItem,
): { additions: number; deletions: number } | null {
  if (item.type !== "file_change" || item.status !== "completed") return null;

  const { additions, deletions } = item;
  if (
    typeof additions !== "number" ||
    !Number.isSafeInteger(additions) ||
    additions < 0 ||
    typeof deletions !== "number" ||
    !Number.isSafeInteger(deletions) ||
    deletions < 0
  ) {
    return null;
  }

  // These are this edit's metadata, not a sum of repeated edits or checkpoint diffs.
  return { additions, deletions };
}

export function workEntryDiffStats(
  entry: WorkLogPresentationEntry,
): { additions: number; deletions: number } | null {
  if (
    entry.tone === "error" ||
    (entry.toolLifecycleStatus !== undefined && entry.toolLifecycleStatus !== "completed")
  ) {
    return null;
  }

  return entry.structuredPayload ? fileChangeStats(entry.structuredPayload) : null;
}
