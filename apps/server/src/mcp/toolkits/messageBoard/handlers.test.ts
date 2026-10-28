import {
  BoardPostId,
  EnvironmentId,
  MessageId,
  MessageBoardError,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type BoardAuthor,
  type BoardChannel,
  type BoardPost,
  type BoardThreadSummary,
  type BoardViewer,
} from "@t3tools/contracts";
import { boardPersona } from "@t3tools/shared/boardPersona";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as MessageBoardService from "../../../messageBoard/MessageBoardService.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as MessageBoardHandlers from "./handlers.ts";
import { MessageBoardToolkit } from "./tools.ts";

const CALLER = ThreadId.make("caller");
const ACTIVE = ThreadId.make("active-sibling");
const IDLE = ThreadId.make("idle-sibling");
const EXPLICIT = ThreadId.make("explicit-idle");
const FAILED = ThreadId.make("failed-delivery");
const ROOT = BoardPostId.make("root-1");

const AUTHOR: BoardAuthor = {
  kind: "agent",
  threadId: CALLER,
  projectId: null,
  title: "Implementation agent",
  driver: null,
};

const NAMED_AUTHOR = { ...AUTHOR, name: boardPersona(CALLER).name };
const MEMBER = {
  author: AUTHOR,
  subscribed: true,
  postCount: 1,
  lastPostedAt: "2026-10-28T00:00:00.000Z",
};

const POST: BoardPost = {
  id: ROOT,
  rootId: ROOT,
  channelName: "findings",
  author: AUTHOR,
  text: "A finding",
  createdAt: "2026-10-28T00:00:00.000Z",
};

const CHANNEL: BoardChannel = {
  name: "findings",
  description: null,
  createdBy: AUTHOR,
  createdAt: POST.createdAt,
  lastActivityAt: POST.createdAt,
  threadCount: 1,
  postCount: 1,
  unreadCount: 3,
  latestPost: null,
  recentAuthors: [],
};

const summary = (post = POST): BoardThreadSummary => ({
  root: post,
  latestReply: null,
  replyCount: 0,
  lastActivityAt: post.createdAt,
  participants: [AUTHOR],
  unread: true,
});

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  issuedAt: 1,
  requestNamespace: "session-1",
  capabilities: new Set(["orchestration"]),
  thread: {
    threadId: CALLER,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "session-1",
  },
  client: undefined,
};

const makeHarness = Effect.fn("makeMessageBoardToolkitHarness")(function* (
  options: {
    board?: Partial<MessageBoardService.MessageBoardService["Service"]>;
    subscribers?: ReadonlyArray<BoardViewer>;
    posts?: ReadonlyArray<BoardPost>;
  } = {},
) {
  const operations = yield* Ref.make<ReadonlyArray<{ operation: string; input: unknown }>>([]);
  const deliveries = yield* Ref.make<
    ReadonlyArray<{ threadId: ThreadId; mode: string | undefined; message: string }>
  >([]);
  const record = <A>(operation: string, input: unknown, result: A) =>
    Ref.update(operations, (items) => [...items, { operation, input }]).pipe(Effect.as(result));
  const posts = options.posts ?? [POST];
  const layerDependencies = Layer.mergeAll(
    Layer.mock(MessageBoardService.MessageBoardService)({
      agentAuthor: (threadId) =>
        threadId === FAILED
          ? Effect.fail(new MessageBoardError({ code: "not_found", message: "Missing" }))
          : Effect.succeed(AUTHOR),
      setRole: (input) => record("setRole", input, undefined),
      listChannels: (input) => record("listChannels", input, [CHANNEL]),
      createChannel: (input) => record("createChannel", input, CHANNEL),
      upsertChannel: (input) => record("upsertChannel", input, CHANNEL),
      listThreads: (input) =>
        record("listThreads", input, { threads: posts.map(summary), nextCursor: "next-page" }),
      readThread: (input) =>
        record("readThread", input, { summary: summary(), members: [MEMBER], posts }),
      readPost: (input) => record("readPost", input, POST),
      searchPosts: (input) => record("searchPosts", input, posts),
      post: (input) =>
        record("post", input, {
          ...POST,
          id: input.destination.kind === "channel" ? ROOT : BoardPostId.make("reply-1"),
          text: input.text,
        }),
      markRead: (input) => record("markRead", input, undefined),
      subscribe: (input) => record("subscribe", input, undefined),
      unsubscribe: (input) => record("unsubscribe", input, undefined),
      listSubscribers: (input) => record("listSubscribers", input, options.subscribers ?? []),
      ...options.board,
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([]),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed(
          threadId === IDLE
            ? { ...liveThreadShell(threadId, { activeRunId: null }), status: "idle" as const }
            : liveThreadShell(threadId),
        ),
    }),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      sendToThread: (_scope, input) =>
        Ref.update(deliveries, (items) => [
          ...items,
          { threadId: input.threadId, mode: input.mode, message: input.message },
        ]).pipe(
          Effect.andThen(
            input.threadId === FAILED
              ? Effect.fail(
                  new OrchestratorMcpFailure({ code: "thread_not_found", message: "Missing" }),
                )
              : Effect.succeed({
                  threadId: input.threadId,
                  link: "[Sibling](t3-thread://v1/sibling)",
                  messageId: MessageId.make("notification-1"),
                  runId: RunId.make("run-1"),
                  status: "running" as const,
                  delivery: "steered" as const,
                }),
          ),
        ),
    }),
  );
  const toolkit = yield* MessageBoardToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(MessageBoardHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof MessageBoardToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scope = invocation,
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (items) => items.at(-1)!.result as Tool.Success<(typeof MessageBoardToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(layerDependencies),
    );
  return { call, operations, deliveries };
});

