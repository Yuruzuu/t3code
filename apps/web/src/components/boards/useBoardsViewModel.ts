import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { boardThreadPageSize } from "@t3tools/client-runtime/message-board";
import {
  executeAtomQuery,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { BoardThreadDetail, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { useDiffPanelStore } from "../../diffPanelStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuerySelector } from "../../state/query";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { boardAgentActivity } from "./boardActivity";
import { boardMainPostContent } from "./boardDiscussion";
import { messageBoardAtoms } from "./boardState";
import {
  boardTabAfterClosing,
  selectBoardTabs,
  selectCollapsedChannels,
  useBoardViewStore,
} from "./boardViewStore";
import type { BoardsViewModel } from "./boardsViewModel";

const route = getRouteApi("/_chat/boards");
const emptyChannels = Atom.make<BoardsViewModel["channels"]>(null);
const emptyPage = Atom.make(null);
const emptyThread = Atom.make<BoardsViewModel["thread"]>(null);
const emptyHandlingAgents = Atom.make<BoardsViewModel["handlingAgents"]>([]);
const handlingAgents = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): BoardsViewModel["handlingAgents"] =>
    get(environmentThreadShells.environmentThreadsAtom(environmentId))
      .filter((thread) => thread.deletedAt === null)
      .map((thread) => ({
        kind: "agent",
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        driver: null,
      })),
  ),
);
const emptyActivities = Atom.make<ReadonlyMap<ThreadId, string>>(new Map<ThreadId, string>());
const queryError = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null;
/** Working agents and their activity, kept identical while nothing changed so rows don't re-render. */
const agentActivities = Atom.family((environmentId: EnvironmentId) => {
  let previous: ReadonlyMap<ThreadId, string> = new Map();
  return Atom.make((get) => {
    const next = new Map<ThreadId, string>();
    for (const thread of get(environmentThreadShells.environmentThreadsAtom(environmentId))) {
      const items =
        thread.status === "running"
          ? get(
              environmentThreadDetails.visibleTurnItemsAtom(
                scopeThreadRef(environmentId, thread.id),
              ),
            )
          : [];
      const activity = boardAgentActivity(thread, items);
      if (activity !== null) next.set(thread.id, activity);
    }
    if (
      next.size === previous.size &&
      [...next].every(([id, activity]) => previous.get(id) === activity)
    )
      return previous;
    previous = next;
    return next;
  });
});

function requireSuccess<A, E>(result: AtomCommandResult<A, E>): A {
  if (AsyncResult.isSuccess(result)) return result.value;
  throw squashAtomCommandFailure(result);
}

