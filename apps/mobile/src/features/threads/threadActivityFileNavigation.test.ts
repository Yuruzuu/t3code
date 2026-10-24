import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "node:path";

import {
  buildThreadActivityFileParams,
  resolveThreadActivityFileParams,
} from "./threadActivityFileNavigation";
import { resolveWorkspaceFilePath } from "../files/filePath";

describe("thread activity file navigation", () => {
  it("keeps inherited activity file links on the currently selected thread", () => {
    const sourceThreadId = ThreadId.make("source-thread");
    const currentThreadId = ThreadId.make("current-thread");

    const params = buildThreadActivityFileParams({
      environmentId: EnvironmentId.make("environment"),
      currentThreadId,
      activitySourceThreadId: sourceThreadId,
      relativePath: "apps/mobile/src/index.ts",
      line: 12,
    });

    expect(params).toEqual({
      environmentId: "environment",
      threadId: "current-thread",
      path: ["apps", "mobile", "src", "index.ts"],
      line: "12",
    });
  });

  it.each([
    ["../sibling/file.ts", "/repo/source/../sibling/file.ts", "/repo/sibling/file.ts"],
    [
      "src/../../sibling/file.ts",
      "/repo/source/src/../../sibling/file.ts",
      "/repo/sibling/file.ts",
    ],
    ["src/main.ts", "/repo/source/src/main.ts", "/repo/source/src/main.ts"],
    ["/other/file.ts", "/other/file.ts", "/other/file.ts"],
    ["src/file#1%.ts", "/repo/source/src/file#1%.ts", "/repo/source/src/file#1%.ts"],
  ])(
    "anchors inherited %s to its source workspace while keeping the current thread",
    (filePath, absolutePath, targetPath) => {
      const params = resolveThreadActivityFileParams({
        environmentId: EnvironmentId.make("environment"),
        currentThreadId: ThreadId.make("current-thread"),
        activitySourceThreadId: ThreadId.make("source-thread"),
        sourceWorkspaceRoot: "/repo/source",
        filePath,
        line: 12,
      });

      expect(params).toMatchObject({ threadId: "current-thread", cwd: "/repo/source", line: "12" });
      expect(params?.path.join("/")).toBe(absolutePath);
      expect(params?.path[0]).toBe("");
      // The file screen resolves against its cwd; an absolute route must also survive another selection.
      expect(
        NodePath.posix.normalize(
          resolveWorkspaceFilePath("/unrelated/current-worktree", params!.path.join("/")),
        ),
      ).toBe(targetPath);
    },
  );

  it("anchors Windows traversal without losing its drive or backslashes", () => {
    const params = resolveThreadActivityFileParams({
      environmentId: EnvironmentId.make("environment"),
      currentThreadId: ThreadId.make("current-thread"),
      activitySourceThreadId: ThreadId.make("source-thread"),
      sourceWorkspaceRoot: "C:\\repo\\source",
      filePath: "..\\sibling\\file.ts",
    });

    expect(params?.threadId).toBe("current-thread");
    expect(params?.path.join("/")).toBe("C:\\repo\\source\\..\\sibling\\file.ts");
    expect(
      NodePath.win32.normalize(resolveWorkspaceFilePath("D:\\unrelated", params!.path.join("/"))),
    ).toBe("C:\\repo\\sibling\\file.ts");
  });

  it("resolves every rename and multi-file target independently", () => {
    const paths = ["../sibling/new.ts", "../sibling/old.ts", "src/another.ts"];
    const params = paths.map((filePath) =>
      resolveThreadActivityFileParams({
        environmentId: EnvironmentId.make("environment"),
        currentThreadId: ThreadId.make("current-thread"),
        activitySourceThreadId: ThreadId.make("source-thread"),
        sourceWorkspaceRoot: "/repo/source",
        filePath,
      }),
    );

    expect(params.map((entry) => NodePath.posix.normalize(entry!.path.join("/")))).toEqual([
      "/repo/sibling/new.ts",
      "/repo/sibling/old.ts",
      "/repo/source/src/another.ts",
    ]);
    expect(params.every((entry) => entry?.threadId === "current-thread")).toBe(true);
  });

  it("expands home paths using the source workspace", () => {
    const params = resolveThreadActivityFileParams({
      environmentId: EnvironmentId.make("environment"),
      currentThreadId: ThreadId.make("current-thread"),
      activitySourceThreadId: ThreadId.make("source-thread"),
      sourceWorkspaceRoot: "/home/maria/source",
      filePath: "~/.agents/AGENTS.md",
    });

    expect(params?.path.join("/")).toBe("/home/maria/.agents/AGENTS.md");
  });

  it("keeps known absolute targets usable without guessing an unavailable source workspace", () => {
    const context = {
      environmentId: EnvironmentId.make("environment"),
      currentThreadId: ThreadId.make("current-thread"),
      activitySourceThreadId: ThreadId.make("source-thread"),
      sourceWorkspaceRoot: null,
    };
    expect(
      resolveThreadActivityFileParams({ ...context, filePath: "../sibling/file.ts" }),
    ).toBeNull();
    expect(resolveThreadActivityFileParams({ ...context, filePath: "src/file.ts" })).toBeNull();
    expect(resolveThreadActivityFileParams({ ...context, filePath: "~/file.ts" })).toBeNull();
    expect(resolveThreadActivityFileParams({ ...context, filePath: "/known/file.ts" })).toEqual({
      environmentId: "environment",
      threadId: "current-thread",
      path: ["", "known", "file.ts"],
    });
  });
});