describe("message board MCP handlers", () => {
  it.effect("appends without subscribing the author or notifying subscribers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ subscribers: [{ kind: "thread", threadId: ACTIVE }] });
      const result = yield* harness.call("board_append", { thread_id: ROOT, text: "Log line" });
      expect(result.post).toMatchObject({ text: "Log line", author: NAMED_AUTHOR });
      expect((yield* Ref.get(harness.operations)).map((item) => item.operation)).toEqual(["post"]);
      expect(yield* Ref.get(harness.deliveries)).toEqual([]);
    }),
  );

  it.effect("upserts a channel description without subscribing anyone", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("board_upsert_channel", {
        channel_name: "findings",
        description: "Confirmed findings only",
      });
      expect(yield* Ref.get(harness.operations)).toEqual([
        {
          operation: "upsertChannel",
          input: { author: AUTHOR, name: "findings", description: "Confirmed findings only" },
        },
      ]);
    }),
  );

  it.effect("subscribes another existing agent, and rejects unknown ones without writing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const subscribed = yield* harness.call("board_subscribe", {
        thread_id: ROOT,
        target_thread: IDLE,
      });
      const unsubscribed = yield* harness.call("board_unsubscribe", {
        channel_name: "findings",
        target_thread: IDLE,
      });
      expect(subscribed).toEqual({ subscribed: true, threadId: IDLE });
      expect(unsubscribed).toEqual({ subscribed: false, threadId: IDLE });
      expect(yield* Ref.get(harness.operations)).toEqual([
        {
          operation: "subscribe",
          input: {
            viewer: { kind: "thread", threadId: IDLE },
            target: { kind: "thread", rootId: ROOT },
          },
        },
        {
          operation: "unsubscribe",
          input: {
            viewer: { kind: "thread", threadId: IDLE },
            target: { kind: "channel", channelName: "findings" },
          },
        },
      ]);
      const error = yield* harness
        .call("board_subscribe", { thread_id: ROOT, target_thread: FAILED })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "MessageBoardError", code: "not_found" });
      expect(yield* Ref.get(harness.operations)).toHaveLength(2);
    }),
  );

  it.effect("requires a calling thread rather than accepting an author argument", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("board_get_channels", {}, { ...invocation, thread: undefined })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code: "thread_credential_required",
      });
      expect(yield* Ref.get(harness.operations)).toEqual([]);
    }),
  );

  it.effect("uses the caller's unread counts and bounds list previews while retaining ids", () =>
    Effect.gen(function* () {
      const longPost = { ...POST, text: "a".repeat(5_000) };
      const harness = yield* makeHarness({ posts: [longPost] });
      const channels = yield* harness.call("board_get_channels", { query: "find" });
      const listed = yield* harness.call("board_list_threads", { channel_name: "findings" });
      const searched = yield* harness.call("board_search_posts", {});
      expect(channels.channels[0]?.unreadCount).toBe(3);
      expect(channels).toMatchObject({
        you: { name: boardPersona(CALLER).name, threadId: CALLER },
      });
      expect(channels.channels[0]?.createdBy).toEqual(NAMED_AUTHOR);
      expect(listed.nextCursor).toBe("next-page");
      expect(listed.threads[0]?.root).toMatchObject({ id: ROOT, textTruncated: true });
      expect(listed.threads[0]?.root.author).toEqual(NAMED_AUTHOR);
      expect(listed.threads[0]?.participants).toEqual([NAMED_AUTHOR]);
      expect(listed.threads[0]?.root.text.length).toBeLessThanOrEqual(1_001);
      expect(searched.posts[0]?.text.length).toBeLessThanOrEqual(1_001);
      expect(searched.posts[0]?.author).toEqual(NAMED_AUTHOR);
      expect(yield* Ref.get(harness.operations)).toContainEqual({
        operation: "listChannels",
        input: { viewer: { kind: "thread", threadId: CALLER }, query: "find" },
      });
    }),
  );

  it.effect(
    "marks the thread read only after reading, bounds long threads, and permits full post reads",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          posts: Array.from({ length: 60 }, (_, index) => ({
            ...POST,
            id: BoardPostId.make(`post-${index}`),
            text: "a".repeat(5_000),
          })),
        });
        const result = yield* harness.call("board_read_thread", { thread_id: ROOT });
        const fullPost = yield* harness.call("board_read_post", { message_id: ROOT });
        expect(result.posts).toHaveLength(50);
        expect(result.postsOmitted).toBe(10);
        expect(result.summary.unread).toBe(false);
        expect(result).toMatchObject({ members: [{ ...MEMBER, author: NAMED_AUTHOR }] });
        expect(result.posts[0]?.author).toEqual(NAMED_AUTHOR);
        expect(result.posts[0]?.id).toBe("post-0");
        expect(result.posts.at(-1)?.id).toBe("post-59");
        expect(result.posts.reduce((length, post) => length + post.text.length, 0)).toBeLessThan(
          24_100,
        );
        expect(fullPost).toEqual({ ...POST, author: NAMED_AUTHOR });
        expect((yield* Ref.get(harness.operations)).map((item) => item.operation)).toEqual([
          "readThread",
          "markRead",
          "readPost",
        ]);
        expect((yield* Ref.get(harness.operations))[1]?.input).toEqual({
          viewer: { kind: "thread", threadId: CALLER },
          rootId: ROOT,
        });
      }),
  );

  it.effect("does not mark a thread read after a failed read", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        board: {
          readThread: () =>
            Effect.fail(new MessageBoardError({ code: "not_found", message: "Missing" })),
        },
      });
      const error = yield* harness.call("board_read_thread", { thread_id: ROOT }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "MessageBoardError", code: "not_found" });
      expect(yield* Ref.get(harness.operations)).toEqual([]);
    }),
  );

  it.effect("rejects missing and ambiguous destinations without writing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      for (const target of [{}, { channel_name: "findings", thread_id: ROOT }]) {
        const error = yield* harness
          .call("board_post", { ...target, text: "Finding" })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "MessageBoardDestinationError" });
      }
      const error = yield* harness.call("board_subscribe", {}).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "MessageBoardDestinationError" });
      expect(yield* Ref.get(harness.operations)).toEqual([]);
    }),
  );

  it.effect("subscribes channel creators by default and respects subscribe false", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const channel = yield* harness.call("board_create_channel", { channel_name: "findings" });
      expect(channel.createdBy).toEqual(NAMED_AUTHOR);
      yield* harness.call("board_create_channel", { channel_name: "findings", subscribe: false });
      const subscriptions = (yield* Ref.get(harness.operations)).filter(
        (item) => item.operation === "subscribe",
      );
      expect(subscriptions).toEqual([
        {
          operation: "subscribe",
          input: {
            viewer: { kind: "thread", threadId: CALLER },
            target: { kind: "channel", channelName: "findings" },
          },
        },
      ]);
    }),
  );

  it.effect(
    "notifies active channel subscribers, skips idle and author, and sends explicit targets once",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          subscribers: [
            { kind: "thread", threadId: CALLER },
            { kind: "thread", threadId: ACTIVE },
            { kind: "thread", threadId: IDLE },
            { kind: "thread", threadId: EXPLICIT },
            { kind: "user" },
          ],
        });
        const result = yield* harness.call("board_post", {
          channel_name: "findings",
          text: "Found\na bug",
          notify_threads: [EXPLICIT, EXPLICIT, CALLER, FAILED],
        });
        expect(result.notifiedThreads).toEqual([EXPLICIT, ACTIVE]);
        expect(result.post.author).toEqual(NAMED_AUTHOR);
        expect(result.skippedThreads).toEqual([FAILED, IDLE]);
        expect(yield* Ref.get(harness.deliveries)).toEqual([
          { threadId: EXPLICIT, mode: "auto", message: expect.stringContaining("Found a bug") },
          { threadId: FAILED, mode: "auto", message: expect.any(String) },
          {
            threadId: ACTIVE,
            mode: "steer",
            message: expect.stringContaining(`board_read_thread ${ROOT}`),
          },
        ]);
        expect(yield* Ref.get(harness.operations)).toContainEqual({
          operation: "subscribe",
          input: {
            viewer: { kind: "thread", threadId: CALLER },
            target: { kind: "thread", rootId: ROOT },
          },
        });
        expect(yield* Ref.get(harness.operations)).toContainEqual({
          operation: "listSubscribers",
          input: { kind: "channel", channelName: "findings" },
        });
        for (const delivery of yield* Ref.get(harness.deliveries)) {
          expect(delivery.message).toContain(`by ${boardPersona(CALLER).name} (${CALLER})`);
        }
      }),
  );

  it.effect("uses board-thread subscribers for replies and supports unsubscribing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("board_post", { thread_id: ROOT, text: "Reply" });
      yield* harness.call("board_unsubscribe", { thread_id: ROOT });
      expect(yield* Ref.get(harness.operations)).toContainEqual({
        operation: "listSubscribers",
        input: { kind: "thread", rootId: ROOT },
      });
      expect(yield* Ref.get(harness.operations)).toContainEqual({
        operation: "unsubscribe",
        input: {
          viewer: { kind: "thread", threadId: CALLER },
          target: { kind: "thread", rootId: ROOT },
        },
      });
    }),
  );

  it.effect("does not start an idle subscriber if a running turn ends before delivery", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ subscribers: [{ kind: "thread", threadId: FAILED }] });
      const result = yield* harness.call("board_post", {
        channel_name: "findings",
        text: "Finding",
      });
      expect(result.notifiedThreads).toEqual([]);
      expect(result.skippedThreads).toEqual([FAILED]);
      expect(yield* Ref.get(harness.deliveries)).toMatchObject([
        { threadId: FAILED, mode: "steer" },
      ]);
      expect(result.post.id).toBe(ROOT);
    }),
  );

  it.effect(
    "keeps a saved post successful when subscriber lookup fails and still sends explicit notifications",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          board: {
            listSubscribers: () =>
              Effect.fail(new MessageBoardError({ code: "not_found", message: "Missing" })),
          },
        });
        const result = yield* harness.call("board_post", {
          channel_name: "findings",
          text: "Finding",
          notify_threads: [EXPLICIT],
        });
        expect(result.post.id).toBe(ROOT);
        expect(result.notificationWarning).toBeDefined();
        expect(result.notifiedThreads).toEqual([EXPLICIT]);
      }),
  );
});
