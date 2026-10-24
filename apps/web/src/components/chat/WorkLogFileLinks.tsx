import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { formatFilePathPosition, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  fileBasename,
  isAbsolutePath,
  isHostPath,
  resolveWorkspaceFilePath,
  stripSlashPrefixedWindowsDrive,
  workspaceRelativeFilePath,
} from "@t3tools/shared/path";

import { useRightPanelStore } from "../../rightPanelStore";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function resolveWorkLogFileLink(path: string, workspaceRoot?: string, absolute = false) {
  const position = splitFilePathPosition(path);
  const filePath = stripSlashPrefixedWindowsDrive(position.path);
  const basename = fileBasename(filePath);
  if (!filePath.trim() || basename === "." || basename === "..") return null;

  const root = workspaceRoot ? stripSlashPrefixedWindowsDrive(workspaceRoot) : undefined;
  const absolutePath =
    isHostPath(filePath) || filePath.startsWith("~\\")
      ? filePath
      : root && isAbsolutePath(root)
        ? resolveWorkspaceFilePath(filePath, root)
        : null;
  // Keep host paths intact: basename lookup could silently open a different file.
  const relativePath = absolutePath ? workspaceRelativeFilePath(absolutePath, root) : null;
  const panelPath =
    !absolute && relativePath && !relativePath.split(/[\\/]/).includes("..")
      ? relativePath
      : absolutePath;

  return {
    basename,
    panelPath: panelPath === "." ? null : panelPath,
    title: formatFilePathPosition({ ...position, path: absolutePath ?? filePath }),
    line: position.line,
  };
}

function useSourceWorkspaceRoot(
  environmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  workspaceRoot: string | undefined,
) {
  const thread = useQuietThreadShell(scopeThreadRef(environmentId, sourceThreadId));
  const project = useProject(thread ? { environmentId, projectId: thread.projectId } : null);
  return thread?.worktreePath ?? project?.workspaceRoot ?? workspaceRoot;
}

/** Inline file name inside a row label; opens the file sidebar without toggling the row. */
export function WorkLogFileName({
  path,
  label,
  environmentId,
  threadId,
  sourceThreadId = threadId,
  workspaceRoot,
}: {
  path: string;
  label: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  sourceThreadId?: ThreadId | undefined;
  workspaceRoot?: string | undefined;
}) {
  const sourceWorkspaceRoot = useSourceWorkspaceRoot(environmentId, sourceThreadId, workspaceRoot);
  const link = resolveWorkLogFileLink(path, sourceWorkspaceRoot, sourceThreadId !== threadId);
  const panelPath = link?.panelPath ?? null;
  if (!link || panelPath === null) return <span className="text-foreground">{label}</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="cursor-pointer rounded-sm text-foreground underline decoration-foreground/40 underline-offset-2 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
          />
        }
        aria-label={`Open ${link.basename} in file sidebar`}
        onClick={(event) => {
          event.stopPropagation();
          useRightPanelStore
            .getState()
            .openFile(scopeThreadRef(environmentId, threadId), panelPath, link.line);
        }}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup variant="code">{link.title}</TooltipPopup>
    </Tooltip>
  );
}

/** One quiet line: the folder fades back so the clickable file name carries the header. */
export function WorkLogFilePathHeader({
  displayPath,
  ...link
}: Omit<ComponentProps<typeof WorkLogFileName>, "label"> & { displayPath: string }) {
  const name = fileBasename(displayPath);
  const folder = displayPath.slice(0, displayPath.length - name.length);
  return (
    <span className="flex max-w-3/5 min-w-0 items-baseline font-mono text-2xs">
      {/* The folder gives way first; the name truncates only once the folder is gone. */}
      {folder ? (
        <span className="min-w-0 shrink-100 truncate text-muted-foreground/70">{folder}</span>
      ) : null}
      <span className="min-w-0 truncate">
        <WorkLogFileName {...link} label={name} />
      </span>
    </span>
  );
}

export function WorkLogFileLinks({
  paths,
  environmentId,
  threadId,
  sourceThreadId = threadId,
  workspaceRoot,
}: {
  paths: ReadonlyArray<string>;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  sourceThreadId?: ThreadId | undefined;
  workspaceRoot?: string | undefined;
}) {
  const threadRef = scopeThreadRef(environmentId, threadId);
  const sourceWorkspaceRoot = useSourceWorkspaceRoot(environmentId, sourceThreadId, workspaceRoot);

  return (
    <span className="inline-flex max-w-full flex-wrap items-baseline gap-x-1.5 gap-y-1 align-baseline font-mono">
      {[...new Set(paths)].map((path) => {
        const link = resolveWorkLogFileLink(path, sourceWorkspaceRoot, sourceThreadId !== threadId);
        if (!link) return null;

        const panelPath = link.panelPath;
        return (
          <Tooltip key={path}>
            {panelPath === null ? (
              <TooltipTrigger
                render={<strong className="break-all font-semibold text-foreground" />}
              >
                {link.basename}
              </TooltipTrigger>
            ) : (
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="max-w-full cursor-pointer rounded-sm bg-primary/10 px-1 py-0.5 text-left font-semibold break-all text-foreground underline-offset-2 hover:bg-primary/15 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  />
                }
                aria-label={`Open ${link.basename} in file sidebar`}
                onClick={(event) => {
                  event.stopPropagation();
                  useRightPanelStore.getState().openFile(threadRef, panelPath, link.line);
                }}
                onKeyDown={(event) => event.stopPropagation()}
                onKeyUp={(event) => event.stopPropagation()}
              >
                {link.basename}
              </TooltipTrigger>
            )}
            <TooltipPopup variant="code">{link.title}</TooltipPopup>
          </Tooltip>
        );
      })}
    </span>
  );
}
