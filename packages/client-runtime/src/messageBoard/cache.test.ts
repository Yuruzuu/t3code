import {
  BoardPostId,
  ThreadId,
  type BoardHandlingSnapshot,
  type BoardChannel,
  type BoardPost,
  type BoardTodo,
  type BoardThreadSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyBoardEvent,
  boardPageKey,
  boardThreadUnreadCount,
  emptyBoardCache,
  mergeBoardChannels,
  mergeBoardDetail,
  mergeBoardThreadPage,
  type BoardCache,
} from "./cache.ts";

function post(id: string, minute: number, rootId = id, channelName = "general"): BoardPost {
  return {
    id: BoardPostId.make(id),
    rootId: BoardPostId.make(rootId),
    channelName,
    author: { kind: "user" },
    text: id,
    createdAt: `2026-10-28T00:${String(minute).padStart(2, "0")}:00.000Z`,
  };
}

function summary(root: BoardPost): BoardThreadSummary {
  return {
    root,
    latestReply: null,
    replyCount: 0,
    lastActivityAt: root.createdAt,
    participants: [root.author],
    unread: true,
  };
}

function setup(): BoardCache {
  const first = summary(post("first", 1));
  const second = summary(post("second", 2));
  const other = summary(post("other", 3, "other", "announcements"));
  const channel: BoardChannel = {
    name: "general",
    description: null,
    createdBy: { kind: "user" },
    createdAt: first.root.createdAt,
    lastActivityAt: second.lastActivityAt,
    threadCount: 2,
    postCount: 2,
    unreadCount: 2,
    latestPost: null,
    recentAuthors: [],
  };
  return {
    ...emptyBoardCache,
    channels: [channel],
    pages: {
      [boardPageKey("general", "activity")]: {
        channelName: "general",
        sort: "activity",
        result: { threads: [second, first], nextCursor: "older" },
      },
      [boardPageKey("general", "created")]: {
        channelName: "general",
        sort: "created",
        result: { threads: [second, first], nextCursor: "older" },
      },
      [boardPageKey("announcements", "activity")]: {
        channelName: "announcements",
        sort: "activity",
        result: { threads: [other], nextCursor: null },
      },
    },
    details: {
      first: { summary: first, members: [], posts: [first.root] },
      other: { summary: other, members: [], posts: [other.root] },
    },
  };
}

