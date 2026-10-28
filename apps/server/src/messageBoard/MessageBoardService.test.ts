import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BOARD_POST_TEXT_MAX_CHARS,
  BoardPostId,
  MessageBoardError,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type BoardAuthor,
  type BoardViewer,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as MessageBoardService from "./MessageBoardService.ts";

const user = { kind: "user" } as const;
const isMessageBoardError = Schema.is(MessageBoardError);
const threadViewer: BoardViewer = { kind: "thread", threadId: ThreadId.make("thread:board") };
const agent: BoardAuthor = {
  kind: "agent",
  threadId: ThreadId.make("thread:board"),
  projectId: ProjectId.make("project:board"),
  title: "Board agent",
  driver: ProviderDriverKind.make("codex"),
};
const layerTest = MessageBoardService.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(Layer.mock(ProjectionStore.ProjectionStoreV2)({})),
  Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
  Layer.provide(NodeServices.layer),
);

it.effect("auto-creates channels and persists roots and replies with distinct authors", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "general" },
      text: "Root",
    });
    const reply = yield* board.post({
      author: agent,
      destination: { kind: "reply", rootId: root.id },
      text: "Reply",
    });
    assert.equal(root.rootId, root.id);
    assert.equal(reply.rootId, root.id);
    assert.equal(reply.channelName, "general");
    assert.deepEqual(yield* board.readPost({ postId: reply.id }), reply);
    const detail = yield* board.readThread({ viewer: user, rootId: root.id });
    assert.deepEqual(detail.posts, [root, reply]);
    assert.equal(detail.summary.replyCount, 1);
    assert.deepEqual(detail.summary.latestReply, reply);
    assert.deepEqual(detail.summary.participants, [user, agent]);
    assert.deepEqual(detail.members, [
      { author: agent, subscribed: false, postCount: 1, lastPostedAt: reply.createdAt },
    ]);
    const [channel] = yield* board.listChannels({ viewer: user });
    assert.equal(channel?.postCount, 2);
    assert.equal(channel?.threadCount, 1);
    assert.equal(channel?.unreadCount, 2);
    assert.deepEqual(channel?.createdBy, user);
    assert.deepEqual(
      (yield* board.listChannels({ viewer: user, query: "GEN" })).map((value) => value.name),
      ["general"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("unions posting agents and resolvable thread subscribers by latest post", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const silent = { ...agent, threadId: ThreadId.make("silent") };
    const other = { ...agent, threadId: ThreadId.make("other") };
    const root = yield* board.post({
      author: agent,
      destination: { kind: "channel", channelName: "general" },
      text: "Root",
    });
    const target = { kind: "thread", rootId: root.id } as const;
    for (const threadId of [
      agent.threadId,
      other.threadId,
      silent.threadId,
      ThreadId.make("missing"),
      ThreadId.make("deleted"),
    ]) {
      yield* board.subscribe({ viewer: { kind: "thread", threadId }, target });
    }
    yield* board.subscribe({ viewer: user, target });
    yield* board.subscribe({
      viewer: { kind: "thread", threadId: ThreadId.make("channel-only") },
      target: { kind: "channel", channelName: "general" },
    });
    yield* board.post({
      author: other,
      destination: { kind: "reply", rootId: root.id },
      text: "Other",
    });
    const updated = { ...agent, title: "Updated attribution" };
    const latest = yield* board.post({
      author: updated,
      destination: { kind: "reply", rootId: root.id },
      text: "Latest agent post",
    });
    yield* board.post({
      author: user,
      destination: { kind: "reply", rootId: root.id },
      text: "User reply",
    });
    yield* board.unsubscribe({ viewer: threadViewer, target });
    const detail = yield* board.readThread({
      viewer: { kind: "thread", threadId: ThreadId.make("reader") },
      rootId: root.id,
    });
    assert.deepEqual(detail.members, [
      { author: updated, subscribed: false, postCount: 2, lastPostedAt: latest.createdAt },
      { author: other, subscribed: true, postCount: 1, lastPostedAt: detail.posts[1]!.createdAt },
      {
        author: { ...silent, model: "gpt-5.5" },
        subscribed: true,
        postCount: 0,
        lastPostedAt: null,
      },
    ]);
    assert.isFalse(
      (yield* board.listSubscribers(target)).some(
        (viewer) => viewer.kind === "thread" && viewer.threadId === "reader",
      ),
    );
  }).pipe(
    Effect.provide(
      MessageBoardService.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: (threadId) =>
              Effect.succeed(
                threadId === "silent" || threadId === "deleted"
                  ? ({
                      id: threadId,
                      title: agent.title,
                      projectId: agent.projectId,
                      providerInstanceId: ProviderInstanceId.make("codex"),
                      modelSelection: {
                        instanceId: ProviderInstanceId.make("codex"),
                        model: "gpt-5.5",
                      },
                      deletedAt: threadId === "deleted" ? "2026-10-28T00:00:00.000Z" : null,
                    } as Effect.Success<
                      ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getThreadShell"]>
                    >)
                  : null,
              ),
          }),
        ),
        Layer.provide(
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              { instanceId: ProviderInstanceId.make("codex"), driver: "codex", models: [] },
            ] as unknown as Effect.Success<
              ProviderRegistry.ProviderRegistry["Service"]["getProviders"]
            >),
          }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("keeps read markers per viewer and counts posts after a same-tick mark", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = yield* board.post({
      author: agent,
      destination: { kind: "channel", channelName: "general" },
      text: "Root",
    });
    yield* board.readThread({ viewer: user, rootId: root.id });
    yield* board.searchPosts({ viewer: user, query: "Root" });
    assert.equal((yield* board.listChannels({ viewer: user }))[0]?.unreadCount, 1);
    yield* board.markRead({ viewer: user, channelName: "general" });
    assert.equal((yield* board.listChannels({ viewer: user }))[0]?.unreadCount, 0);
    assert.equal(
      (yield* board.readThread({ viewer: user, rootId: root.id })).summary.unread,
      false,
    );
    assert.equal((yield* board.listChannels({ viewer: threadViewer }))[0]?.unreadCount, 1);
    yield* board.post({
      author: agent,
      destination: { kind: "reply", rootId: root.id },
      text: "Unread reply",
    });
    assert.equal((yield* board.listChannels({ viewer: user }))[0]?.unreadCount, 1);
    assert.equal((yield* board.listChannels({ viewer: threadViewer }))[0]?.unreadCount, 2);
    assert.equal((yield* board.readThread({ viewer: user, rootId: root.id })).summary.unread, true);
    yield* board.markRead({ viewer: threadViewer, channelName: "general" });
    assert.equal((yield* board.listChannels({ viewer: threadViewer }))[0]?.unreadCount, 0);
    assert.equal((yield* board.listChannels({ viewer: user }))[0]?.unreadCount, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("upserts a channel description while keeping its posts and creator", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const created = yield* board.upsertChannel({
      author: agent,
      name: "plans",
      description: "First draft",
    });
    yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "plans" },
      text: "Kickoff",
    });
    const updated = yield* board.upsertChannel({
      author: user,
      name: "plans",
      description: "Agreed plans only",
    });
    assert.equal(created.description, "First draft");
    assert.deepInclude(updated, {
      description: "Agreed plans only",
      createdBy: agent,
      postCount: 1,
    });
    const failure = yield* board
      .upsertChannel({ author: agent, name: "plans", description: "x".repeat(513) })
      .pipe(Effect.flip);
    assert.deepInclude(failure, { code: "invalid_input" });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reading one discussion leaves the channel's other discussions unread", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const read = yield* board.post({
      author: agent,
      destination: { kind: "channel", channelName: "general" },
      text: "Read me",
    });
    yield* board.post({
      author: agent,
      destination: { kind: "reply", rootId: read.id },
      text: "Reply",
    });
    const other = yield* board.post({
      author: agent,
      destination: { kind: "channel", channelName: "general" },
      text: "Still unread",
    });
    yield* board.markRead({ viewer: user, rootId: read.id });
    assert.equal((yield* board.listChannels({ viewer: user }))[0]?.unreadCount, 1);
    const page = yield* board.listThreads({
      viewer: user,
      channelName: "general",
      sort: "created",
    });
    assert.deepEqual(
      page.threads.map((thread) => [thread.root.id, thread.unread]),
      [
        [other.id, true],
        [read.id, false],
      ],
    );
    assert.equal(
      (yield* board.listChannels({ viewer: threadViewer }))[0]?.unreadCount,
      3,
      "other viewers keep their own markers",
    );
    yield* board.post({
      author: agent,
      destination: { kind: "reply", rootId: read.id },
      text: "New reply",
    });
    assert.equal((yield* board.readThread({ viewer: user, rootId: read.id })).summary.unread, true);
    yield* board.markRead({ viewer: user, channelName: "general" });
    assert.equal((yield* board.listChannels({ viewer: user }))[0]?.unreadCount, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("sorts threads by creation or latest activity and paginates without duplicates", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const first = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "general" },
      text: "First",
    });
    const second = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "general" },
      text: "Second",
    });
    yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "other" },
      text: "Other channel",
    });
    yield* board.post({
      author: agent,
      destination: { kind: "reply", rootId: first.id },
      text: "New activity",
    });
    const input = { viewer: user, channelName: "general", sort: "activity" as const };
    const activity = yield* board.listThreads(input);
    assert.deepEqual(
      activity.threads.map((thread) => thread.root.id),
      [first.id, second.id],
    );
    const created = yield* board.listThreads({ ...input, sort: "created" });
    assert.deepEqual(
      created.threads.map((thread) => thread.root.id),
      [second.id, first.id],
    );
    const page = yield* board.listThreads({ ...input, limit: 1 });
    assert.isNotNull(page.nextCursor);
    assert.deepEqual(
      page.threads.map((thread) => thread.root.id),
      [first.id],
    );
    const next = yield* board.listThreads({ ...input, limit: 1, cursor: page.nextCursor! });
    assert.deepEqual(
      next.threads.map((thread) => thread.root.id),
      [second.id],
    );
    assert.isNull(next.nextCursor);
    const channels = yield* board.listChannels({ viewer: user });
    assert.deepEqual(
      channels.map((channel) => channel.name),
      ["general", "other"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "searches case-insensitive literal substrings newest first with channel and limit filters",
  () =>
    Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const first = yield* board.post({
        author: user,
        destination: { kind: "channel", channelName: "general" },
        text: "Hello 100%_done",
      });
      const reply = yield* board.post({
        author: agent,
        destination: { kind: "reply", rootId: first.id },
        text: "hELLo again",
      });
      const other = yield* board.post({
        author: user,
        destination: { kind: "channel", channelName: "other" },
        text: "HELLO",
      });
      assert.deepEqual(
        (yield* board.searchPosts({ viewer: user, query: "hello" })).map((post) => post.id),
        [other.id, reply.id, first.id],
      );
      assert.deepEqual(
        (yield* board.searchPosts({
          viewer: user,
          query: "HELLO",
          channelName: "general",
          limit: 1,
        })).map((post) => post.id),
        [reply.id],
      );
      assert.deepEqual(
        (yield* board.searchPosts({ viewer: user, query: "%_" })).map((post) => post.id),
        [first.id],
      );
      assert.equal((yield* board.searchPosts({ viewer: user, channelName: "general" })).length, 2);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("creates channels idempotently and rejects invalid posts without writing", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const input = { author: user, name: "general", description: "General discussion" };
    const channel = yield* board.createChannel(input);
    assert.deepEqual(yield* board.createChannel(input), channel);
    const conflict = yield* board
      .createChannel({ ...input, description: "Different" })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(conflict));
    for (const text of [" ", "x".repeat(BOARD_POST_TEXT_MAX_CHARS + 1)]) {
      const result = yield* board
        .post({ author: user, destination: { kind: "channel", channelName: "invalid" }, text })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.isTrue(isMessageBoardError(result.failure));
    }
    const missing = yield* board
      .post({
        author: user,
        destination: { kind: "reply", rootId: BoardPostId.make("missing") },
        text: "Reply",
      })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(missing));
    assert.deepEqual(
      (yield* board.listChannels({ viewer: user })).map((value) => value.name),
      ["general"],
    );
    assert.equal((yield* board.listChannels({ viewer: user }))[0]?.postCount, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("subscribes and unsubscribes viewers idempotently for channel and thread targets", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const root = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "general" },
      text: "Root",
    });
    const channelTarget = { kind: "channel", channelName: "general" } as const;
    const threadTarget = { kind: "thread", rootId: root.id } as const;
    yield* board.subscribe({ viewer: threadViewer, target: channelTarget });
    yield* board.subscribe({ viewer: threadViewer, target: channelTarget });
    yield* board.subscribe({ viewer: user, target: threadTarget });
    assert.deepEqual(yield* board.listSubscribers(channelTarget), [threadViewer]);
    assert.deepEqual(yield* board.listSubscribers(threadTarget), [user]);
    yield* board.unsubscribe({ viewer: threadViewer, target: channelTarget });
    yield* board.unsubscribe({ viewer: threadViewer, target: channelTarget });
    assert.deepEqual(yield* board.listSubscribers(channelTarget), []);
    assert.deepEqual(yield* board.listSubscribers(threadTarget), [user]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("publishes posts, channel counts, and only the user's read-marker events", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const pull = yield* Stream.toPull(board.events.pipe(Stream.rechunk(1)));
    const firstEvent = yield* pull.pipe(Effect.forkChild({ startImmediately: true }));
    const root = yield* board.post({
      author: user,
      destination: { kind: "channel", channelName: "general" },
      text: "Root",
    });
    assert.deepEqual(yield* Fiber.join(firstEvent), [{ type: "post-created", post: root }]);
    const channelEvents = yield* pull;
    assert.equal(channelEvents[0]?.type, "channel-upserted");
    if (channelEvents[0]?.type === "channel-upserted")
      assert.equal(channelEvents[0].channel.unreadCount, 1);
    yield* board.markRead({ viewer: threadViewer, channelName: "general" });
    yield* board.markRead({ viewer: user, channelName: "general" });
    const markerEvents = yield* pull;
    assert.equal(markerEvents[0]?.type, "read-marker-updated");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("builds agent attribution from the orchestration shell and provider instance", () =>
  Effect.gen(function* () {
    const author = yield* MessageBoardService.agentAuthorForThread(ThreadId.make("thread:board"));
    assert.deepEqual(author, { ...agent, model: "GPT-5.5" });
  }).pipe(
    Effect.provide(
      Layer.merge(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () =>
            Effect.succeed({
              id: ThreadId.make("thread:board"),
              title: agent.kind === "agent" ? agent.title : "",
              projectId: ProjectId.make("project:board"),
              providerInstanceId: ProviderInstanceId.make("codex"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
              deletedAt: null,
            } as Awaited<
              Effect.Success<
                ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getThreadShell"]>
              >
            >),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            {
              instanceId: ProviderInstanceId.make("codex"),
              driver: "codex",
              models: [{ slug: "gpt-5.5", name: "GPT-5.5" }],
            },
          ] as unknown as Effect.Success<
            ProviderRegistry.ProviderRegistry["Service"]["getProviders"]
          >),
        }),
      ),
    ),
  ),
);

it.effect("adds a set role to the agent byline and clears it with an empty role", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const threadId = ThreadId.make("roled");
    yield* board.setRole({ threadId, role: "  Reviewer " });
    assert.deepInclude(yield* board.agentAuthor(threadId), { role: "Reviewer" });
    const tooLong = yield* board.setRole({ threadId, role: "x".repeat(41) }).pipe(Effect.flip);
    assert.deepInclude(tooLong, { code: "invalid_input" });
    yield* board.setRole({ threadId, role: "" });
    assert.notProperty(yield* board.agentAuthor(threadId), "role");
  }).pipe(
    Effect.provide(
      MessageBoardService.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: (threadId) =>
              Effect.succeed({
                id: threadId,
                title: agent.title,
                projectId: agent.projectId,
                providerInstanceId: ProviderInstanceId.make("codex"),
                modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
                deletedAt: null,
              } as Effect.Success<
                ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getThreadShell"]>
              >),
          }),
        ),
        Layer.provide(
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed(
              [] as unknown as Effect.Success<
                ProviderRegistry.ProviderRegistry["Service"]["getProviders"]
              >,
            ),
          }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
