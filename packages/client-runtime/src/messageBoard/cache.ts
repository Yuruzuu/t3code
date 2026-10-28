import type {
  BoardAuthor,
  BoardChannel,
  BoardEvent,
  BoardPost,
  BoardThreadDetail,
  BoardThreadSort,
  BoardThreadSummary,
  MessageBoardListThreadsResult,
} from "@t3tools/contracts";

export interface BoardThreadPage {
  channelName: string;
  sort: BoardThreadSort;
  result: MessageBoardListThreadsResult;
}

export interface BoardCache {
  channels: readonly BoardChannel[] | null;
  pages: Readonly<Record<string, BoardThreadPage>>;
  details: Readonly<Record<string, BoardThreadDetail>>;
  readMarkers: Readonly<Record<string, string>>;
  threadReadMarkers: Readonly<Record<string, string>>;
  recentPostIds: readonly string[];
}

export const emptyBoardCache: BoardCache = {
  channels: null,
  pages: {},
  details: {},
  readMarkers: {},
  threadReadMarkers: {},
  recentPostIds: [],
};

/** A discussion is read up to the later of its channel's marker and its own. */
function readAt(cache: BoardCache, channelName: string, rootId: string) {
  const channel = cache.readMarkers[channelName] ?? "";
  const thread = cache.threadReadMarkers[rootId] ?? "";
  return thread > channel ? thread : channel;
}

export const boardPageKey = (channelName: string, sort: BoardThreadSort) =>
  JSON.stringify([channelName, sort]);

function sameAuthor(left: BoardAuthor, right: BoardAuthor) {
  return left.kind === "user"
    ? right.kind === "user"
    : right.kind === "agent" && left.threadId === right.threadId;
}

function rememberPosts(cache: BoardCache, posts: readonly BoardPost[]) {
  return [...new Set([...cache.recentPostIds, ...posts.map((post) => post.id)])].slice(-1000);
}

