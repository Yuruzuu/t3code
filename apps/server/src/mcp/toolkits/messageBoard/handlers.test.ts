import {
  BoardPostId,
  EnvironmentId,
  MessageBoardError,
  ProviderInstanceId,
  ThreadId,
  type BoardAuthor,
  type BoardChannel,
  type BoardPost,
  type BoardThreadSummary,
  type BoardViewer,
  type BoardTodoItem,
} from "@t3tools/contracts";
import { boardPersona } from "@t3tools/shared/boardPersona";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";
import { McpSchema, McpServer } from "effect/ai";

import * as MessageBoardService from "../../../messageBoard/MessageBoardService.ts";
import * as Reader from "../../../messageBoard/MessageBoardAgentReader.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { toolkitRegistration } from "../../McpHttpServer.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
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
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "todo-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "todo-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const makeHarness = Effect.fn("makeMessageBoardToolkitHarness")(function* (
  options: {
    board?: Partial<MessageBoardService.MessageBoardService["Service"]>;
    reader?: Partial<Reader.MessageBoardAgentReader["Service"]>;
    subscribers?: ReadonlyArray<BoardViewer>;
    posts?: ReadonlyArray<BoardPost>;
    notificationFailed?: boolean;
  } = {},
) {
  const operations = yield* Ref.make<ReadonlyArray<{ operation: string; input: unknown }>>([]);
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
      postAndNotify: (input) =>
        record("postAndNotify", input, {
          post: { ...POST, text: input.text },
          notifiedThreads: [ACTIVE],
          skippedThreads: [IDLE],
          coalescedThreads: [],
          notificationFailed: options.notificationFailed ?? false,
        }),
      react: (input) => record("react", input, undefined),
      markRead: (input) => record("markRead", input, undefined),
      subscribe: (input) => record("subscribe", input, undefined),
      unsubscribe: (input) => record("unsubscribe", input, undefined),
      listSubscribers: (input) => record("listSubscribers", input, options.subscribers ?? []),
      ...options.board,
    }),
    Layer.mock(Reader.MessageBoardAgentReader)({
      listThreads: (input) =>
        record("listThreads", input, {
          threads: posts.map((post) => ({
            ...summary(post),
            root: {
              ...Reader.namedPost(post),
              text: post.text.slice(0, 1_000),
              textTruncated: post.text.length > 1_000,
            },
            latestReply: null,
            participants: [NAMED_AUTHOR],
          })),
          nextCursor: "next-page",
        }),
      readThread: (input) =>
        record("readThread", input, {
          summary: {
            ...summary(),
            root: { ...Reader.namedPost(POST), textTruncated: false },
            participants: [NAMED_AUTHOR],
            latestReply: null,
          },
          posts: [
            {
              ...Reader.namedPost(POST),
              textOffset: 0,
              textTotalChars: POST.text.length,
              textTruncated: false,
              nextCursor: null,
            },
          ],
          members: [{ ...MEMBER, author: NAMED_AUTHOR }],
          reactions: [],
          todos: [],
          todosRevision: 0,
          snapshot: POST.createdAt,
          nextCursor: null,
        }),
      readPost: (input) =>
        record("readPost", input, {
          ...Reader.namedPost(POST),
          textOffset: 0,
          textTotalChars: POST.text.length,
          textTruncated: false,
          nextCursor: null,
        }),
      search: (input) =>
        record("search", input, {
          posts: posts.map((post) => ({
            ...Reader.namedPost(post),
            text: post.text.slice(0, 1_000),
            textTruncated: post.text.length > 1_000,
          })),
          nextCursor: null,
        }),
      ...options.reader,
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
  const callWire = (
    name: keyof typeof MessageBoardToolkit.tools,
    params: Record<string, unknown>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        return yield* server
          .callTool({ name, arguments: params })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      }).pipe(
        Effect.provide(
          toolkitRegistration(MessageBoardToolkit, MessageBoardHandlers.layer).pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provide(layerDependencies),
          ),
        ),
      ),
    );
  return { call, callWire, operations };
});

