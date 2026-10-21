import { describe, expect, it } from "vite-plus/test";

import { countDiffLineStats, countTextLines } from "./fileChangeLineStats.ts";

describe("countDiffLineStats", () => {
  it("skips file headers before the first hunk", () => {
    const diff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "+added",
      "@@ -9,2 +10,1 @@",
      "-gone",
      " keep",
    ];
    expect(countDiffLineStats(diff)).toEqual({ additions: 2, deletions: 2 });
  });

  it("counts hunk lines that arrive without an @@ header", () => {
    expect(countDiffLineStats([" keep", "-old", "+new", "+++ literal"])).toEqual({
      additions: 2,
      deletions: 1,
    });
  });
});

describe("countTextLines", () => {
  it.each([
    ["", 0],
    ["one", 1],
    ["one\n", 1],
    ["one\ntwo", 2],
    ["one\n\n", 2],
  ] as const)("counts %j as %i lines", (text, lines) => {
    expect(countTextLines(text)).toBe(lines);
  });
});
