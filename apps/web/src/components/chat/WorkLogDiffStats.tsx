import { workEntryDiffStats } from "@t3tools/client-runtime/work-log/file-change-stats";
import type { WorkLogPresentationEntry } from "@t3tools/client-runtime/work-log/presentation";

import { DiffStatLabel } from "./DiffStatLabel";

export function WorkLogDiffStats({ entry }: { entry: WorkLogPresentationEntry }) {
  const stats = workEntryDiffStats(entry);
  if (!stats) return null;

  return <DiffStatLabel {...stats} layout="inline" className="shrink-0 text-xs" />;
}
