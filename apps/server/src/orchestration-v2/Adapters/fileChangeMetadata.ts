import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

interface LineCounts {
  readonly additions: number;
  readonly deletions: number;
}

const PatchHunk = Schema.Struct({
  oldStart: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  oldLines: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  newStart: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  newLines: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lines: Schema.Array(Schema.String),
});
const decodePatch = Schema.decodeUnknownOption(Schema.Array(PatchHunk));

// Counts describe a complete native patch, never a clipped preview or a partial hunk.
export function unifiedDiffLineCounts(diff: string): LineCounts | undefined {
  const lines = diff.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  let oldRemaining = 0;
  let newRemaining = 0;
  let additions = 0;
  let deletions = 0;
  let hasHunk = false;
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (header) {
      if (oldRemaining !== 0 || newRemaining !== 0) return undefined;
      oldRemaining = Number(header[2] ?? 1);
      newRemaining = Number(header[4] ?? 1);
      if (!Number.isSafeInteger(oldRemaining) || !Number.isSafeInteger(newRemaining)) {
        return undefined;
      }
      hasHunk = true;
    } else if (line === "\\ No newline at end of file" && hasHunk) {
      continue;
    } else if (oldRemaining > 0 || newRemaining > 0) {
      if (line.startsWith("-") && oldRemaining > 0) {
        oldRemaining--;
        deletions++;
      } else if (line.startsWith("+") && newRemaining > 0) {
        newRemaining--;
        additions++;
      } else if (line.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) {
        oldRemaining--;
        newRemaining--;
      } else {
        return undefined;
      }
    } else if (
      !/^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to )/.test(
        line,
      )
    ) {
      return undefined;
    }
  }
  return hasHunk && oldRemaining === 0 && newRemaining === 0 ? { additions, deletions } : undefined;
}

export function structuredPatchMetadata(
  value: unknown,
): (LineCounts & { readonly diffStr: string }) | undefined {
  const decoded = decodePatch(value);
  if (Option.isNone(decoded) || decoded.value.length === 0) return undefined;
  const diffStr = decoded.value
    .map(
      (hunk) =>
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`,
    )
    .join("\n");
  const counts = unifiedDiffLineCounts(diffStr);
  return counts === undefined ? undefined : { ...counts, diffStr };
}

function textLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

// Full native write contents are a fallback; bound quadratic work on large rewrites.
export function fileContentLineCounts(oldText: string, newText: string): LineCounts | undefined {
  const oldLines = textLines(oldText);
  const newLines = textLines(newText);
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const oldLength = oldEnd - start;
  const newLength = newEnd - start;
  if (oldLength === 0 || newLength === 0) {
    return { additions: newLength, deletions: oldLength };
  }
  if (oldLength * newLength > 250_000) return undefined;
  const lengths = new Uint32Array(newLength + 1);
  for (let oldIndex = start; oldIndex < oldEnd; oldIndex++) {
    let diagonal = 0;
    for (let newIndex = 1; newIndex <= newLength; newIndex++) {
      const previous = lengths[newIndex]!;
      lengths[newIndex] =
        oldLines[oldIndex] === newLines[start + newIndex - 1]
          ? diagonal + 1
          : Math.max(previous, lengths[newIndex - 1]!);
      diagonal = previous;
    }
  }
  const unchanged = lengths[newLength]!;
  return { additions: newLength - unchanged, deletions: oldLength - unchanged };
}