export function useBoardsViewModel(): BoardsViewModel {
  const search = route.useSearch();
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = search.environmentId ?? primaryEnvironmentId;
  const environment = useEnvironment(environmentId);
  const availableHandlingAgents = useAtomValue(
    environmentId === null ? emptyHandlingAgents : handlingAgents(environmentId),
  );
  const canManageHandling = useAtomValue(
    messageBoardAtoms.assignLead.permissionAtom(environmentId),
  );
  const channels = useAtomValue(
    environmentId === null ? emptyChannels : messageBoardAtoms.channels(environmentId),
  );
  const tabs = useBoardViewStore(selectBoardTabs(environmentId));
  const collapsedChannels = useBoardViewStore(selectCollapsedChannels(environmentId));
  const selectedRootId = search.thread ?? null;
  const loadedThread = useAtomValue(
    environmentId === null || selectedRootId === null
      ? emptyThread
      : messageBoardAtoms.thread(environmentId, selectedRootId),
  );
  const selectedChannelName = search.channel ?? loadedThread?.summary.root.channelName ?? null;
  const threadSort = search.boardSort ?? "activity";
  const page = useAtomValue(
    environmentId === null || selectedChannelName === null
      ? emptyPage
      : messageBoardAtoms.threads(environmentId, selectedChannelName, threadSort),
  );
  const activities = useAtomValue(
    environmentId === null ? emptyActivities : agentActivities(environmentId),
  );
  const listed = page?.threads.find((summary) => summary.root.id === selectedRootId);
  // Opening from the list shows the opening post at once while the replies load.
  const thread: BoardThreadDetail | null =
    loadedThread ?? (listed ? { summary: listed, members: [], posts: [listed.root] } : null);
  const channelError = useEnvironmentQuerySelector(
    environmentId === null ? null : messageBoardAtoms.channelQuery({ environmentId, input: {} }),
    queryError,
  );
  const threadsError = useEnvironmentQuerySelector(
    environmentId === null || selectedChannelName === null
      ? null
      : messageBoardAtoms.threadQuery({
          environmentId,
          input: { channelName: selectedChannelName, sort: threadSort, limit: 30 },
        }),
    queryError,
  );
  const detailError = useEnvironmentQuerySelector(
    environmentId === null || selectedRootId === null
      ? null
      : messageBoardAtoms.detailQuery({
          environmentId,
          input: { rootId: selectedRootId, limit: boardThreadPageSize },
        }),
    queryError,
  );
  const eventError = useEnvironmentQuerySelector(
    environmentId === null ? null : messageBoardAtoms.events(environmentId),
    queryError,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [olderPostsRequests, setOlderPostsRequests] = useState<ReadonlySet<string>>(new Set());
  const loadingOlderPosts = useRef(new Set<string>());
  const loadingMore = useRef(false);
  const isConnected = environment?.connection.phase === "connected";
  const openRootId = loadedThread?.summary.root.id ?? null;
  const lastActivityAt = loadedThread?.summary.lastActivityAt;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The open discussion's read marker follows server activity and tab visibility.
  useEffect(() => {
    if (
      environmentId === null ||
      openRootId === null ||
      lastActivityAt === undefined ||
      !isConnected
    )
      return;
    let current = true;
    // Posts only count as read while someone can see them.
    const markRead = () => {
      if (document.visibilityState !== "visible") return;
      void messageBoardAtoms.markRead
        .run(appAtomRegistry, { environmentId, input: { rootId: openRootId } })
        .then((result) => {
          if (current && AsyncResult.isFailure(result))
            setActionError(formatEnvironmentQueryError(result.cause));
        });
    };
    markRead();
    document.addEventListener("visibilitychange", markRead);
    return () => {
      current = false;
      document.removeEventListener("visibilitychange", markRead);
    };
  }, [environmentId, openRootId, lastActivityAt, isConnected]);

  const openRoot = thread?.summary.root ?? null;
  const openTitle = openRoot === null ? null : boardMainPostContent(openRoot).title;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Every way into a discussion ends at this URL, including links from outside the boards view, and each gets a tab in the persisted store.
  useEffect(() => {
    if (environmentId === null || openRoot === null || openTitle === null) return;
    useBoardViewStore.getState().openTab(environmentId, {
      rootId: openRoot.id,
      channelName: openRoot.channelName,
      title: openTitle,
      author: openRoot.author,
    });
  }, [environmentId, openRoot, openTitle]);

  const updateSearch = (update: Partial<Omit<typeof search, "environmentId">>) => {
    void navigate({
      to: "/boards",
      search: { ...search, ...(environmentId === null ? {} : { environmentId }), ...update },
    });
  };
  const runAction = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The board request failed.");
      throw error;
    }
  };
  return {
    environmentId,
    channels,
    canManageHandling,
    handlingAgents: availableHandlingAgents,
    selectedChannelName,
    threads: page?.threads ?? null,
    threadSort,
    onChangeThreadSort: (boardSort) => updateSearch({ boardSort }),
    hasMoreThreads: page?.nextCursor != null,
    onLoadMoreThreads: () =>
      runAction(async () => {
        if (
          environmentId === null ||
          selectedChannelName === null ||
          !page?.nextCursor ||
          loadingMore.current
        )
          return;
        loadingMore.current = true;
        const result = await executeAtomQuery(
          appAtomRegistry,
          messageBoardAtoms.threadQuery({
            environmentId,
            input: {
              channelName: selectedChannelName,
              sort: threadSort,
              limit: 30,
              cursor: page.nextCursor,
            },
          }),
        );
        loadingMore.current = false;
        requireSuccess(result);
      }),
    selectedRootId,
    thread,
    threadPending: selectedRootId !== null && loadedThread === null && detailError === null,
    threadError: detailError,
    hasOlderPosts: loadedThread?.olderPostsCursor != null,
    loadingOlderPosts:
      selectedRootId !== null &&
      olderPostsRequests.has(JSON.stringify([environmentId, selectedRootId])),
    onLoadOlderPosts: () => {
      const cursor = loadedThread?.olderPostsCursor;
      if (environmentId === null || selectedRootId === null || !cursor) return;
      const requestKey = JSON.stringify([environmentId, selectedRootId]);
      if (loadingOlderPosts.current.has(requestKey)) return;
      loadingOlderPosts.current.add(requestKey);
      setOlderPostsRequests(new Set(loadingOlderPosts.current));
      void runAction(async () => {
        try {
          requireSuccess(
            await executeAtomQuery(
              appAtomRegistry,
              messageBoardAtoms.detailQuery({
                environmentId,
                input: {
                  rootId: selectedRootId,
                  limit: boardThreadPageSize,
                  cursor,
                },
              }),
              { refresh: true },
            ),
          );
        } finally {
          loadingOlderPosts.current.delete(requestKey);
          setOlderPostsRequests(new Set(loadingOlderPosts.current));
        }
      }).catch(() => {});
    },
    onSelectChannel: (channel) => updateSearch({ channel, thread: undefined }),
    onSelectThread: (rootId, channelName) =>
      updateSearch({ channel: channelName ?? selectedChannelName ?? undefined, thread: rootId }),
    onCloseThread: () =>
      updateSearch({ channel: selectedChannelName ?? undefined, thread: undefined }),
    tabs,
    onSelectTab: (tab) => updateSearch({ channel: tab.channelName, thread: tab.rootId }),
    onCloseTab: (rootId) => {
      if (environmentId === null) return;
      if (rootId === selectedRootId) {
        const next = boardTabAfterClosing(tabs, rootId);
        updateSearch({ channel: next?.channelName, thread: next?.rootId });
      }
      useBoardViewStore.getState().closeTab(environmentId, rootId);
    },
    onMoveTab: (rootId, toIndex) => {
      if (environmentId !== null)
        useBoardViewStore.getState().moveTab(environmentId, rootId, toIndex);
    },
    collapsedChannels,
    onToggleChannel: (channelName) => {
      if (environmentId !== null)
        useBoardViewStore.getState().toggleChannel(environmentId, channelName);
    },
    onShowAllChannels: () => updateSearch({ channel: undefined, thread: undefined }),
    onMarkChannelRead: (channelName) =>
      runAction(async () => {
        if (environmentId === null) throw new Error("Connect to an environment first.");
        requireSuccess(
          await messageBoardAtoms.markRead.run(appAtomRegistry, {
            environmentId,
            input: { channelName },
          }),
        );
      }),
    // The composer shows a failed post itself, so it never reaches the page banner.
    onPost: async (input) => {
      if (environmentId === null) throw new Error("Connect to an environment first.");
      try {
        const { post } = requireSuccess(
          await messageBoardAtoms.post.run(appAtomRegistry, { environmentId, input }),
        );
        if (post.rootId !== selectedRootId)
          updateSearch({ channel: post.channelName, thread: post.rootId });
      } catch (error) {
        if (input.destination.kind === "reply")
          appAtomRegistry.refresh(
            messageBoardAtoms.detailQuery({
              environmentId,
              input: { rootId: input.destination.rootId, limit: boardThreadPageSize },
            }),
          );
        throw error;
      }
    },
    onAssignLead: async (threadId) => {
      if (environmentId === null || loadedThread?.handling === undefined)
        throw new Error("Load the current discussion first.");
      try {
        requireSuccess(
          await messageBoardAtoms.assignLead.run(appAtomRegistry, {
            environmentId,
            input: {
              rootId: loadedThread.summary.root.id,
              expectedRevision: loadedThread.handling.revision,
              leadThreadId: threadId,
            },
          }),
        );
      } catch (error) {
        appAtomRegistry.refresh(
          messageBoardAtoms.detailQuery({
            environmentId,
            input: { rootId: loadedThread.summary.root.id, limit: boardThreadPageSize },
          }),
        );
        throw error;
      }
    },
    onUpdateContext: async (context) => {
      if (environmentId === null || loadedThread?.handling === undefined)
        throw new Error("Load the current discussion first.");
      try {
        requireSuccess(
          await messageBoardAtoms.updateContext.run(appAtomRegistry, {
            environmentId,
            input: {
              rootId: loadedThread.summary.root.id,
              expectedRevision: loadedThread.handling.revision,
              context,
            },
          }),
        );
      } catch (error) {
        appAtomRegistry.refresh(
          messageBoardAtoms.detailQuery({
            environmentId,
            input: { rootId: loadedThread.summary.root.id, limit: boardThreadPageSize },
          }),
        );
        throw error;
      }
    },
    onReassignRequest: async (request, recipientThreadId) => {
      if (environmentId === null || loadedThread?.handling === undefined)
        throw new Error("Load the current discussion first.");
      try {
        requireSuccess(
          await messageBoardAtoms.reassignRequest.run(appAtomRegistry, {
            environmentId,
            input: {
              rootId: loadedThread.summary.root.id,
              expectedRevision: loadedThread.handling.revision,
              responsibilityId: request.id,
              expectedGeneration: request.generation,
              recipientThreadId,
            },
          }),
        );
      } catch (error) {
        appAtomRegistry.refresh(
          messageBoardAtoms.detailQuery({
            environmentId,
            input: { rootId: loadedThread.summary.root.id, limit: boardThreadPageSize },
          }),
        );
        throw error;
      }
    },
    onResumeRequest: async (request) => {
      if (environmentId === null || loadedThread?.handling === undefined)
        throw new Error("Load the current discussion first.");
      try {
        requireSuccess(
          await messageBoardAtoms.resumeRequest.run(appAtomRegistry, {
            environmentId,
            input: {
              rootId: loadedThread.summary.root.id,
              expectedRevision: loadedThread.handling.revision,
              responsibilityId: request.id,
              expectedGeneration: request.generation,
            },
          }),
        );
      } catch (error) {
        appAtomRegistry.refresh(
          messageBoardAtoms.detailQuery({
            environmentId,
            input: { rootId: loadedThread.summary.root.id, limit: boardThreadPageSize },
          }),
        );
        throw error;
      }
    },
    onCloseDiscussion: async () => {
      if (environmentId === null || loadedThread?.handling === undefined)
        throw new Error("Load the current discussion first.");
      try {
        requireSuccess(
          await messageBoardAtoms.closeDiscussion.run(appAtomRegistry, {
            environmentId,
            input: {
              rootId: loadedThread.summary.root.id,
              expectedRevision: loadedThread.handling.revision,
            },
          }),
        );
      } catch (error) {
        appAtomRegistry.refresh(
          messageBoardAtoms.detailQuery({
            environmentId,
            input: { rootId: loadedThread.summary.root.id, limit: boardThreadPageSize },
          }),
        );
        throw error;
      }
    },
    onReopenDiscussion: async () => {
      if (environmentId === null || loadedThread?.handling === undefined)
        throw new Error("Load the current discussion first.");
      try {
        requireSuccess(
          await messageBoardAtoms.reopenDiscussion.run(appAtomRegistry, {
            environmentId,
            input: {
              rootId: loadedThread.summary.root.id,
              expectedRevision: loadedThread.handling.revision,
            },
          }),
        );
      } catch (error) {
        appAtomRegistry.refresh(
          messageBoardAtoms.detailQuery({
            environmentId,
            input: { rootId: loadedThread.summary.root.id, limit: boardThreadPageSize },
          }),
        );
        throw error;
      }
    },
    onReact: (postId, emoji, active) => {
      if (environmentId === null) return;
      void runAction(async () => {
        requireSuccess(
          await messageBoardAtoms.react.run(appAtomRegistry, {
            environmentId,
            input: { postId, emoji, active },
          }),
        );
      }).catch(() => {});
    },
    onOpenAgentThread: (author) => {
      if (author.kind !== "agent" || environmentId === null) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: author.threadId },
      });
    },
    onOpenRunChanges: (threadId, runId, filePath) => {
      if (environmentId === null) return;
      const threadRef = scopeThreadRef(environmentId, threadId);
      useDiffPanelStore.getState().selectTurn(threadRef, runId, filePath);
      useRightPanelStore.getState().open(threadRef, "diff");
      void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
    },
    onRefreshThread: () => {
      if (environmentId === null || selectedRootId === null) return;
      appAtomRegistry.refresh(
        messageBoardAtoms.detailQuery({
          environmentId,
          input: { rootId: selectedRootId, limit: boardThreadPageSize },
        }),
      );
    },
    isAgentThreadRunning: (threadId) => activities.has(threadId),
    agentActivity: (threadId) => activities.get(threadId) ?? null,
    isConnected,
    error: actionError ?? channelError ?? threadsError ?? eventError,
  };
}
