import {
  WS_METHODS,
  type EnvironmentId,
  type BoardPostId,
  type BoardThreadSort,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  followStreamInEnvironment,
} from "../state/runtime.ts";
import {
  applyBoardEvent,
  boardPageKey,
  boardThreadUnreadCount,
  emptyBoardCache,
  mergeBoardChannels,
  mergeBoardDetail,
  mergeBoardThreadPage,
} from "./cache.ts";

export { applyBoardEvent, boardPageKey, emptyBoardCache } from "./cache.ts";
export type { BoardCache } from "./cache.ts";

export const boardThreadPageSize = 40;

export function createMessageBoardAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const cache = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(emptyBoardCache).pipe(Atom.withLabel(`message-board:cache:${environmentId}`)),
  );
  const channelQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "message-board:channels",
    tag: WS_METHODS.messageBoardListChannels,
    onAnswer: ({ environmentId }, channels, registry) =>
      Effect.sync(() => {
        registry.update(cache(environmentId), (current) => mergeBoardChannels(current, channels));
      }),
  });
  const threadQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "message-board:threads",
    tag: WS_METHODS.messageBoardListThreads,
    onAnswer: ({ environmentId, input }, result, registry) =>
      Effect.sync(() => {
        registry.update(cache(environmentId), (current) =>
          mergeBoardThreadPage(current, input, result),
        );
      }),
  });
  const detailQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "message-board:thread",
    tag: WS_METHODS.messageBoardReadThread,
    onAnswer: ({ environmentId, input }, detail, registry) =>
      Effect.sync(() => {
        registry.update(cache(environmentId), (current) =>
          mergeBoardDetail(current, detail, input),
        );
      }),
  });
  // Bumped by events that can change which discussions an agent is in, or their unread state.
  const membershipRevision = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`message-board:membership:${environmentId}`)),
  );
  const agentThreadsQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "message-board:agent-threads",
    tag: WS_METHODS.messageBoardListAgentThreads,
    refreshTrigger: ({ environmentId }) => membershipRevision(environmentId),
  });
  const events = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom((get) =>
        followStreamInEnvironment(
          environmentId,
          subscribe(WS_METHODS.messageBoardSubscribeEvents, {
            handling: true,
            responderSelections: true,
          }).pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                const state = cache(environmentId);
                const previous = get.registry.get(state);
                get.registry.update(state, (current) => applyBoardEvent(current, event));
                if (
                  event.type !== "channel-upserted" &&
                  event.type !== "reactions-changed" &&
                  event.type !== "todos-changed" &&
                  event.type !== "handling-changed"
                )
                  get.registry.update(
                    membershipRevision(environmentId),
                    (revision) => revision + 1,
                  );
                // Open discussions update in place from events; only list pages that lack the
                // replied-to discussion need a fetch.
                if (event.type !== "post-created" || event.post.id === event.post.rootId) return;
                for (const page of Object.values(previous.pages)) {
                  if (
                    page.channelName !== event.post.channelName ||
                    page.result.threads.some((item) => item.root.id === event.post.rootId)
                  )
                    continue;
                  get.registry.refresh(
                    threadQuery({
                      environmentId,
                      input: { channelName: page.channelName, sort: page.sort, limit: 30 },
                    }),
                  );
                }
              }),
            ),
          ),
        ),
      )
      .pipe(Atom.setIdleTTL(0), Atom.withLabel(`message-board:events:${environmentId}`)),
  );
  const channels = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      get.mount(events(environmentId));
      get(channelQuery({ environmentId, input: {} }));
      return get(cache(environmentId)).channels;
    }),
  );
  const unreadCount = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get) =>
        get(channels(environmentId))?.reduce((total, channel) => total + channel.unreadCount, 0) ??
        0,
    ),
  );
  const pageFamily = Atom.family((key: string) => {
    const [environmentId, channelName, sort] = JSON.parse(key) as [
      EnvironmentId,
      string,
      BoardThreadSort,
    ];
    return Atom.make((get) => {
      get.mount(events(environmentId));
      get(threadQuery({ environmentId, input: { channelName, sort, limit: 30 } }));
      return get(cache(environmentId)).pages[boardPageKey(channelName, sort)]?.result ?? null;
    });
  });
  const agentThreadsFamily = Atom.family((key: string) => {
    const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
    return Atom.make((get) => {
      get.mount(events(environmentId));
      return get(agentThreadsQuery({ environmentId, input: { threadId } }));
    });
  });
  const detailFamily = Atom.family((key: string) => {
    const [environmentId, rootId] = JSON.parse(key) as [EnvironmentId, BoardPostId];
    return Atom.make((get) => {
      get.mount(events(environmentId));
      get(detailQuery({ environmentId, input: { rootId, limit: boardThreadPageSize } }));
      return get(cache(environmentId)).details[rootId] ?? null;
    });
  });
  const threadUnreadFamily = Atom.family((key: string) => {
    const [environmentId, rootId] = JSON.parse(key) as [EnvironmentId, BoardPostId];
    return Atom.make((get) => {
      get(detailFamily(key));
      return boardThreadUnreadCount(get(cache(environmentId)), rootId);
    });
  });
  return {
    channels,
    unreadCount,
    threadUnreadCount: (environmentId: EnvironmentId, rootId: BoardPostId) =>
      threadUnreadFamily(JSON.stringify([environmentId, rootId])),
    events,
    channelQuery,
    threadQuery,
    detailQuery,
    threads: (environmentId: EnvironmentId, channelName: string, sort: BoardThreadSort) =>
      pageFamily(JSON.stringify([environmentId, channelName, sort])),
    /** Discussions the agent in `threadId` posted in or is subscribed to. */
    agentThreads: (environmentId: EnvironmentId, threadId: ThreadId) =>
      agentThreadsFamily(JSON.stringify([environmentId, threadId])),
    thread: (environmentId: EnvironmentId, rootId: BoardPostId) =>
      detailFamily(JSON.stringify([environmentId, rootId])),
    post: createEnvironmentRpcCommand(runtime, {
      label: "message-board:post",
      tag: WS_METHODS.messageBoardPost,
      onSuccess: ({ environmentId }, registry, { post }) =>
        Effect.sync(() => {
          registry.update(cache(environmentId), (current) =>
            applyBoardEvent(current, { type: "post-created", post }),
          );
        }),
    }),
    assignLead: createEnvironmentRpcCommand(runtime, {
      label: "message-board:assignLead",
      tag: WS_METHODS.messageBoardAssignLead,
      onSuccess: ({ environmentId }, registry, handling) =>
        Effect.sync(() => {
          registry.update(cache(environmentId), (current) =>
            applyBoardEvent(current, { type: "handling-changed", handling }),
          );
        }),
    }),
    updateContext: createEnvironmentRpcCommand(runtime, {
      label: "message-board:updateContext",
      tag: WS_METHODS.messageBoardUpdateContext,
      onSuccess: ({ environmentId }, registry, handling) =>
        Effect.sync(() => {
          registry.update(cache(environmentId), (current) =>
            applyBoardEvent(current, { type: "handling-changed", handling }),
          );
        }),
    }),
    reassignRequest: createEnvironmentRpcCommand(runtime, {
      label: "message-board:reassignRequest",
      tag: WS_METHODS.messageBoardReassignRequest,
      onSuccess: ({ environmentId }, registry, handling) =>
        Effect.sync(() => {
          registry.update(cache(environmentId), (current) =>
            applyBoardEvent(current, { type: "handling-changed", handling }),
          );
        }),
    }),
    resumeRequest: createEnvironmentRpcCommand(runtime, {
      label: "message-board:resumeRequest",
      tag: WS_METHODS.messageBoardResumeRequest,
      onSuccess: ({ environmentId }, registry, handling) =>
        Effect.sync(() => {
          registry.update(cache(environmentId), (current) =>
            applyBoardEvent(current, { type: "handling-changed", handling }),
          );
        }),
    }),
    reportOutcome: createEnvironmentRpcCommand(runtime, {
      label: "message-board:reportOutcome",
      tag: WS_METHODS.messageBoardReportOutcome,
      onSuccess: ({ environmentId }, registry, handling) =>
        Effect.sync(() => {
          registry.update(cache(environmentId), (current) =>
            applyBoardEvent(current, { type: "handling-changed", handling }),
          );
        }),
    }),
    closeDiscussion: createEnvironmentRpcCommand(runtime, {
      label: "message-board:closeDiscussion",
      tag: WS_METHODS.messageBoardCloseDiscussion,
      onSuccess: ({ environmentId }, registry, handling) =>
        Effect.sync(() => {
          registry.update(cache(environmentId), (current) =>
            applyBoardEvent(current, { type: "handling-changed", handling }),
          );
        }),
    }),
    reopenDiscussion: createEnvironmentRpcCommand(runtime, {
      label: "message-board:reopenDiscussion",
      tag: WS_METHODS.messageBoardReopenDiscussion,
      onSuccess: ({ environmentId }, registry, handling) =>
        Effect.sync(() => {
          registry.update(cache(environmentId), (current) =>
            applyBoardEvent(current, { type: "handling-changed", handling }),
          );
        }),
    }),
    react: createEnvironmentRpcCommand(runtime, {
      label: "message-board:react",
      tag: WS_METHODS.messageBoardReact,
    }),
    markRead: createEnvironmentRpcCommand(runtime, {
      label: "message-board:mark-read",
      tag: WS_METHODS.messageBoardMarkRead,
    }),
  };
}
