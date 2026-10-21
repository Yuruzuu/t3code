export interface FileChangeLineStats {
  readonly additions: number;
  readonly deletions: number;
}

/** Counts `+`/`-` lines in diff text, skipping any file headers before the first hunk. */
export function countDiffLineStats(lines: ReadonlyArray<string>): FileChangeLineStats {
  let additions = 0;
  let deletions = 0;
  let inHunk = !lines.some((line) => line.startsWith("@@"));
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
    } else if (!inHunk) {
      continue;
    } else if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

export function countTextLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function sumFileChangeLineStats(
  stats: ReadonlyArray<FileChangeLineStats>,
): FileChangeLineStats {
  let additions = 0;
  let deletions = 0;
  for (const stat of stats) {
    additions += stat.additions;
    deletions += stat.deletions;
  }
  return { additions, deletions };
}
