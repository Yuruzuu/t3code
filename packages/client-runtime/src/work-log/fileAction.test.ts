import { describe, expect, it } from "vite-plus/test";
import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { workEntryFileAction, workEntryFileActionLabel } from "./fileAction.js";
import type { WorkLogPresentationEntry } from "./presentation.js";

function entry(fields: Partial<WorkLogPresentationEntry> = {}): WorkLogPresentationEntry {
  return {
    id: "file-action",
    createdAt: "2026-10-24T00:00:00.000Z",
    label: "Tool call",
    tone: "tool",
    toolLifecycleStatus: "completed",
    ...fields,
  };
}

function itemBase() {
  return {
    id: TurnItemId.make("file-action"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed" as const,
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-24T00:00:00.000Z"),
  };
}

function fileItem(
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "file_change" }>> = {},
): Extract<OrchestrationV2TurnItem, { type: "file_change" }> {
  return { ...itemBase(), type: "file_change", fileName: "src/a.ts", ...fields };
}

function dynamicEntry(toolName: string, input: unknown): WorkLogPresentationEntry {
  return entry({
    itemType: "dynamic_tool",
    structuredPayload: { ...itemBase(), type: "dynamic_tool", toolName, input },
  });
}

describe("workEntryFileAction", () => {
  it.each([
    ["create", "Created"],
    ["add", "Created"],
    ["edit", "Edited"],
    ["update", "Edited"],
    ["modify", "Edited"],
    ["write", "Wrote"],
    ["delete", "Deleted"],
    ["remove", "Deleted"],
    ["rename", "Renamed"],
    ["move", "Renamed"],
    ["unknown", "Changed"],
  ])("uses the explicit %s file change operation", (operation, action) => {
    const value = entry({
      structuredPayload: fileItem({ changes: [{ operation, path: "src/SectionRail.luau" }] }),
    });
    expect(workEntryFileAction(value)).toEqual({
      action,
      fileName: "SectionRail.luau",
      path: "src/SectionRail.luau",
      paths: ["src/SectionRail.luau"],
    });
    expect(workEntryFileActionLabel(value)).toBe(`${action} SectionRail.luau`);
  });

  it("retains both rename paths without counting the source as another changed file", () => {
    const value = entry({
      structuredPayload: fileItem({
        fileName: "/repo/old.ts",
        changes: [{ operation: "move", path: "/repo/new.ts", oldPath: "/repo/old.ts" }],
      }),
    });
    expect(workEntryFileAction(value)).toEqual({
      action: "Renamed",
      fileName: "new.ts",
      path: "/repo/new.ts",
      paths: ["/repo/new.ts", "/repo/old.ts"],
    });
    expect(workEntryFileActionLabel(value)).toBe("Renamed new.ts");
  });

  it("uses a truthful generic action when Codex or Claude omitted the operation", () => {
    expect(workEntryFileActionLabel(entry({ structuredPayload: fileItem() }))).toBe("Changed a.ts");
  });

  it.each([
    ["completed", "Edited a.ts"],
    ["inProgress", "Editing a.ts"],
  ] as const)(
    "supports the collapsed toolData-only file-change shape with %s status",
    (toolLifecycleStatus, label) => {
      const value = entry({
        toolLifecycleStatus,
        toolData: { type: "file_change", changes: [{ operation: "edit", path: "src/a.ts" }] },
      });
      expect(workEntryFileActionLabel(value)).toBe(label);
      expect(workEntryFileAction(value)?.path).toBe("src/a.ts");
    },
  );

  it.each([
    ["Read", { file_path: "/workspace/src/a.ts" }, "Read a.ts"],
    ["Read", { path: "src/a.ts" }, "Read a.ts"],
    ["read_file", { filePath: "src/a.ts" }, "Read a.ts"],
    ["Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }, "Edited a.ts"],
    ["MultiEdit", { file_path: "src/a.ts", edits: [] }, "Edited a.ts"],
    ["edit_file", { path: "src/a.ts" }, "Edited a.ts"],
    ["NotebookEdit", { notebook_path: "src/a.ipynb" }, "Edited a.ipynb"],
    ["Write", { file_path: "src/a.ts", content: "hello" }, "Wrote a.ts"],
    ["write_file", { path: "src/a.ts", content: "hello" }, "Wrote a.ts"],
    ["create_file", { path: "src/a.ts" }, "Created a.ts"],
    ["delete_file", { path: "src/a.ts" }, "Deleted a.ts"],
    ["move_file", { source: "old/a.ts", destination: "new/b.ts" }, "Renamed b.ts"],
  ])("supports %s provider input %j", (toolName, input, label) => {
    expect(workEntryFileActionLabel(dynamicEntry(toolName, input))).toBe(label);
  });

  it.each(["input", "rawInput", "arguments"])("supports retained %s tool data", (key) => {
    expect(
      workEntryFileActionLabel(
        entry({
          toolTitle: "Edit",
          toolData: { [key]: { file_path: "src/a.ts" } },
        }),
      ),
    ).toBe("Edited a.ts");
  });

  it("prefers structured provider identity and input over display titles and stale tool data", () => {
    const value = {
      ...dynamicEntry("Read", { path: "src/a.ts" }),
      toolTitle: "Write",
      toolData: { toolName: "Write", input: { path: "src/b.ts" } },
    };
    expect(workEntryFileActionLabel(value)).toBe("Read a.ts");
  });

  it.each([
    ["/workspace/src/a.ts", "a.ts"],
    ["D:\\workspace\\src\\SectionRail.luau", "SectionRail.luau"],
    ["\\\\server\\share\\File Name.js", "File Name.js"],
    ["D:\\workspace/src\\a.ts", "a.ts"],
    [".gitignore", ".gitignore"],
    ["  file name.ts  ", "  file name.ts  "],
  ])("preserves %j and extracts its basename", (path, fileName) => {
    expect(workEntryFileAction(dynamicEntry("Read", { path }))).toEqual({
      action: "Read",
      fileName,
      path,
      paths: [path],
    });
  });

  it("does not inspect output, diffs, or detail to produce collapsed labels", () => {
    const value = {
      ...entry(),
      structuredPayload: {
        ...fileItem({ changes: [{ operation: "create", path: "src/a.ts" }] }),
        get diffStr(): string {
          throw new Error("diff must remain lazy");
        },
      },
      get detail(): string {
        throw new Error("detail must remain lazy");
      },
      toolData: {
        get output(): unknown {
          throw new Error("output must remain lazy");
        },
      },
    };
    expect(workEntryFileActionLabel(value)).toBe("Created a.ts");
    const read = dynamicEntry("Read", { path: "src/a.ts" });
    expect(
      workEntryFileActionLabel({
        ...read,
        structuredPayload: {
          ...itemBase(),
          type: "dynamic_tool",
          toolName: "Read",
          input: { path: "src/a.ts" },
          outputOmitted: true,
          get output(): unknown {
            throw new Error("output must remain lazy");
          },
        },
      }),
    ).toBe("Read a.ts");
  });

  it.each([
    ["Bash", { path: "src/a.ts", command: "cat src/a.ts" }],
    ["Grep", { path: "src/a.ts" }],
    ["mcp__example__read_file", { path: "src/a.ts" }],
    ["github.read_file", { path: "src/a.ts" }],
    ["mcp__github__read_file", { path: "src/a.ts" }],
    ["read_thread", { path: "src/a.ts" }],
    ["preview_navigate", { url: "https://example.com/a.ts" }],
    ["Read", { output: { path: "src/a.ts" } }],
    ["Read", { content: "src/a.ts" }],
    ["Read", '{"path":"src/a.ts"}'],
  ])("does not guess a file action for %s with %j", (toolName, input) => {
    const value = dynamicEntry(toolName, input);
    expect(workEntryFileAction(value)).toBeNull();
    expect(workEntryFileActionLabel(value)).toBeNull();
  });

  it.each(["", " ", "/repo/", "D:\\repo\\", ".", "..", "src/a.ts\noutput", "bad\0path"])(
    "ignores invalid or directory paths %j",
    (path) => {
      expect(workEntryFileAction(dynamicEntry("Read", { path }))).toBeNull();
    },
  );

  it("does not treat checkpoint files or unrelated entry types as edits", () => {
    expect(
      workEntryFileAction(entry({ itemType: "checkpoint", changedFiles: ["src/a.ts"] })),
    ).toBeNull();
    expect(
      workEntryFileAction(
        entry({ itemType: "reasoning", label: "Read", toolData: { input: { path: "src/a.ts" } } }),
      ),
    ).toBeNull();
  });
});

describe("workEntryFileActionLabel grouped changes", () => {
  it("counts distinct files and keeps every full path", () => {
    const changes = ["src/a.ts", "lib/b.ts", "lib/c.ts", "src/a.ts"].map((path) => ({
      operation: "edit",
      path,
    }));
    const value = entry({ structuredPayload: fileItem({ changes }) });
    expect(workEntryFileActionLabel(value)).toBe("Edited a.ts and 2 files");
    expect(workEntryFileAction(value)?.paths).toEqual(["src/a.ts", "lib/b.ts", "lib/c.ts"]);
  });

  it("does not describe a mixed create/delete group as all created", () => {
    const value = entry({
      structuredPayload: fileItem({
        changes: [
          { operation: "create", path: "src/a.ts" },
          { operation: "delete", path: "src/b.ts" },
        ],
      }),
    });
    expect(workEntryFileActionLabel(value)).toBe("Changed a.ts and 1 file");
  });

  it("uses retained file-change paths when change details are absent", () => {
    const value = entry({ itemType: "file_change", changedFiles: ["src/a.ts", "src/b.ts"] });
    expect(workEntryFileActionLabel(value)).toBe("Changed a.ts and 1 file");
  });

  it("supports explicit multi-file read inputs", () => {
    const value = dynamicEntry("read_multiple_files", {
      paths: ["src/a.ts", "lib/a.ts", "src/a.ts"],
    });
    expect(workEntryFileActionLabel(value)).toBe("Read a.ts and 1 file");
    expect(workEntryFileAction(value)?.paths).toEqual(["src/a.ts", "lib/a.ts"]);
  });
});

describe("file action statuses", () => {
  it.each([
    ["inProgress", "Editing a.ts"],
    ["completed", "Edited a.ts"],
    ["failed", "Failed to edit a.ts"],
    ["declined", "Declined to edit a.ts"],
    ["stopped", "Stopped editing a.ts"],
    ["idle", "Edit a.ts"],
    [undefined, "Edit a.ts"],
  ] as const)("preserves %s lifecycle status", (toolLifecycleStatus, expected) => {
    const { toolLifecycleStatus: _status, ...value } = entry({
      toolTitle: "Edit",
      toolData: { input: { file_path: "src/a.ts" } },
    });
    expect(
      workEntryFileActionLabel(
        toolLifecycleStatus === undefined ? value : { ...value, toolLifecycleStatus },
      ),
    ).toBe(expected);
  });

  it.each([
    ["running", "Editing a.ts"],
    ["pending", "Editing a.ts"],
    ["waiting", "Waiting to edit a.ts"],
    ["completed", "Edited a.ts"],
    ["failed", "Failed to edit a.ts"],
    ["cancelled", "Stopped editing a.ts"],
    ["interrupted", "Stopped editing a.ts"],
    ["idle", "Edit a.ts"],
  ] as const)(
    "preserves %s structured status even with a stale completed lifecycle",
    (status, expected) => {
      const value = entry({
        structuredPayload: fileItem({
          status,
          changes: [{ operation: "edit", path: "src/a.ts" }],
        }),
        ...(status === "idle" ? { toolLifecycleStatus: "idle" as const } : {}),
      });
      expect(workEntryFileActionLabel(value)).toBe(expected);
    },
  );

  it("preserves error tone even when the provider reported completion", () => {
    expect(
      workEntryFileActionLabel({
        ...dynamicEntry("Write", { file_path: "src/a.ts" }),
        tone: "error",
      }),
    ).toBe("Failed to write a.ts");
  });
});
