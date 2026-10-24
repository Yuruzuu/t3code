import { describe, expect, it } from "vite-plus/test";

import {
  fileContentLineCounts,
  structuredPatchMetadata,
  unifiedDiffLineCounts,
} from "./fileChangeMetadata.ts";

describe("native file-change metadata", () => {
  it("counts hunk changes without counting context, file headers, or newline markers", () => {
    expect(
      unifiedDiffLineCounts(
        "--- a/file\n+++ b/file\n@@ -1,3 +1,4 @@\n same\n-old\n+new\n+extra\n tail\n\\ No newline at end of file\n",
      ),
    ).toEqual({ additions: 2, deletions: 1 });
    expect(unifiedDiffLineCounts("@@ -0,0 +1,1 @@\n+created\n")).toEqual({
      additions: 1,
      deletions: 0,
    });
    expect(unifiedDiffLineCounts("@@ -1 +0,0 @@\n-deleted\n")).toEqual({
      additions: 0,
      deletions: 1,
    });
    expect(unifiedDiffLineCounts("@@ -1 +1 @@\r\n-before\r\n+after\r\n")).toEqual({
      additions: 1,
      deletions: 1,
    });
    expect(
      unifiedDiffLineCounts("@@ -1,2 +1,2 @@\n same\n-old\n+new\n@@ -10 +10,2 @@\n tail\n+added\n"),
    ).toEqual({ additions: 2, deletions: 1 });
  });

  it.each([
    "",
    "plain content",
    "@@",
    "@@ -1,2 +1,2 @@\n-old\n+new\n",
    "@@ -1 +1 @@\n-old\n+new\n+extra\n",
    "@@ -1,2 +1,2 @@\n-old\n+new\n@@ -4 +4 @@\n-old\n+new",
    "@@ -0,0 +1,2 @@\n+created\n... truncated",
    "Binary files a/file and b/file differ",
  ])("leaves incomplete or unsupported patches unknown: %s", (diff) => {
    expect(unifiedDiffLineCounts(diff)).toBeUndefined();
  });

  it("validates structured hunks and builds a native unified preview", () => {
    expect(
      structuredPatchMetadata([
        { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" same", "-old", "+new"] },
      ]),
    ).toEqual({ additions: 1, deletions: 1, diffStr: "@@ -1,2 +1,2 @@\n same\n-old\n+new" });
    expect(structuredPatchMetadata([])).toBeUndefined();
    expect(
      structuredPatchMetadata([
        { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ["-old", "+new"] },
      ]),
    ).toBeUndefined();
    expect(structuredPatchMetadata([{ oldLines: 1, lines: ["-old"] }])).toBeUndefined();
  });

  it("counts only changed lines in full file contents and bounds diff work", () => {
    expect(fileContentLineCounts("same\nold\ntail\n", "same\nnew\ntail\n")).toEqual({
      additions: 1,
      deletions: 1,
    });
    expect(fileContentLineCounts("a\nb\nc", "x\nb\ny")).toEqual({ additions: 2, deletions: 2 });
    expect(fileContentLineCounts("same\n", "same\n")).toEqual({ additions: 0, deletions: 0 });
    expect(fileContentLineCounts("same", "same\n")).toEqual({ additions: 1, deletions: 1 });
    expect(fileContentLineCounts("", "one\ntwo\n")).toEqual({ additions: 2, deletions: 0 });
    expect(fileContentLineCounts("old\n".repeat(501), "new\n".repeat(501))).toBeUndefined();
  });
});