function comparePosts(left: BoardPost, right: BoardPost) {
  if (left.id === right.id) return 0;
  if (left.id === left.rootId) return -1;
  if (right.id === right.rootId) return 1;
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function applyPost(
  summary: BoardThreadSummary,
  post: BoardPost,
  unread: boolean,
): BoardThreadSummary {
  if (post.id === summary.root.id || post.id === summary.latestReply?.id) return summary;
  return {
    ...summary,
    latestReply:
      summary.latestReply === null || comparePosts(post, summary.latestReply) > 0
        ? post
        : summary.latestReply,
    replyCount: summary.replyCount + 1,
    lastActivityAt:
      post.createdAt > summary.lastActivityAt ? post.createdAt : summary.lastActivityAt,
    participants:
      summary.participants.length >= 8 ||
      summary.participants.some((author) => sameAuthor(author, post.author))
        ? summary.participants
        : [...summary.participants, post.author],
    unread: summary.unread || unread,
  };
}

function rootSummary(post: BoardPost, unread: boolean): BoardThreadSummary {
  return {
    root: post,
    latestReply: null,
    replyCount: 0,
    lastActivityAt: post.createdAt,
    participants: [post.author],
    unread,
  };
}

export function sortBoardThreads(threads: readonly BoardThreadSummary[], sort: BoardThreadSort) {
  return [...threads].sort((left, right) => {
    const leftDate = sort === "activity" ? left.lastActivityAt : left.root.createdAt;
    const rightDate = sort === "activity" ? right.lastActivityAt : right.root.createdAt;
    return rightDate.localeCompare(leftDate) || right.root.id.localeCompare(left.root.id);
  });
}

export function mergeBoardChannels(
  cache: BoardCache,
  incoming: readonly BoardChannel[],
): BoardCache {
  let next = cache;
  for (const channel of incoming) {
    const previous = cache.channels?.find((item) => item.name === channel.name);
    next = applyBoardEvent(next, {
      type: "channel-upserted",
      channel:
        previous !== undefined &&
        (previous.lastActivityAt > channel.lastActivityAt || previous.postCount > channel.postCount)
          ? previous
          : channel,
    });
  }
  return next.channels === null ? { ...next, channels: [] } : next;
}

export function mergeBoardThreadPage(
  cache: BoardCache,
  input: { channelName: string; sort: BoardThreadSort; cursor?: string },
  result: MessageBoardListThreadsResult,
): BoardCache {
  const key = boardPageKey(input.channelName, input.sort);
  const previous = cache.pages[key]?.result;
  const previousThreads = previous?.threads ?? [];
  const incoming = result.threads.map((summary) => {
    const newer = previousThreads.find(
      (item) =>
        item.root.id === summary.root.id &&
        (item.lastActivityAt > summary.lastActivityAt || item.replyCount > summary.replyCount),
    );
    const latest = newer ?? summary;
    return latest.lastActivityAt <= readAt(cache, input.channelName, latest.root.id)
      ? { ...latest, unread: false }
      : latest;
  });
  const threads = [
    ...previousThreads.filter((item) => !incoming.some((other) => item.root.id === other.root.id)),
    ...incoming,
  ];
  return {
    ...cache,
    recentPostIds: rememberPosts(
      cache,
      result.threads.flatMap((summary) =>
        summary.latestReply === null ? [summary.root] : [summary.root, summary.latestReply],
      ),
    ),
    pages: {
      ...cache.pages,
      [key]: {
        channelName: input.channelName,
        sort: input.sort,
        result: {
          threads: sortBoardThreads(threads, input.sort),
          nextCursor:
            input.cursor === undefined &&
            previous !== undefined &&
            previousThreads.length > result.threads.length
              ? previous.nextCursor
              : result.nextCursor,
        },
      },
    },
  };
}

export function mergeBoardDetail(cache: BoardCache, detail: BoardThreadDetail): BoardCache {
  const rootId = detail.summary.root.id;
  const previous = cache.details[rootId];
  const latest =
    previous !== undefined &&
    (previous.summary.lastActivityAt > detail.summary.lastActivityAt ||
      previous.summary.replyCount > detail.summary.replyCount)
      ? previous.summary
      : detail.summary;
  return {
    ...cache,
    recentPostIds: rememberPosts(cache, detail.posts),
    details: {
      ...cache.details,
      [rootId]: {
        members: [
          ...detail.members.map((member) => {
            const live = previous?.members.find((item) => sameAuthor(item.author, member.author));
            return live !== undefined && live.postCount > member.postCount
              ? { ...member, postCount: live.postCount, lastPostedAt: live.lastPostedAt }
              : member;
          }),
          ...(previous?.members.filter(
            (member) =>
              (member.lastPostedAt ?? "") > detail.summary.lastActivityAt &&
              !detail.members.some((item) => sameAuthor(item.author, member.author)),
          ) ?? []),
        ],
        summary:
          latest.lastActivityAt <= readAt(cache, latest.root.channelName, rootId)
            ? { ...latest, unread: false }
            : latest,
        posts: [
          ...new Map(
            [...(previous?.posts ?? []), ...detail.posts].map((post) => [post.id, post]),
          ).values(),
        ].sort(comparePosts),
      },
    },
  };
}

export function applyBoardEvent(cache: BoardCache, event: BoardEvent): BoardCache {
  if (event.type === "channel-upserted") {
    const channels = cache.channels ?? [];
    const incoming =
      event.channel.lastActivityAt <= (cache.readMarkers[event.channel.name] ?? "")
        ? { ...event.channel, unreadCount: 0 }
        : event.channel;
    const exists = channels.some((channel) => channel.name === incoming.name);
    return {
      ...cache,
      channels: exists
        ? channels.map((channel) => (channel.name === incoming.name ? incoming : channel))
        : [...channels, incoming],
    };
  }

  if (event.type === "read-marker-updated") {
    const { rootId } = event;
    const readSummary = (summary: BoardThreadSummary) =>
      summary.unread &&
      summary.lastActivityAt <= event.readAt &&
      (rootId === undefined || summary.root.id === rootId)
        ? { ...summary, unread: false }
        : summary;
    if (rootId !== undefined) {
      if ((cache.threadReadMarkers[rootId] ?? "") > event.readAt) return cache;
      const detail = cache.details[rootId];
      // The channel's count follows in the server's next channel-upserted event.
      return {
        ...cache,
        threadReadMarkers: { ...cache.threadReadMarkers, [rootId]: event.readAt },
        pages: Object.fromEntries(
          Object.entries(cache.pages).map(([key, page]) => [
            key,
            page.channelName === event.channelName
              ? {
                  ...page,
                  result: { ...page.result, threads: page.result.threads.map(readSummary) },
                }
              : page,
          ]),
        ),
        details:
          detail === undefined
            ? cache.details
            : { ...cache.details, [rootId]: { ...detail, summary: readSummary(detail.summary) } },
      };
    }
    if ((cache.readMarkers[event.channelName] ?? "") > event.readAt) return cache;
    return {
      ...cache,
      readMarkers: { ...cache.readMarkers, [event.channelName]: event.readAt },
      channels:
        cache.channels?.map((channel) =>
          channel.name === event.channelName &&
          channel.lastActivityAt <= event.readAt &&
          channel.unreadCount > 0
            ? { ...channel, unreadCount: 0 }
            : channel,
        ) ?? null,
      pages: Object.fromEntries(
        Object.entries(cache.pages).map(([key, page]) => [
          key,
          page.channelName === event.channelName
            ? { ...page, result: { ...page.result, threads: page.result.threads.map(readSummary) } }
            : page,
        ]),
      ),
      details: Object.fromEntries(
        Object.entries(cache.details).map(([key, detail]) => [
          key,
          detail.summary.root.channelName === event.channelName
            ? { ...detail, summary: readSummary(detail.summary) }
            : detail,
        ]),
      ),
    };
  }

  const post = event.post;
  if (cache.recentPostIds.includes(post.id)) return cache;
  const unread = post.createdAt > readAt(cache, post.channelName, post.rootId);
  const pages = { ...cache.pages };
  for (const [key, page] of Object.entries(pages)) {
    if (page.channelName !== post.channelName) continue;
    const existing = page.result.threads.find((summary) => summary.root.id === post.rootId);
    if (existing === undefined && post.id !== post.rootId) continue;
    const summary =
      existing === undefined ? rootSummary(post, unread) : applyPost(existing, post, unread);
    const threads =
      existing === undefined
        ? [...page.result.threads, summary]
        : page.result.threads.map((item) => (item === existing ? summary : item));
    pages[key] = {
      ...page,
      result: { ...page.result, threads: sortBoardThreads(threads, page.sort) },
    };
  }
  const detail = cache.details[post.rootId];
  return {
    ...cache,
    pages,
    recentPostIds: [...cache.recentPostIds.slice(-999), post.id],
    details:
      detail === undefined || detail.posts.some((item) => item.id === post.id)
        ? cache.details
        : {
            ...cache.details,
            [post.rootId]: {
              members:
                post.author.kind !== "agent"
                  ? detail.members
                  : detail.members.some((member) => sameAuthor(member.author, post.author))
                    ? detail.members.map((member) =>
                        sameAuthor(member.author, post.author)
                          ? {
                              ...member,
                              author: post.author,
                              postCount: member.postCount + 1,
                              lastPostedAt:
                                (member.lastPostedAt ?? "") > post.createdAt
                                  ? member.lastPostedAt
                                  : post.createdAt,
                            }
                          : member,
                      )
                    : [
                        ...detail.members,
                        {
                          author: post.author,
                          subscribed: false,
                          postCount: 1,
                          lastPostedAt: post.createdAt,
                        },
                      ],
              summary: applyPost(detail.summary, post, unread),
              posts: [...detail.posts, post].sort(comparePosts),
            },
          },
  };
}
