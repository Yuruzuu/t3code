import { useAtomValue } from "@effect/atom-react";
import { executeAtomQuery, type AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  BoardAuthor,
  BoardPostId,
  BoardThreadDetail,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuerySelector } from "../../state/query";
import { environmentThreadShells } from "../../state/threads";
import { messageBoardAtoms } from "./boardState";
import type { BoardsViewModel } from "./boardsViewModel";

const route = getRouteApi("/_chat/boards");
const emptyChannels = Atom.make<BoardsViewModel["channels"]>(null);
const emptyPage = Atom.make(null);
const emptyThread = Atom.make<BoardsViewModel["thread"]>(null);
const emptyDetails = Atom.make<Readonly<Record<string, BoardThreadDetail>>>({});
const emptyRunning = Atom.make<ReadonlySet<ThreadId>>(new Set<ThreadId>());
const queryError = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null;
const runningThreads = Atom.family((environmentId: EnvironmentId) => {
  let previous: ReadonlySet<ThreadId> = new Set();
  return Atom.make((get) => {
    const next = new Set(
      get(environmentThreadShells.environmentThreadsAtom(environmentId))
        .filter((thread) => ["preparing", "queued", "starting", "running"].includes(thread.status))
        .map((thread) => thread.id),
    );
    if (next.size === previous.size && [...next].every((id) => previous.has(id))) return previous;
    previous = next;
    return next;
  });
});

function requireSuccess<A, E>(result: AtomCommandResult<A, E>): A {
  if (AsyncResult.isSuccess(result)) return result.value;
  throw new Error(formatEnvironmentQueryError(result.cause));
}

export function useBoardsViewModel(): BoardsViewModel {
  const search = route.useSearch();
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = search.environmentId ?? primaryEnvironmentId;
  const environment = useEnvironment(environmentId);
  const channels = useAtomValue(
    environmentId === null ? emptyChannels : messageBoardAtoms.channels(environmentId),
  );
  const selectedRootId = search.thread ?? null;
  const thread = useAtomValue(
    environmentId === null || selectedRootId === null
      ? emptyThread
      : messageBoardAtoms.thread(environmentId, selectedRootId),
  );
  const selectedChannelName = search.channel ?? thread?.summary.root.channelName ?? null;
  const threadSort = search.boardSort ?? "activity";
  const page = useAtomValue(
    environmentId === null || selectedChannelName === null
      ? emptyPage
      : messageBoardAtoms.threads(environmentId, selectedChannelName, threadSort),
  );
  const running = useAtomValue(
    environmentId === null ? emptyRunning : runningThreads(environmentId),
  );
  const details = useAtomValue(
    environmentId === null ? emptyDetails : messageBoardAtoms.details(environmentId),
  );
  const workingByRoot = new Map<BoardPostId, readonly BoardAuthor[]>();
  for (const summary of page?.threads ?? []) {
    const detail = details[summary.root.id];
    const authors = detail?.members.map((member) => member.author) ?? summary.participants;
    const typing = authors.filter(
      (author) => author.kind === "agent" && running.has(author.threadId),
    );
    if (typing.length > 0) workingByRoot.set(summary.root.id, typing);
  }
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
      : messageBoardAtoms.detailQuery({ environmentId, input: { rootId: selectedRootId } }),
    queryError,
  );
  const eventError = useEnvironmentQuerySelector(
    environmentId === null ? null : messageBoardAtoms.events(environmentId),
    queryError,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const loadingMore = useRef(false);
  const isConnected = environment?.connection.phase === "connected";
  const openRootId = thread?.summary.root.id ?? null;
  const lastActivityAt = thread?.summary.lastActivityAt;

  // oxlint-disable-next-line t3code/react-effect-budget -- The open discussion's read marker follows server activity.
  useEffect(() => {
    if (
      environmentId === null ||
      openRootId === null ||
      lastActivityAt === undefined ||
      !isConnected
    )
      return;
    let current = true;
    void messageBoardAtoms.markRead
      .run(appAtomRegistry, { environmentId, input: { rootId: openRootId } })
      .then((result) => {
        if (current && AsyncResult.isFailure(result))
          setActionError(formatEnvironmentQueryError(result.cause));
      });
    return () => {
      current = false;
    };
  }, [environmentId, openRootId, lastActivityAt, isConnected]);

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
    channels,
    selectedChannelName,
    threads: page?.threads ?? null,
    workingByRoot,
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
    onSelectChannel: (channel) => updateSearch({ channel, thread: undefined }),
    onSelectThread: (rootId) =>
      updateSearch({ channel: selectedChannelName ?? undefined, thread: rootId }),
    onCloseThread: () => updateSearch({ thread: undefined }),
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
    onPost: (input) =>
      runAction(async () => {
        if (environmentId === null) throw new Error("Connect to an environment first.");
        const post = requireSuccess(
          await messageBoardAtoms.post.run(appAtomRegistry, { environmentId, input }),
        );
        updateSearch({ channel: post.channelName, thread: post.rootId });
      }),
    onOpenAgentThread: (author) => {
      if (author.kind !== "agent" || environmentId === null) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: author.threadId },
      });
    },
    isAgentThreadRunning: (threadId) => running.has(threadId),
    isConnected,
    error: actionError ?? channelError ?? threadsError ?? detailError ?? eventError,
  };
}