describe("message board MCP handlers", () => {
  it.effect(
    "preserves nullable reassignment, authenticated actor, and historical acknowledgements",
    () =>
      Effect.gen(function* () {
        const item: BoardTodoItem = {
          id: "task-1",
          rootId: ROOT,
          text: "Review parser",
          status: "todo",
          version: 4,
          assigneeThreadId: null,
          history: [],
          createdAt: POST.createdAt,
          updatedAt: POST.createdAt,
        };
        const acknowledgement = {
          item,
          todoId: item.id,
          version: 4,
          todosRevision: 8,
          replay: true,
          removed: false,
        };
        const seen = yield* Ref.make<unknown>(null);
        const harness = yield* makeHarness({
          board: {
            applyTodoAction: (input) => Ref.set(seen, input).pipe(Effect.as(acknowledgement)),
          },
        });
        const result = yield* harness.call("board_todo_action", {
          thread_id: ROOT,
          request_key: "release-reservation",
          action: {
            type: "reassign",
            todoId: item.id,
            expectedVersion: 3,
            assigneeThreadId: null,
            reason: "Available for another worker",
          },
        });
        expect(result).toEqual(acknowledgement);
        expect(result).not.toHaveProperty("todos");
        expect(yield* Ref.get(seen)).toEqual({
          rootId: ROOT,
          requestKey: "release-reservation",
          viewer: { kind: "thread", threadId: CALLER },
          action: {
            type: "reassign",
            todoId: item.id,
            expectedVersion: 3,
            assigneeThreadId: null,
            reason: "Available for another worker",
          },
        });
      }),
  );

  it.effect("reads a known task without reading discussion history or advancing Seen", () =>
    Effect.gen(function* () {
      const conflict = new MessageBoardError({
        code: "conflict",
        message: "Inspect the current task.",
        todoConflict: {
          kind: "missing",
          rootId: ROOT,
          todoId: "task-removed",
          current: null,
          todosRevision: 9,
        },
      });
      const harness = yield* makeHarness({ board: { getTodo: () => Effect.fail(conflict) } });
      const result = yield* harness.callWire("board_read_todos", {
        thread_id: ROOT,
        query: { type: "get", todoId: "task-removed" },
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        error: {
          _tag: "MessageBoardError",
          todoConflict: {
            kind: "missing",
            rootId: ROOT,
            todoId: "task-removed",
            current: null,
            todosRevision: 9,
          },
        },
      });
      expect(yield* Ref.get(harness.operations)).toEqual([]);
    }),
  );

  it.effect("appends without subscribing the author or notifying subscribers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ subscribers: [{ kind: "thread", threadId: ACTIVE }] });
      const result = yield* harness.call("board_append", { thread_id: ROOT, text: "Log line" });
      expect(result.post).toMatchObject({ text: "Log line", author: NAMED_AUTHOR });
      expect((yield* Ref.get(harness.operations)).map((item) => item.operation)).toEqual(["post"]);
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

  it.effect("does not mark a thread read after a failed read", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        reader: {
          readThread: () =>
            Effect.fail(new MessageBoardError({ code: "not_found", message: "Missing" })),
        },
      });
      const error = yield* harness.call("board_read_thread", { thread_id: ROOT }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "MessageBoardError", code: "not_found" });
      expect(yield* Ref.get(harness.operations)).toEqual([]);
    }),
  );

  it.effect("preserves recoverable handling conflicts through MCP", () =>
    Effect.gen(function* () {
      const conflict = new MessageBoardError({
        code: "conflict",
        message: "Review the current generation.",
        conflict: { kind: "generation", rootId: ROOT, revision: 8, responsibilityId: "request-1" },
      });
      const harness = yield* makeHarness({ board: { resumeRequest: () => Effect.fail(conflict) } });
      const error = yield* harness
        .call("board_resume_request", {
          rootId: ROOT,
          responsibilityId: "request-1",
          expectedRevision: 7,
          expectedGeneration: 0,
        })
        .pipe(Effect.flip);
      expect(error).toEqual(conflict);
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

  it.effect("posts through the service with reply_to and notify_threads", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const reply = BoardPostId.make("reply-0");
      const result = yield* harness.call("board_post", {
        thread_id: ROOT,
        text: "Fixed",
        reply_to: reply,
        notify_threads: [EXPLICIT],
      });
      expect(result.post.author).toEqual(NAMED_AUTHOR);
      expect(result.notifiedThreads).toEqual([ACTIVE]);
      expect(result.skippedThreads).toEqual([IDLE]);
      expect(result.notificationWarning).toBeUndefined();
      expect(yield* Ref.get(harness.operations)).toContainEqual({
        operation: "postAndNotify",
        input: {
          author: AUTHOR,
          destination: { kind: "reply", rootId: ROOT },
          text: "Fixed",
          replyToId: reply,
          notifyThreads: [EXPLICIT],
        },
      });
    }),
  );

  it.effect("warns when a post is saved but its recipients could not be loaded", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ notificationFailed: true });
      const result = yield* harness.call("board_post", { channel_name: "findings", text: "Hi" });
      expect(result.notificationWarning).toBeDefined();
    }),
  );

  it.effect("reacts as the caller and removes the reaction", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call("board_react", { message_id: ROOT, emoji: "👍" });
      const removed = yield* harness.call("board_react", {
        message_id: ROOT,
        emoji: "👍",
        remove: true,
      });
      expect(removed.active).toBe(false);
      const reacts = (yield* Ref.get(harness.operations)).filter(
        (item) => item.operation === "react",
      );
      expect(reacts.map((item) => item.input)).toEqual([
        { viewer: { kind: "thread", threadId: CALLER }, postId: ROOT, emoji: "👍", active: true },
        { viewer: { kind: "thread", threadId: CALLER }, postId: ROOT, emoji: "👍", active: false },
      ]);
    }),
  );
});
