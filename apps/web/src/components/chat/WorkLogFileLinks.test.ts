import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../rightPanelStore", () => ({ useRightPanelStore: {} }));
vi.mock("../../state/entities", () => ({ useProject: vi.fn(), useQuietThreadShell: vi.fn() }));

import { resolveWorkLogFileLink } from "./WorkLogFileLinks";

describe("resolveWorkLogFileLink", () => {
  it.each([
    ["src/app.ts", "/repo", "src/app.ts", "/repo/src/app.ts"],
    ["/repo/src/app.ts", "/repo", "src/app.ts", "/repo/src/app.ts"],
    ["/src/app.ts", "/", "src/app.ts", "/src/app.ts"],
    ["src/app.ts", "D:\\repo", "src/app.ts", "D:\\repo\\src\\app.ts"],
    ["d:\\REPO\\src\\app.ts", "D:\\repo", "src/app.ts", "d:\\REPO\\src\\app.ts"],
    ["/D:/repo/src/app.ts", "D:\\repo", "src/app.ts", "D:/repo/src/app.ts"],
    ["src/app.ts", "/D:/repo", "src/app.ts", "D:/repo\\src\\app.ts"],
    [
      "\\\\HOST\\share\\repo\\src\\app.ts",
      "\\\\host\\share\\repo",
      "src/app.ts",
      "\\\\HOST\\share\\repo\\src\\app.ts",
    ],
  ])("resolves %s against workspace %s", (path, root, panelPath, title) => {
    expect(resolveWorkLogFileLink(path, root)).toEqual({
      basename: "app.ts",
      panelPath,
      title,
      line: undefined,
    });
  });

  it.each([
    ["/other/src/app.ts", "/repo"],
    ["/repo-other/src/app.ts", "/repo"],
    ["/REPO/src/app.ts", "/repo"],
    ["C:\\other\\app.ts", "D:\\repo"],
    ["D:\\repo-old\\app.ts", "D:\\repo"],
    ["~/app.ts", "/repo"],
    ["~\\app.ts", "D:\\repo"],
  ])("preserves host path %s rather than redirecting to workspace %s", (path, root) => {
    const link = resolveWorkLogFileLink(path, root);
    expect(link?.panelPath).toBe(path);
    expect(link?.title).toBe(path);
  });

  it("keeps historical workspace paths tied to their original location", () => {
    expect(resolveWorkLogFileLink("/old-worktree/src/app.ts", "/current-worktree")?.panelPath).toBe(
      "/old-worktree/src/app.ts",
    );
    expect(resolveWorkLogFileLink("src/app.ts", "/source-worktree")?.title).toBe(
      "/source-worktree/src/app.ts",
    );
  });

  it("resolves inherited links to absolute source paths for the active sidebar", () => {
    expect(resolveWorkLogFileLink("src/app.ts", "/source-worktree", true)?.panelPath).toBe(
      "/source-worktree/src/app.ts",
    );
    expect(resolveWorkLogFileLink("src/app.ts", "D:\\source-worktree", true)?.panelPath).toBe(
      "D:\\source-worktree\\src\\app.ts",
    );
  });

  it("preserves traversal paths as host paths for the server to resolve", () => {
    expect(resolveWorkLogFileLink("../other/app.ts", "/repo")?.panelPath).toBe(
      "/repo/../other/app.ts",
    );
    expect(resolveWorkLogFileLink("D:\\repo\\..\\other\\app.ts", "D:\\repo")?.panelPath).toBe(
      "D:\\repo\\..\\other\\app.ts",
    );
  });

  it("retains the reveal line without including it in the file path", () => {
    expect(resolveWorkLogFileLink("D:\\repo\\app.ts:42:7", "D:\\repo")).toEqual({
      basename: "app.ts",
      panelPath: "app.ts",
      title: "D:\\repo\\app.ts:42:7",
      line: 42,
    });
  });

  it("leaves relative paths unavailable without an absolute workspace", () => {
    expect(resolveWorkLogFileLink("src/app.ts")?.panelPath).toBeNull();
    expect(resolveWorkLogFileLink("src/app.ts", "repo")?.panelPath).toBeNull();
    expect(resolveWorkLogFileLink("/repo/app.ts")?.panelPath).toBe("/repo/app.ts");
  });

  it("does not open the workspace root as a file", () => {
    expect(resolveWorkLogFileLink("/repo", "/repo")?.panelPath).toBeNull();
    for (const path of ["", " ", ".", "..", "./", "../"]) {
      expect(resolveWorkLogFileLink(path, "/repo")).toBeNull();
    }
  });
});
