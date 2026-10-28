import {
  WS_METHODS,
  type EnvironmentId,
  type BoardPostId,
  type BoardThreadSort,
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
  emptyBoardCache,
  mergeBoardChannels,
  mergeBoardDetail,
  mergeBoardThreadPage,
} from "./cache.ts";

export { applyBoardEvent, boardPageKey, emptyBoardCache } from "./cache.ts";
export type { BoardCache } from "./cache.ts";

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
    onAnswer: ({ environmentId }, detail, registry) =>
      Effect.sync(() => {
        registry.update(cache(environmentId), (current) => mergeBoardDetail(current, detail));
      }),
  });
  const events = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom((get) =>
        followStreamInEnvironment(
          environmentId,
          subscribe(WS_METHODS.messageBoardSubscribeEvents, {}).pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                const state = cache(environmentId);
                const previous = get.registry.get(state);
                get.registry.update(state, (current) => applyBoardEvent(current, event));
                if (event.type !== "post-created") return;
                if (previous.details[event.post.rootId] !== undefined) {
                  get.registry.refresh(
                    detailQuery({ environmentId, input: { rootId: event.post.rootId } }),
                  );
                }
                if (event.post.id === event.post.rootId) return;
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
  const detailFamily = Atom.family((key: string) => {
    const [environmentId, rootId] = JSON.parse(key) as [EnvironmentId, BoardPostId];
    return Atom.make((get) => {
      get.mount(events(environmentId));
      get(detailQuery({ environmentId, input: { rootId } }));
      return get(cache(environmentId)).details[rootId] ?? null;
    });
  });
  return {
    channels,
    unreadCount,
    events,
    channelQuery,
    threadQuery,
    detailQuery,
    details: Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => get(cache(environmentId)).details),
    ),
    threads: (environmentId: EnvironmentId, channelName: string, sort: BoardThreadSort) =>
      pageFamily(JSON.stringify([environmentId, channelName, sort])),
    thread: (environmentId: EnvironmentId, rootId: BoardPostId) =>
      detailFamily(JSON.stringify([environmentId, rootId])),
    post: createEnvironmentRpcCommand(runtime, {
      label: "message-board:post",
      tag: WS_METHODS.messageBoardPost,
      onSuccess: ({ environmentId }, registry, post) =>
        Effect.sync(() => {
          registry.update(cache(environmentId), (current) =>
            applyBoardEvent(current, { type: "post-created", post }),
          );
        }),
    }),
    markRead: createEnvironmentRpcCommand(runtime, {
      label: "message-board:mark-read",
      tag: WS_METHODS.messageBoardMarkRead,
    }),
  };
}
