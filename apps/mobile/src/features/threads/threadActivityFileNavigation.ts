import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  fileRoutePathSegments,
  isAbsolutePath,
  resolveFileLinkPath,
  resolveWorkspaceFilePath,
} from "../files/filePath";

interface ThreadActivityFileContext {
  readonly environmentId: EnvironmentId;
  readonly currentThreadId: ThreadId;
  readonly activitySourceThreadId: ThreadId;
  readonly relativePath: string;
  readonly line?: number | null;
}

export function buildThreadActivityFileParams(input: ThreadActivityFileContext) {
  return {
    environmentId: String(input.environmentId),
    threadId: String(input.currentThreadId),
    path: fileRoutePathSegments(input.relativePath),
    ...(Number.isFinite(input.line) && Number(input.line) > 0
      ? { line: String(Math.floor(Number(input.line))) }
      : {}),
  };
}

export function resolveThreadActivityFileParams(
  input: Omit<ThreadActivityFileContext, "relativePath"> & {
    readonly filePath: string;
    readonly sourceWorkspaceRoot: string | null | undefined;
  },
) {
  if (!input.filePath.trim()) return null;

  const workspaceRoot = input.sourceWorkspaceRoot;
  const isHomePath = input.filePath.startsWith("~/") || input.filePath.startsWith("~\\");
  // Anchor traversal before relative-path normalization can discard an outside target.
  const anchoredPath =
    workspaceRoot && !isHomePath
      ? resolveWorkspaceFilePath(workspaceRoot, input.filePath)
      : input.filePath;
  const path = resolveFileLinkPath(workspaceRoot, anchoredPath);
  if (path === null || !isAbsolutePath(path)) return null;

  return {
    ...buildThreadActivityFileParams({ ...input, relativePath: path }),
    ...(workspaceRoot ? { cwd: workspaceRoot } : {}),
  };
}
