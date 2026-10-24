import { describe, expect, it } from "vite-plus/test";

import {
  CheckpointId,
  CheckpointScopeId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { fileChangeStats, workEntryDiffStats } from "./fileChangeStats.js";
import { toolItemForDisplay, type WorkLogPresentationEntry } from "./presentation.js";

type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

function fileChange(fields: Partial<FileChangeItem> = {}): FileChangeItem {
  return {
    id: TurnItemId.make("edit"),
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
    fileName: "src/main.ts",
    ...fields,
  };
}

function workEntry(
  structuredPayload?: OrchestrationV2TurnItem,
  fields: Partial<WorkLogPresentationEntry> = {},
): WorkLogPresentationEntry {
  return {
    id: "edit",
    createdAt: "2026-10-24T00:00:00.000Z",
    tone: "tool",
    label: "Changed src/main.ts",
    ...(structuredPayload ? { structuredPayload, itemType: structuredPayload.type } : {}),
    ...fields,
  };
}

describe("fileChangeStats", () => {
  it.each([
    { additions: 0, deletions: 0 },
    { additions: 0, deletions: 3 },
    { additions: 4, deletions: 0 },
    { additions: 12, deletions: 7 },
  ])("preserves explicit counts, including zero: %j", (stats) => {
    expect(fileChangeStats(fileChange(stats))).toEqual(stats);
  });

  it.each([{}, { additions: 0 }, { deletions: 0 }])(
    "does not replace unknown counts with zero: %j",
    (stats) => {
      expect(fileChangeStats(fileChange(stats))).toBeNull();
    },
  );

  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "3", null])(
    "rejects invalid count %s on either side",
    (value) => {
      // Persisted provider metadata can predate validation at the wire boundary.
      const additions = { additions: value, deletions: 0 } as Partial<FileChangeItem>;
      const deletions = { additions: 0, deletions: value } as Partial<FileChangeItem>;
      expect(fileChangeStats(fileChange(additions))).toBeNull();
      expect(fileChangeStats(fileChange(deletions))).toBeNull();
    },
  );

  it.each(["idle", "pending", "running", "waiting", "failed", "cancelled", "interrupted"] as const)(
    "hides counts for %s edits",
    (status) => {
      expect(fileChangeStats(fileChange({ status, additions: 9, deletions: 2 }))).toBeNull();
    },
  );

  it.each([{}, { additions: 6, deletions: 2 }])(
    "does not read edit bodies with metadata %j",
    (stats) => {
      const item = fileChange(stats);
      const unreadableBody = {
        get: () => {
          throw new Error("edit bodies must not be read");
        },
      };
      Object.defineProperties(item, {
        diffStr: unreadableBody,
        oldStr: unreadableBody,
        newStr: unreadableBody,
      });
      expect(fileChangeStats(item)).toEqual("additions" in stats ? stats : null);
    },
  );
});

describe("workEntryDiffStats", () => {
  it("uses counts preserved by the metadata-only display projection", () => {
    const item = fileChange({ additions: 4, deletions: 1, diffStr: "+body", newStr: "body" });
    expect(
      workEntryDiffStats(
        workEntry(toolItemForDisplay(item), {
          toolLifecycleStatus: "completed",
        }),
      ),
    ).toEqual({
      additions: 4,
      deletions: 1,
    });
  });

  it.each(["inProgress", "failed", "declined", "stopped", "idle"] as const)(
    "hides counts when the presentation status is %s",
    (toolLifecycleStatus) => {
      expect(
        workEntryDiffStats(
          workEntry(fileChange({ additions: 4, deletions: 1 }), {
            toolLifecycleStatus,
          }),
        ),
      ).toBeNull();
    },
  );

  it("does not let completed presentation override failed edit state", () => {
    expect(
      workEntryDiffStats(
        workEntry(
          fileChange({
            status: "failed",
            additions: 4,
            deletions: 1,
          }),
          { toolLifecycleStatus: "completed" },
        ),
      ),
    ).toBeNull();
  });

  it("hides error entries even with completed metadata", () => {
    expect(
      workEntryDiffStats(
        workEntry(fileChange({ additions: 4, deletions: 1 }), {
          tone: "error",
        }),
      ),
    ).toBeNull();
  });

  it("does not infer counts from changed files, text, or untyped tool metadata", () => {
    expect(
      workEntryDiffStats(
        workEntry(undefined, {
          itemType: "file_change",
          changedFiles: ["src/main.ts", "src/main.ts"],
          detail: "+4 -1",
          toolData: { additions: 4, deletions: 1 },
        }),
      ),
    ).toBeNull();
  });

  it("does not combine repeated paths or count metadata again from toolData", () => {
    const item = fileChange({
      additions: 4,
      deletions: 1,
      changes: [
        { path: "src/main.ts", operation: "modify" },
        { path: "src/main.ts", operation: "modify" },
      ],
    });
    expect(workEntryDiffStats(workEntry(item, { toolData: item }))).toEqual({
      additions: 4,
      deletions: 1,
    });
  });

  it.each(["Edit", "Read", "Bash", "apply_patch", "get_diff"])(
    "does not read untyped dynamic tool output for %s",
    (toolName) => {
      const item: OrchestrationV2TurnItem = {
        ...fileChange({ additions: 4, deletions: 1 }),
        type: "dynamic_tool",
        toolName,
        input: {},
        get output() {
          throw new Error("output must not be read or hydrated");
        },
      };
      expect(workEntryDiffStats(workEntry(item))).toBeNull();
    },
  );

  it("ignores checkpoint totals", () => {
    const item: OrchestrationV2TurnItem = {
      ...fileChange(),
      type: "checkpoint",
      checkpointId: CheckpointId.make("checkpoint"),
      scopeId: CheckpointScopeId.make("scope"),
      files: [{ path: "src/main.ts", kind: "modified", additions: 99, deletions: 88 }],
    };
    expect(
      workEntryDiffStats(
        workEntry(item, {
          toolData: { files: [{ path: "src/main.ts", additions: 99, deletions: 88 }] },
        }),
      ),
    ).toBeNull();
  });
});
