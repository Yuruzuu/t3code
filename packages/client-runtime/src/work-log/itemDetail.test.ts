import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { turnItemNeedsDetailFetch } from "./itemDetail.js";

type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

function fileChange(overrides: Partial<FileChangeItem> = {}): FileChangeItem {
  return {
    id: TurnItemId.make("edit"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-24T00:00:00Z"),
    type: "file_change",
    fileName: "src/app.ts",
    ...overrides,
  };
}

describe("file change detail fetching", () => {
  it("hydrates the diff omitted from a wire summary even when counts are known", () => {
    expect(turnItemNeedsDetailFetch(fileChange({ additions: 3, deletions: 2 }))).toBe(true);
  });

  it.each([{ diffStr: "@@ -1 +1 @@\n-old\n+new" }, { oldStr: "old", newStr: "new" }])(
    "uses available detail without another fetch: %j",
    (detail) => {
      expect(turnItemNeedsDetailFetch(fileChange(detail))).toBe(false);
    },
  );

  it("keeps explicit empty create content available", () => {
    expect(
      turnItemNeedsDetailFetch(
        fileChange({ newStr: "", changes: [{ operation: "create", path: "src/app.ts" }] }),
      ),
    ).toBe(false);
  });

  it("does not hydrate failed edits whose error is already in the summary", () => {
    expect(turnItemNeedsDetailFetch(fileChange({ status: "failed", diffStr: "Edit failed" }))).toBe(
      false,
    );
    expect(turnItemNeedsDetailFetch(fileChange({ status: "failed" }))).toBe(false);
  });
});