describe("message board cache", () => {
  it("retains handling events before detail loading and rejects stale reconnect snapshots", () => {
    const root = post("first", 1);
    const handling: BoardHandlingSnapshot = {
      rootId: root.id,
      revision: 3,
      leadThreadId: null,
      suggestedLeadThreadId: null,
      lifecycle: "closed",
      context: { text: "Current decision", decisionPostIds: [] },
      responsibilities: [],
    };
    const event = { type: "handling-changed", handling } as const;
    const live = applyBoardEvent(emptyBoardCache, event);
    const loaded = mergeBoardDetail(live, {
      summary: summary(root),
      members: [],
      posts: [root],
      handling: { ...handling, revision: 1, lifecycle: "open" },
    });
    expect(loaded.details.first?.handling).toEqual(handling);
    expect(applyBoardEvent(loaded, { ...event, handling: { ...handling, revision: 2 } })).toBe(
      loaded,
    );
    expect(
      mergeBoardDetail(loaded, { summary: summary(root), members: [], posts: [root] }).details.first
        ?.handling,
    ).toEqual(handling);
  });

  it("keeps shared todos through posts and late snapshots without reviving deleted items", () => {
    const root = post("root", 1);
    const todo: BoardTodo = {
      version: 1,
      history: [],
      id: "todo-1",
      rootId: root.id,
      text: "Implement scoped work",
      status: "in-progress",
      assignee: null,
      createdAt: root.createdAt,
      updatedAt: root.createdAt,
    };
    const snapshot = {
      summary: summary(root),
      members: [],
      posts: [root],
      todos: [todo],
      todosRevision: 1,
    };
    let cache = mergeBoardDetail(emptyBoardCache, snapshot);
    expect(cache.details.root?.todos).toEqual([todo]);
    cache = applyBoardEvent(cache, { type: "post-created", post: post("reply", 2, "root") });
    expect(cache.details.root?.todos).toEqual([todo]);
    cache = applyBoardEvent(cache, {
      type: "todos-changed",
      rootId: root.id,
      todos: [],
      todosRevision: 2,
    });
    expect(cache.details.root?.todos).toEqual([]);
    cache = mergeBoardDetail(cache, snapshot);
    expect(cache.details.root?.todos).toEqual([]);
    expect(cache.details.root?.todosRevision).toBe(2);
    const stale = applyBoardEvent(cache, {
      type: "todos-changed",
      rootId: root.id,
      todos: [todo],
      todosRevision: 1,
    });
    expect(stale).toBe(cache);
    const legacy = mergeBoardDetail(cache, {
      summary: summary(root),
      members: [],
      posts: [root],
    });
    expect(legacy.details.root?.todos).toEqual([]);
    expect(legacy.details.root?.todosRevision).toBe(2);
  });

  it("retains newer todo snapshots before the first detail loads, including deletions", () => {
    const root = post("root", 1);
    const oldTodo: BoardTodo = {
      version: 1,
      history: [],
      id: "todo-1",
      rootId: root.id,
      text: "Original scope",
      status: "todo",
      assignee: null,
      createdAt: root.createdAt,
      updatedAt: root.createdAt,
    };
    const oldDetail = {
      summary: summary(root),
      members: [],
      posts: [root],
      todos: [oldTodo],
      todosRevision: 1,
    };
    for (const todos of [[{ ...oldTodo, text: "Updated scope" }], []]) {
      const live = applyBoardEvent(emptyBoardCache, {
        type: "todos-changed",
        rootId: root.id,
        todos,
        todosRevision: 2,
      });
      const loaded = mergeBoardDetail(live, oldDetail);
      expect(loaded.details.root?.todos).toEqual(todos);
      expect(loaded.details.root?.todosRevision).toBe(2);
      expect(
        mergeBoardDetail(loaded, { summary: summary(root), members: [], posts: [root] }).details
          .root?.todos,
      ).toEqual(todos);
    }
  });

  it("applies todo changes only to their discussion and accepts an empty newer snapshot", () => {
    const cache = setup();
    const next = applyBoardEvent(cache, {
      type: "todos-changed",
      rootId: BoardPostId.make("first"),
      todos: [],
      todosRevision: 1,
    });
    expect(next.details.first?.todos).toEqual([]);
    expect(next.details.other).toBe(cache.details.other);
    expect(next.pages).toBe(cache.pages);
    expect(next.channels).toBe(cache.channels);
    const unloaded = applyBoardEvent(next, {
      type: "todos-changed",
      rootId: BoardPostId.make("unloaded"),
      todos: [],
      todosRevision: 1,
    });
    expect(unloaded.details).toBe(next.details);
    expect(unloaded.todos.unloaded).toEqual({ todos: [], todosRevision: 1 });
  });

  it("updates replies, participants and activity order while preserving other channels and creation order", () => {
    const cache = setup();
    const reply = {
      ...post("reply", 4, "first"),
      author: {
        kind: "agent" as const,
        threadId: ThreadId.make("agent"),
        projectId: null,
        title: "Agent",
        driver: null,
      },
    };
    const next = applyBoardEvent(cache, { type: "post-created", post: reply });
    const activity = next.pages[boardPageKey("general", "activity")]!;
    expect(activity.result.threads.map((item) => item.root.id)).toEqual(["first", "second"]);
    expect(activity.result.threads[0]).toMatchObject({
      replyCount: 1,
      latestReply: reply,
      participants: [{ kind: "user" }, reply.author],
    });
    expect(activity.result.nextCursor).toBe("older");
    expect(
      next.pages[boardPageKey("general", "created")]!.result.threads.map((item) => item.root.id),
    ).toEqual(["second", "first"]);
    expect(next.details.first!.posts.map((item) => item.id)).toEqual(["first", "reply"]);
    expect(next.pages[boardPageKey("announcements", "activity")]).toBe(
      cache.pages[boardPageKey("announcements", "activity")],
    );
    expect(next.details.other).toBe(cache.details.other);
    expect(next.channels).toBe(cache.channels);
    expect(applyBoardEvent(next, { type: "post-created", post: reply })).toBe(next);
  });

  it("inserts roots once and uses authoritative channel counts without counting the post twice", () => {
    const cache = setup();
    const root = post("new", 5);
    const posted = applyBoardEvent(cache, { type: "post-created", post: root });
    const channel = {
      ...cache.channels![0]!,
      lastActivityAt: root.createdAt,
      postCount: 3,
      threadCount: 3,
      unreadCount: 3,
      latestPost: null,
      recentAuthors: [],
    };
    const next = applyBoardEvent(posted, { type: "channel-upserted", channel });
    expect(next.channels![0]).toEqual(channel);
    expect(
      next.pages[boardPageKey("general", "activity")]!.result.threads.map((item) => item.root.id),
    ).toEqual(["new", "second", "first"]);
    expect(applyBoardEvent(next, { type: "post-created", post: root })).toBe(next);
  });

  it("clears unread state through the read marker and keeps newer replies unread", () => {
    const readAt = post("clock", 3).createdAt;
    const read = applyBoardEvent(setup(), {
      type: "read-marker-updated",
      channelName: "general",
      readAt,
    });
    expect(read.channels![0]!.unreadCount).toBe(0);
    expect(
      read.pages[boardPageKey("general", "activity")]!.result.threads.every((item) => !item.unread),
    ).toBe(true);
    expect(read.details.first!.summary.unread).toBe(false);
    expect(read.details.other!.summary.unread).toBe(true);
    const next = applyBoardEvent(read, { type: "post-created", post: post("reply", 4, "first") });
    expect(next.details.first!.summary.unread).toBe(true);
    const staleRead = applyBoardEvent(next, {
      type: "read-marker-updated",
      channelName: "general",
      readAt,
    });
    expect(staleRead.details.first!.summary.unread).toBe(true);
    expect(
      applyBoardEvent(staleRead, {
        type: "read-marker-updated",
        channelName: "general",
        readAt: post("clock", 1).createdAt,
      }),
    ).toBe(staleRead);
  });

  it("counts others' posts after the read markers as a discussion's new messages", () => {
    const fromAgent = (id: string, minute: number): BoardPost => ({
      ...post(id, minute, "first"),
      author: {
        kind: "agent",
        threadId: ThreadId.make("agent"),
        projectId: null,
        title: "Agent",
        driver: null,
      },
    });
    const read = applyBoardEvent(setup(), {
      type: "read-marker-updated",
      channelName: "general",
      rootId: BoardPostId.make("first"),
      readAt: post("clock", 3).createdAt,
    });
    expect(boardThreadUnreadCount(read, "first")).toBe(0);

    const replied = [fromAgent("seen", 2), post("mine", 4, "first"), fromAgent("new", 5)].reduce(
      (cache, reply) => applyBoardEvent(cache, { type: "post-created", post: reply }),
      read,
    );
    expect(boardThreadUnreadCount(replied, "first")).toBe(1);

    const caughtUp = applyBoardEvent(replied, {
      type: "read-marker-updated",
      channelName: "general",
      readAt: post("clock", 6).createdAt,
    });
    expect(boardThreadUnreadCount(caughtUp, "first")).toBe(0);
    expect(boardThreadUnreadCount(caughtUp, "not-loaded")).toBe(0);
  });

  it("reads one discussion without clearing the rest of its channel", () => {
    const readAt = post("clock", 3).createdAt;
    const read = applyBoardEvent(setup(), {
      type: "read-marker-updated",
      channelName: "general",
      rootId: BoardPostId.make("first"),
      readAt,
    });
    const threads = read.pages[boardPageKey("general", "activity")]!.result.threads;
    expect(threads.map((item) => [item.root.id, item.unread])).toEqual([
      ["second", true],
      ["first", false],
    ]);
    expect(read.details.first!.summary.unread).toBe(false);
    const replied = applyBoardEvent(read, {
      type: "post-created",
      post: post("reply", 4, "first"),
    });
    expect(replied.details.first!.summary.unread).toBe(true);
    const refreshed = mergeBoardDetail(read, setup().details.first!);
    expect(refreshed.details.first!.summary.unread).toBe(false);
  });

  it("keeps already-read discussions stable when read markers advance", () => {
    const event = {
      type: "read-marker-updated" as const,
      channelName: "general",
      readAt: post("clock", 3).createdAt,
    };
    const cache = applyBoardEvent(setup(), event);
    const next = applyBoardEvent(cache, { ...event, readAt: post("clock", 4).createdAt });
    expect(next.readMarkers.general).toBe(post("clock", 4).createdAt);
    expect(next.pages[boardPageKey("general", "activity")]).toBe(
      cache.pages[boardPageKey("general", "activity")],
    );
    expect(next.details.first).toBe(cache.details.first);
    expect(next.channels).toBe(cache.channels);

    const threadRead = applyBoardEvent(setup(), { ...event, rootId: BoardPostId.make("first") });
    const threadNext = applyBoardEvent(threadRead, {
      ...event,
      rootId: BoardPostId.make("first"),
      readAt: post("clock", 4).createdAt,
    });
    expect(threadNext.threadReadMarkers.first).toBe(post("clock", 4).createdAt);
    expect(threadNext.pages[boardPageKey("general", "activity")]).toBe(
      threadRead.pages[boardPageKey("general", "activity")],
    );
    expect(threadNext.details.first).toBe(threadRead.details.first);
  });

  it("does not resurrect unread counts when an older channel snapshot follows a read marker", () => {
    const cache = setup();
    const read = applyBoardEvent(cache, {
      type: "read-marker-updated",
      channelName: "general",
      readAt: post("clock", 3).createdAt,
    });
    const next = applyBoardEvent(read, { type: "channel-upserted", channel: cache.channels![0]! });
    expect(next.channels![0]!.unreadCount).toBe(0);
  });

  it("retains loaded pages, pagination and live replies when a first-page refresh finishes late", () => {
    const cache = setup();
    const reply = post("reply", 6, "first");
    const live = applyBoardEvent(cache, { type: "post-created", post: reply });
    const refreshed = mergeBoardThreadPage(
      live,
      { channelName: "general", sort: "activity" },
      {
        threads: [summary(post("second", 2))],
        nextCursor: "first-page-cursor",
      },
    );
    const result = refreshed.pages[boardPageKey("general", "activity")]!.result;
    expect(result.threads.map((item) => item.root.id)).toEqual(["first", "second"]);
    expect(result.threads[0]!.replyCount).toBe(1);
    expect(result.nextCursor).toBe("older");
    const paged = mergeBoardThreadPage(
      refreshed,
      { channelName: "general", sort: "activity", cursor: "older" },
      {
        threads: [summary(post("oldest", 0)), summary(post("first", 1))],
        nextCursor: null,
      },
    );
    expect(
      paged.pages[boardPageKey("general", "activity")]!.result.threads.map((item) => item.root.id),
    ).toEqual(["first", "second", "oldest"]);
    expect(paged.pages[boardPageKey("general", "activity")]!.result.nextCursor).toBeNull();
  });

  it("merges snapshots with newer activity and read markers instead of reverting live state", () => {
    const cache = setup();
    const live = applyBoardEvent(cache, { type: "post-created", post: post("reply", 4, "first") });
    const read = applyBoardEvent(live, {
      type: "read-marker-updated",
      channelName: "general",
      readAt: post("clock", 5).createdAt,
    });
    const detail = mergeBoardDetail(read, cache.details.first!);
    expect(detail.details.first!.posts.map((item) => item.id)).toEqual(["first", "reply"]);
    expect(detail.details.first!.summary).toMatchObject({ replyCount: 1, unread: false });
    const channels = mergeBoardChannels(detail, cache.channels!);
    expect(channels.channels![0]!.unreadCount).toBe(0);
    const page = mergeBoardThreadPage(
      channels,
      { channelName: "general", sort: "activity" },
      cache.pages[boardPageKey("general", "activity")]!.result,
    );
    expect(page.pages[boardPageKey("general", "activity")]!.result.threads[0]).toMatchObject({
      replyCount: 1,
      unread: false,
    });
  });

  it("keeps the root first when replies share its timestamp and deduplicates snapshot events", () => {
    const root = post("z-root", 1);
    const reply = post("a-reply", 1, "z-root");
    const cache = mergeBoardDetail(emptyBoardCache, {
      summary: { ...summary(root), latestReply: reply, replyCount: 1 },
      members: [],
      posts: [reply, root],
    });
    expect(cache.details["z-root"]!.posts.map((item) => item.id)).toEqual(["z-root", "a-reply"]);
    expect(applyBoardEvent(cache, { type: "post-created", post: reply })).toBe(cache);
  });

  it("prepends discussion pages without resetting pagination or losing live replies", () => {
    const root = post("root", 1);
    const replies = [
      post("oldest", 2, "root"),
      post("middle", 3, "root"),
      post("latest", 4, "root"),
    ];
    const snapshot = {
      summary: {
        ...summary(root),
        latestReply: replies[2]!,
        replyCount: 3,
        lastActivityAt: replies[2]!.createdAt,
      },
      members: [],
      posts: [root, replies[2]!],
      olderPostsCursor: "before-latest",
    };
    let cache = mergeBoardDetail(emptyBoardCache, snapshot);
    expect(cache.details.root?.olderPostsCursor).toBe("before-latest");
    cache = applyBoardEvent(cache, { type: "post-created", post: post("live", 5, "root") });
    cache = mergeBoardDetail(
      cache,
      { ...snapshot, posts: [root, replies[1]!], olderPostsCursor: "before-middle" },
      { cursor: "before-latest" },
    );
    expect(cache.details.root?.posts.map((item) => item.id)).toEqual([
      "root",
      "middle",
      "latest",
      "live",
    ]);
    expect(cache.details.root?.summary.replyCount).toBe(4);
    expect(cache.details.root?.olderPostsCursor).toBe("before-middle");
    cache = mergeBoardDetail(cache, snapshot);
    expect(cache.details.root?.olderPostsCursor).toBe("before-middle");
    cache = mergeBoardDetail(
      cache,
      { ...snapshot, posts: [root, replies[0]!], olderPostsCursor: null },
      { cursor: "before-middle" },
    );
    const completed = cache.details.root;
    expect(completed?.posts.map((item) => item.id)).toEqual([
      "root",
      "oldest",
      "middle",
      "latest",
      "live",
    ]);
    expect(completed?.olderPostsCursor).toBeNull();
    cache = mergeBoardDetail(
      cache,
      { ...snapshot, posts: [root, replies[1]!], olderPostsCursor: "before-middle" },
      { cursor: "before-latest" },
    );
    expect(cache.details.root?.olderPostsCursor).toBeNull();
    expect(cache.details.root?.posts).toEqual(completed?.posts);
    expect(mergeBoardDetail(cache, snapshot).details.root?.olderPostsCursor).toBeNull();
  });

  it("retains subscribed members and merges live member activity across late detail snapshots", () => {
    const root = post("root", 1);
    const author = {
      kind: "agent" as const,
      threadId: ThreadId.make("research-agent"),
      projectId: null,
      title: "Research findings",
      driver: null,
    };
    const member = { author, subscribed: true, postCount: 0, lastPostedAt: null };
    const snapshot = { summary: summary(root), members: [member], posts: [root] };
    const cache = mergeBoardDetail(emptyBoardCache, snapshot);
    expect(cache.details.root!.members).toEqual([member]);

    const reply = { ...post("reply", 2, "root"), author };
    const live = applyBoardEvent(cache, { type: "post-created", post: reply });
    expect(live.details.root!.members).toEqual([
      { ...member, postCount: 1, lastPostedAt: reply.createdAt },
    ]);
    const refreshed = mergeBoardDetail(live, snapshot);
    expect(refreshed.details.root!.members).toEqual(live.details.root!.members);
    expect(applyBoardEvent(refreshed, { type: "post-created", post: reply })).toBe(refreshed);

    const newcomer = { ...author, threadId: ThreadId.make("new-agent") };
    const next = applyBoardEvent(refreshed, {
      type: "post-created",
      post: { ...post("next", 3, "root"), author: newcomer },
    });
    expect(next.details.root!.members).toContainEqual({
      author: newcomer,
      subscribed: false,
      postCount: 1,
      lastPostedAt: post("next", 3).createdAt,
    });
  });

  it("applies reactions and member read positions to an open discussion in place", () => {
    const root = post("root", 1);
    const agent = {
      kind: "agent" as const,
      threadId: ThreadId.make("agent-1"),
      projectId: null,
      title: "Agent",
      driver: null,
    };
    let cache = mergeBoardDetail(emptyBoardCache, {
      summary: summary(root),
      members: [{ author: agent, subscribed: true, postCount: 1, lastPostedAt: root.createdAt }],
      posts: [root],
    });
    const thumbs = [{ emoji: "👍", by: [{ kind: "user" as const }] }];
    cache = applyBoardEvent(cache, {
      type: "reactions-changed",
      rootId: root.id,
      postId: root.id,
      reactions: thumbs,
    });
    expect(cache.details[root.id]?.posts[0]?.reactions).toEqual(thumbs);
    cache = applyBoardEvent(cache, {
      type: "member-updated",
      rootId: root.id,
      member: {
        author: agent,
        subscribed: true,
        postCount: 1,
        lastPostedAt: root.createdAt,
        readAt: "2026-10-28T00:05:00.000Z",
      },
    });
    expect(cache.details[root.id]?.members).toHaveLength(1);
    expect(cache.details[root.id]?.members[0]?.readAt).toBe("2026-10-28T00:05:00.000Z");
    cache = applyBoardEvent(cache, {
      type: "reactions-changed",
      rootId: root.id,
      postId: root.id,
      reactions: [],
    });
    expect(cache.details[root.id]?.posts[0]).toEqual(root);
  });
});
