import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  fileChangeItemsByFile,
  getFileChangePreview as previewWithLineNumbers,
} from "./fileChangePreview.js";

type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

function fileChange(fields: Partial<FileChangeItem> = {}): FileChangeItem {
  return {
    id: TurnItemId.make("file-change"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-24T00:00:00.000Z"),
    type: "file_change",
    fileName: "file.ts",
    ...fields,
  };
}

function filePatch(oldPath: string, newPath: string, oldText: string, newText: string): string {
  return `--- ${oldPath}\n+++ ${newPath}\n@@ -1 +1 @@\n-${oldText}\n+${newText}\n`;
}

// Most cases cover parsing and path matching; numbering has its own test below.
function getFileChangePreview(item: FileChangeItem) {
  const preview = previewWithLineNumbers(item);
  return preview && { ...preview, lines: preview.lines.map(({ kind, text }) => ({ kind, text })) };
}

describe("getFileChangePreview", () => {
  it("numbers patch lines from their hunk header across omitted context", () => {
    const middle = Array.from({ length: 10 }, (_, index) => ` context ${index}`);
    const preview = previewWithLineNumbers(
      fileChange({
        diffStr: ["@@ -8,13 +8,13 @@", " keep", "-old", "+new", ...middle, "-last", "+latest"].join(
          "\n",
        ),
      }),
    );
    expect(preview?.lines.map((line) => [line.kind, line.line])).toEqual([
      ["hunk", undefined],
      ["context", 8],
      ["deletion", 9],
      ["addition", 9],
      ["context", 10],
      ["context", 11],
      ["context", 12],
      ["hunk", undefined],
      ["context", 17],
      ["context", 18],
      ["context", 19],
      ["deletion", 20],
      ["addition", 20],
    ]);
  });

  it("reads a unified patch without displaying file headers as changes", () => {
    expect(
      getFileChangePreview(
        fileChange({
          diffStr:
            "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -8,2 +8,2 @@ name\n keep\n-old\n+new\n",
          oldStr: "unrelated fallback",
          newStr: "must not appear",
        }),
      ),
    ).toEqual({
      lines: [
        { kind: "hunk", text: "@@ -8,2 +8,2 @@ name" },
        { kind: "context", text: "keep" },
        { kind: "deletion", text: "old" },
        { kind: "addition", text: "new" },
      ],
      truncated: false,
    });
  });

  it("previews a new file from its explicit patch", () => {
    expect(
      getFileChangePreview(
        fileChange({ diffStr: "--- /dev/null\n+++ b/file.ts\n@@ -0,0 +1,2 @@\n+first\n+second\n" }),
      ),
    ).toEqual({
      lines: [
        { kind: "hunk", text: "@@ -0,0 +1,2 @@" },
        { kind: "addition", text: "first" },
        { kind: "addition", text: "second" },
      ],
      truncated: false,
    });
  });

  it.each(["create", "add", "Create"])(
    "uses an explicit %s operation to supply an empty prior side",
    (operation) => {
      expect(
        getFileChangePreview(
          fileChange({ newStr: "created\n", changes: [{ operation, path: "file.ts" }] }),
        ),
      ).toEqual({
        lines: [
          { kind: "hunk", text: "@@ -0,0 +1,1 @@" },
          { kind: "addition", text: "created" },
        ],
        truncated: false,
      });
    },
  );

  it("does not borrow a create operation from another path", () => {
    expect(
      getFileChangePreview(
        fileChange({ newStr: "unknown", changes: [{ operation: "create", path: "other.ts" }] }),
      ),
    ).toBeNull();
  });

  it("does not merge other changed paths into the first file's patch", () => {
    const preview = getFileChangePreview(
      fileChange({
        diffStr: "@@ -1 +1 @@\n-old\n+first file\n",
        changes: [
          { operation: "update", path: "file.ts" },
          { operation: "create", path: "other.ts" },
        ],
      }),
    );
    expect(preview?.lines.filter((line) => line.kind === "addition")).toEqual([
      { kind: "addition", text: "first file" },
    ]);
  });

  it.each(["file.ts", "other.ts"])("only previews %s from a two-file unified patch", (fileName) => {
    const preview = getFileChangePreview(
      fileChange({
        fileName,
        diffStr:
          "diff --git a/file.ts b/file.ts\n" +
          filePatch("a/file.ts", "b/file.ts", "old first", "new first") +
          "diff --git a/other.ts b/other.ts\n" +
          filePatch("a/other.ts", "b/other.ts", "old second", "new second"),
      }),
    );
    const name = fileName === "file.ts" ? "first" : "second";
    expect(preview).toEqual({
      lines: [
        { kind: "hunk", text: "@@ -1 +1 @@" },
        { kind: "deletion", text: `old ${name}` },
        { kind: "addition", text: `new ${name}` },
      ],
      truncated: false,
    });
  });

  it("separates unified file headers without git metadata", () => {
    const preview = getFileChangePreview(
      fileChange({
        diffStr:
          filePatch("file.ts", "file.ts", "old first", "new first") +
          filePatch("other.ts", "other.ts", "old second", "new second"),
      }),
    );
    expect(preview?.lines.filter((line) => line.kind === "addition")).toEqual([
      { kind: "addition", text: "new first" },
    ]);
  });

  it.each(["src/old.ts", "src/new.ts"])("matches a renamed file by its %s path", (fileName) => {
    const preview = getFileChangePreview(
      fileChange({
        fileName,
        diffStr:
          filePatch("a/src/old.ts", "b/src/new.ts", "old renamed", "new renamed") +
          filePatch("a/other.ts", "b/other.ts", "old other", "new other"),
      }),
    );
    expect(preview?.lines.filter((line) => line.kind === "addition")).toEqual([
      { kind: "addition", text: "new renamed" },
    ]);
  });

  it.each(["C:\\Repo\\src\\App.ts", "\\\\Server\\Repo\\src\\App.ts"])(
    "matches mixed-case relative headers against Windows target %s",
    (fileName) => {
      const preview = getFileChangePreview(
        fileChange({
          fileName,
          diffStr:
            filePatch("a/src/App.ts", "b/src/App.ts", "old app", "new app") +
            filePatch("a/src/Other.ts", "b/src/Other.ts", "old other", "new other"),
        }),
      );
      expect(preview?.lines.filter((line) => line.kind === "addition")).toEqual([
        { kind: "addition", text: "new app" },
      ]);
    },
  );

  it("matches normalized Windows absolute headers exactly", () => {
    const preview = getFileChangePreview(
      fileChange({
        fileName: "C:\\Repo\\src\\App.ts",
        diffStr: filePatch("c:/repo/src/APP.ts", "c:/repo/src/APP.ts", "old", "new"),
      }),
    );
    expect(preview?.lines).toContainEqual({ kind: "addition", text: "new" });
  });

  it("preserves case-sensitive POSIX path matching", () => {
    expect(
      getFileChangePreview(
        fileChange({
          fileName: "/repo/src/app.ts",
          diffStr: filePatch("a/src/App.ts", "b/src/App.ts", "old", "new"),
        }),
      ),
    ).toBeNull();
  });

  it("prefers an exact path over a nested file with the same basename", () => {
    const preview = getFileChangePreview(
      fileChange({
        diffStr:
          filePatch("a/src/file.ts", "b/src/file.ts", "old nested", "new nested") +
          filePatch("a/file.ts", "b/file.ts", "old root", "new root"),
      }),
    );
    expect(preview?.lines.filter((line) => line.kind === "addition")).toEqual([
      { kind: "addition", text: "new root" },
    ]);
  });

  it("returns null when a basename identifies multiple patch sections", () => {
    expect(
      getFileChangePreview(
        fileChange({
          diffStr:
            filePatch("a/src/file.ts", "b/src/file.ts", "old src", "new src") +
            filePatch("a/test/file.ts", "b/test/file.ts", "old test", "new test"),
        }),
      ),
    ).toBeNull();
  });

  it("returns null for headers belonging to another file", () => {
    expect(
      getFileChangePreview(
        fileChange({ diffStr: filePatch("a/other.ts", "b/other.ts", "old other", "new other") }),
      ),
    ).toBeNull();
  });

  it("decodes quoted header paths and ignores timestamps", () => {
    const preview = getFileChangePreview(
      fileChange({
        fileName: "src/my file.ts",
        diffStr: filePatch(
          '"a/src/my file.ts"\t2026-10-24',
          '"b/src/my file.ts"\t2026-10-24',
          "old",
          "new",
        ),
      }),
    );
    expect(preview?.lines).toContainEqual({ kind: "addition", text: "new" });
  });

  it("does not confuse paired header-like source lines with a new file section", () => {
    const preview = getFileChangePreview(
      fileChange({ diffStr: "@@ -1 +1 @@\n--- a/other.ts\n+++ b/other.ts\n" }),
    );
    expect(preview?.lines.slice(1)).toEqual([
      { kind: "deletion", text: "-- a/other.ts" },
      { kind: "addition", text: "++ b/other.ts" },
    ]);
  });

  it("previews a new file whose diff text is its whole content", () => {
    const preview = previewWithLineNumbers(
      fileChange({ diffStr: "first\nsecond\n", changes: [{ operation: "add", path: "file.ts" }] }),
    );
    expect(preview?.lines.map((line) => [line.kind, line.text, line.line])).toEqual([
      ["hunk", "@@ -0,0 +1,2 @@", undefined],
      ["addition", "first", 1],
      ["addition", "second", 2],
    ]);
  });

  it("preserves explicit empty old text as an addition", () => {
    expect(getFileChangePreview(fileChange({ oldStr: "", newStr: "\nvalue\n" }))).toEqual({
      lines: [
        { kind: "hunk", text: "@@ -0,0 +1,2 @@" },
        { kind: "addition", text: "" },
        { kind: "addition", text: "value" },
      ],
      truncated: false,
    });
  });

  it("preserves explicit empty new text as a deletion", () => {
    expect(getFileChangePreview(fileChange({ oldStr: "value", newStr: "" }))).toEqual({
      lines: [
        { kind: "hunk", text: "Changed excerpt" },
        { kind: "deletion", text: "value" },
      ],
      truncated: false,
    });
  });

  it("uses a delete operation to supply an empty new side", () => {
    expect(
      getFileChangePreview(
        fileChange({ oldStr: "removed", changes: [{ operation: "delete", path: "file.ts" }] }),
      )?.lines,
    ).toEqual([
      { kind: "hunk", text: "Changed excerpt" },
      { kind: "deletion", text: "removed" },
    ]);
  });

  it("aligns unchanged lines between separate edits without marking them as replaced", () => {
    const preview = getFileChangePreview(
      fileChange({
        oldStr: "before\nold one\nkeep\nold two\nafter",
        newStr: "before\nnew one\nkeep\nnew two\nafter",
      }),
    );
    expect(preview).toEqual({
      lines: [
        { kind: "hunk", text: "Changed excerpt" },
        { kind: "context", text: "before" },
        { kind: "deletion", text: "old one" },
        { kind: "addition", text: "new one" },
        { kind: "context", text: "keep" },
        { kind: "deletion", text: "old two" },
        { kind: "addition", text: "new two" },
        { kind: "context", text: "after" },
      ],
      truncated: false,
    });
  });

  it.each(["patch", "fallback"])("normalizes Windows newlines in %s data", (source) => {
    const fields =
      source === "patch"
        ? { diffStr: "@@ -1,2 +1,2 @@\r\n keep\r\n-old\r\n+new\r\n" }
        : { oldStr: "keep\r\nold\r\n", newStr: "keep\nnew\n" };
    const preview = getFileChangePreview(fileChange(fields));
    expect(preview?.lines.slice(1)).toEqual([
      { kind: "context", text: "keep" },
      { kind: "deletion", text: "old" },
      { kind: "addition", text: "new" },
    ]);
  });

  it.each([
    {},
    { oldStr: "old" },
    { newStr: "new" },
    { oldStr: "", newStr: "" },
    { oldStr: "same", newStr: "same" },
    { oldStr: "same\r\n", newStr: "same\n" },
    { diffStr: "File updated successfully" },
    { diffStr: "--- old.ts\n+++ new.ts\n" },
    { diffStr: "@@ -1 +1 @@\n same\n" },
  ])("returns null without known changed lines: %j", (fields) => {
    expect(getFileChangePreview(fileChange(fields))).toBeNull();
  });

  it.each(["String to replace not found", "@@ -1 +1 @@\n-old\n+new\n"])(
    "never previews failed edits even when fallback data or diff-shaped errors exist: %s",
    (diffStr) => {
      expect(
        getFileChangePreview(
          fileChange({ status: "failed", diffStr, oldStr: "old", newStr: "new" }),
        ),
      ).toBeNull();
    },
  );

  it("falls back to known excerpts when diffStr is not a unified patch", () => {
    expect(
      getFileChangePreview(fileChange({ diffStr: "updated", oldStr: "old", newStr: "new" }))?.lines,
    ).toEqual([
      { kind: "hunk", text: "Changed excerpt" },
      { kind: "deletion", text: "old" },
      { kind: "addition", text: "new" },
    ]);
  });

  it("keeps source lines beginning with patch header characters", () => {
    expect(
      getFileChangePreview(fileChange({ diffStr: "@@ -1 +1 @@\n---old\n+++new\n" }))?.lines.slice(
        1,
      ),
    ).toEqual([
      { kind: "deletion", text: "--old" },
      { kind: "addition", text: "++new" },
    ]);
  });

  it("ignores no-newline metadata", () => {
    expect(
      getFileChangePreview(
        fileChange({
          diffStr:
            "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file",
        }),
      )?.lines.slice(1),
    ).toEqual([
      { kind: "deletion", text: "old" },
      { kind: "addition", text: "new" },
    ]);
  });

  it("limits context around separate changes and marks omitted sections", () => {
    const middle = Array.from({ length: 20 }, (_, index) => ` context ${index}`);
    const preview = getFileChangePreview(
      fileChange({
        diffStr: ["@@ -1,22 +1,22 @@", "-old", "+new", ...middle, "-last", "+latest"].join("\n"),
      }),
    );
    expect(preview?.truncated).toBe(true);
    expect(preview?.lines.filter((line) => line.kind === "context")).toHaveLength(6);
    expect(preview?.lines).toContainEqual({ kind: "hunk", text: "…" });
    expect(preview?.lines).toContainEqual({ kind: "addition", text: "latest" });
  });

  it.each(["patch", "fallback"])("bounds %s previews to forty lines", (source) => {
    const text = Array.from({ length: 80 }, (_, index) => `line ${index}`);
    const fields =
      source === "patch"
        ? { diffStr: ["@@ -0,0 +1,80 @@", ...text.map((line) => `+${line}`)].join("\n") }
        : { oldStr: "", newStr: text.join("\n") };
    const preview = getFileChangePreview(fileChange(fields));
    expect(preview?.lines).toHaveLength(40);
    expect(preview?.truncated).toBe(true);
  });

  it("does not mark an exactly forty-line preview as truncated", () => {
    const text = Array.from({ length: 39 }, (_, index) => `line ${index}`).join("\n");
    const preview = getFileChangePreview(fileChange({ oldStr: "", newStr: text }));
    expect(preview?.lines).toHaveLength(40);
    expect(preview?.truncated).toBe(false);
  });

  it("bounds long displayed lines", () => {
    const preview = getFileChangePreview(fileChange({ oldStr: "", newStr: "x".repeat(2_000) }));
    expect(preview?.lines[1]?.text).toBe(`${"x".repeat(500)}…`);
    expect(preview?.truncated).toBe(true);
  });

  it("scans only a bounded prefix of giant patches", () => {
    const preview = getFileChangePreview(
      fileChange({ diffStr: `@@ -0,0 +1,2 @@\n+first\n+${"x".repeat(100_000)}` }),
    );
    expect(preview).toEqual({
      lines: [
        { kind: "hunk", text: "@@ -0,0 +1,2 @@" },
        { kind: "addition", text: "first" },
      ],
      truncated: true,
    });
  });

  it("marks a transport-truncated patch as partial and excludes its sentinel", () => {
    const preview = getFileChangePreview(
      fileChange({ diffStr: "@@ -1,2 +1,2 @@\n-old\n+new\n… output truncated for transport" }),
    );
    expect(preview).toEqual({
      lines: [
        { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
        { kind: "deletion", text: "old" },
        { kind: "addition", text: "new" },
      ],
      truncated: true,
    });
  });

  it("skips excerpt comparisons when either side was transport-truncated", () => {
    const preview = getFileChangePreview(
      fileChange({ oldStr: "old", newStr: "new\n… output truncated for transport" }),
    );
    expect(preview).toBeNull();
    expect(
      getFileChangePreview(
        fileChange({ oldStr: "old\n… output truncated for transport", newStr: "new" }),
      ),
    ).toBeNull();
  });

  it("does not invent tail changes after an insertion into independently clipped contents", () => {
    const oldText = `${"x".repeat(100)}\n`.repeat(400);
    const newText = `NEW\n${oldText}`;
    const clip = (text: string) => `${text.slice(0, 32_768)}\n… output truncated for transport`;

    expect(
      getFileChangePreview(fileChange({ oldStr: clip(oldText), newStr: clip(newText) })),
    ).toBeNull();
  });

  it("retains a valid patch preview when fallback contents were clipped", () => {
    const preview = getFileChangePreview(
      fileChange({
        diffStr: "@@ -0,0 +1,1 @@\n+NEW\n",
        oldStr: "old\n… output truncated for transport",
        newStr: "NEW\nold\n… output truncated for transport",
      }),
    );

    expect(preview?.lines).toContainEqual({ kind: "addition", text: "NEW" });
    expect(preview?.lines.some((line) => line.kind === "deletion")).toBe(false);
  });

  it("preserves incomplete-hunk truncation after unrecognized text resets the parser", () => {
    const preview = getFileChangePreview(
      fileChange({ diffStr: "@@ -1,2 +1,2 @@\n-old\n+new\nprovider stopped output\n" }),
    );
    expect(preview?.truncated).toBe(true);
    expect(preview?.lines).toHaveLength(3);
  });

  it("skips oversized text and excessive diff work instead of inventing replacements", () => {
    expect(
      getFileChangePreview(fileChange({ oldStr: "x".repeat(100_000), newStr: "new" })),
    ).toBeNull();
    const oldStr = Array.from({ length: 600 }, (_, index) => `old ${index}`).join("\n");
    const newStr = Array.from({ length: 600 }, (_, index) => `new ${index}`).join("\n");
    expect(getFileChangePreview(fileChange({ oldStr, newStr }))).toBeNull();
  });
});

describe("fileChangeItemsByFile", () => {
  it("gives each file of a patch its own diff and counts", () => {
    const files = fileChangeItemsByFile(
      fileChange({
        fileName: "a.ts",
        diffStr: "@@ -1 +1 @@\n-a\n+b\n",
        additions: 4,
        deletions: 1,
        changes: [
          { operation: "update", path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b\n", additions: 1 },
          { operation: "add", path: "b.ts", diff: "first\nsecond\n", additions: 3 },
        ],
      }),
    );
    expect(
      files.map(({ fileName, diffStr, additions }) => ({ fileName, diffStr, additions })),
    ).toEqual([
      { fileName: "a.ts", diffStr: "@@ -1 +1 @@\n-a\n+b\n", additions: 1 },
      { fileName: "b.ts", diffStr: "first\nsecond\n", additions: 3 },
    ]);
    expect(getFileChangePreview(files[1]!)?.lines.map(({ text }) => text)).toEqual([
      "@@ -0,0 +1,2 @@",
      "first",
      "second",
    ]);
  });

  it("never shows one file's headerless patch under another file", () => {
    const files = fileChangeItemsByFile(
      fileChange({
        fileName: "a.ts",
        diffStr: "@@ -1 +1 @@\n-a\n+b\n",
        changes: [
          { operation: "update", path: "a.ts" },
          { operation: "add", path: "b.ts" },
        ],
      }),
    );
    expect(files.map((file) => file.diffStr)).toEqual(["@@ -1 +1 @@\n-a\n+b\n", undefined]);
  });
});
