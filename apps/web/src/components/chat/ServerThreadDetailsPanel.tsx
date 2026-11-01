import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import type { RefObject } from "react";

import { useDiffPanelStore } from "../../diffPanelStore";
import { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import { useRightPanelStore } from "../../rightPanelStore";
import { useProject, useThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
} from "../../state/server";
import { vcsEnvironment } from "../../state/vcs";
import { useRemoteOpenState } from "~/remoteOpen";
import { resolveEffectiveEnvMode } from "../BranchToolbar.logic";
import { recallCheckoutIsRepo } from "../ChatView.logic";
import type { PopoverCreateHandle } from "../ui/popover";
import { shouldShowOpenInPicker } from "./OpenInPicker.logic";
import { ThreadDetailsPanel } from "./ThreadDetailsPanel";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const noop = () => {};

/**
 * The thread details panel for an existing thread viewed outside its chat, such as from a
 * board discussion. Its workspace is already settled, so environment and branch are read-only,
 * and project scripts are left out because they run in the thread's own terminal.
 */
export function ServerThreadDetailsPanel({
  threadRef,
  anchor,
  handle,
}: {
  threadRef: ScopedThreadRef;
  anchor: RefObject<Element | null>;
  handle: ReturnType<typeof PopoverCreateHandle>;
}) {
  const navigate = useNavigate();
  const shell = useThreadShell(threadRef);
  const project = useProject(shell ? scopeProjectRef(shell.environmentId, shell.projectId) : null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const remoteOpenState = useRemoteOpenState(threadRef.environmentId);
  const environments = useLogicalProjectEnvironments(project, false);
  const worktreePath = shell?.worktreePath ?? null;
  const gitCwd = project
    ? projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath })
    : null;
  const statusCwd = worktreePath ?? gitCwd;
  const status = useEnvironmentQuery(
    statusCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId: threadRef.environmentId,
          input: { cwd: statusCwd },
        }),
  );
  const isGitRepo =
    status.data?.isRepo ?? recallCheckoutIsRepo(threadRef.environmentId, statusCwd) ?? true;
  if (!shell) return null;

  const openChanges = () => {
    useDiffPanelStore.getState().selectGitScope(threadRef, "branch");
    useRightPanelStore.getState().open(threadRef, "diff");
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
    });
  };

  return (
    <ThreadDetailsPanel
      anchor={anchor}
      handle={handle}
      environmentId={shell.environmentId}
      threadId={shell.id}
      projectId={shell.projectId}
      worktreePath={worktreePath}
      isServerThread
      activeProjectName={project?.title}
      relatedContent={
        <ThreadDetailsSection headingId="thread-details-chats-heading" title="Chats">
          <ThreadDetailsControl
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
              })
            }
            aria-label={`Open chat ${shell.title || "Untitled chat"}`}
          >
            <MessagesSquareIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className="min-w-0 flex-1 truncate">{shell.title || "Untitled chat"}</span>
          </ThreadDetailsControl>
        </ThreadDetailsSection>
      }
      keybindings={keybindings}
      availableEditors={availableEditors}
      showOpenInPicker={shouldShowOpenInPicker({
        activeProjectName: project?.title,
        activeThreadEnvironmentId: shell.environmentId,
        primaryEnvironmentId,
        remoteOpenMode: remoteOpenState.mode,
      })}
      openInShortcutEnabled={false}
      gitCwd={gitCwd}
      isGitRepo={isGitRepo}
      envLocked
      availableEnvironments={environments}
      envMode={resolveEffectiveEnvMode({
        activeWorktreePath: worktreePath,
        hasServerThread: true,
        draftThreadEnvMode: undefined,
      })}
      onEnvModeChange={noop}
      startFromOrigin={false}
      onStartFromOriginChange={noop}
      onComposerFocusRequest={noop}
      {...(isGitRepo ? { onOpenChanges: openChanges } : {})}
    />
  );
}
