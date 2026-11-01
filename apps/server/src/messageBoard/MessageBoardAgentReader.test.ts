import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { BoardPostId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Reader from "./MessageBoardAgentReader.ts";
import * as MessageBoardService from "./MessageBoardService.ts";

const viewer = { kind: "thread", threadId: ThreadId.make("reader") } as const;
const author = { kind: "user" } as const;
const layer = Reader.layer.pipe(
  Layer.provideMerge(MessageBoardService.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThreadShell: () => Effect.succeed(null) }),
  ),
  Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
  Layer.provide(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(null),
    }),
  ),
  Layer.provide(NodeServices.layer),
);

it.effect(
  "resumes escaped Unicode text and todos across a fixed snapshot without reading gaps or later arrivals",
  () =>
    Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const reader = yield* Reader.MessageBoardAgentReader;
      const root = yield* board.post({
        author,
        destination: { kind: "channel", channelName: "pages" },
        text: "Root",
      });
      const originals = new Map([[root.id, root.text]]);
      for (let index = 0; index < 55; index += 1) {
        const post = yield* board.post({
          author,
          destination: { kind: "reply", rootId: root.id },
          text: `${index}:` + '\\"\n😀'.repeat(1_000),
        });
        originals.set(post.id, post.text);
      }
      const lastId = [...originals.keys()].at(-1)!;
      yield* reader.readPost({ viewer, postId: lastId });
      assert.isTrue(
        (yield* board.listThreads({ viewer, channelName: "pages", sort: "created" })).threads[0]!
          .unread,
      );
      yield* board.applyTodoAction({
        rootId: root.id,
        requestKey: "keep-checklist",
        viewer,
        action: {
          type: "create",
          text: "Keep the checklist",
          status: "blocked",
          reason: "Waiting for parser",
        },
      });
      let page = yield* reader.readThread({ viewer, rootId: root.id });
      assert.isTrue(page.summary.unread);
      const later = yield* board.post({
        author,
        destination: { kind: "reply", rootId: root.id },
        text: "Arrived after the snapshot",
      });
      const received = new Map<BoardPostId, string>();
      const todos: string[] = [];
      for (;;) {
        assert.isAtMost(
          new TextEncoder().encode(JSON.stringify(page)).length,
          Reader.RESPONSE_MAX_BYTES,
        );
        for (const post of page.posts) {
          assert.equal(post.textOffset, received.get(post.id)?.length ?? 0);
          assert.isFalse(/[\uD800-\uDBFF]$/.test(post.text));
          received.set(post.id, (received.get(post.id) ?? "") + post.text);
        }
        todos.push(...page.todos.map((todo) => todo.text));
        for (const todo of page.todos) {
          assert.equal(todo.version, 1);
          assert.equal(todo.status, "blocked");
          assert.equal(todo.blockerReason, "Waiting for parser");
          assert.equal(todo.history[0]?.action, "create");
        }
        if (page.nextCursor === null) break;
        page = yield* reader.readThread({ viewer, rootId: root.id, cursor: page.nextCursor });
      }
      assert.deepEqual(received, originals);
      assert.deepEqual(todos, ["Keep the checklist"]);
      assert.isTrue(page.summary.unread);
      const final = yield* reader.readPost({ viewer, postId: later.id });
      assert.isNull(final.nextCursor);
      assert.isFalse(
        (yield* board.listThreads({ viewer, channelName: "pages", sort: "created" })).threads[0]!
          .unread,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "merges out-of-order chunks durably and rejects cursors for another post or discussion",
  () =>
    Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const reader = yield* Reader.MessageBoardAgentReader;
      const root = yield* board.post({
        author,
        destination: { kind: "channel", channelName: "chunks" },
        text: "x".repeat(9_000),
      });
      const tailCursor = JSON.stringify({ kind: "post", postId: root.id, offset: 8_000 });
      yield* reader.readPost({ viewer, postId: root.id, cursor: tailCursor });
      const first = yield* reader.readPost({ viewer, postId: root.id });
      assert.isTrue(
        (yield* board.listThreads({ viewer, channelName: "chunks", sort: "created" })).threads[0]!
          .unread,
      );
      yield* reader.readPost({ viewer, postId: root.id, cursor: first.nextCursor! });
      assert.isFalse(
        (yield* board.listThreads({ viewer, channelName: "chunks", sort: "created" })).threads[0]!
          .unread,
      );
      const other = yield* board.post({
        author,
        destination: { kind: "channel", channelName: "chunks" },
        text: "Other",
      });
      const error = yield* reader
        .readPost({ viewer, postId: other.id, cursor: first.nextCursor! })
        .pipe(Effect.flip);
      assert.equal(error._tag, "MessageBoardError");
      const page = yield* reader.readThread({ viewer, rootId: root.id });
      const wrongRoot = yield* reader
        .readThread({ viewer, rootId: other.id, cursor: page.nextCursor! })
        .pipe(Effect.flip);
      assert.equal(wrongRoot._tag, "MessageBoardError");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "pages search with stable keys, binds filters and detects todo changes during a discussion read",
  () =>
    Effect.gen(function* () {
      const board = yield* MessageBoardService.MessageBoardService;
      const reader = yield* Reader.MessageBoardAgentReader;
      const root = yield* board.post({
        author,
        destination: { kind: "channel", channelName: "search" },
        text: "Needle".repeat(1_000),
      });
      const reply = yield* board.post({
        author,
        destination: { kind: "reply", rootId: root.id },
        text: "Needle two",
      });
      const first = yield* reader.search({ query: "needle", rootId: root.id, limit: 1 });
      assert.equal(first.posts[0]!.id, reply.id);
      yield* board.post({
        author,
        destination: { kind: "reply", rootId: root.id },
        text: "Needle later",
      });
      const second = yield* reader.search({
        query: "needle",
        rootId: root.id,
        limit: 1,
        cursor: first.nextCursor!,
      });
      assert.deepEqual(
        second.posts.map((post) => post.id),
        [root.id],
      );
      assert.isNull(second.nextCursor);
      const invalid = yield* reader
        .search({ query: "other", cursor: first.nextCursor! })
        .pipe(Effect.flip);
      assert.equal(invalid._tag, "MessageBoardError");
      const page = yield* reader.readThread({ viewer, rootId: root.id });
      yield* board.applyTodoAction({
        rootId: root.id,
        requestKey: "new-todo",
        viewer,
        action: { type: "create", text: "New todo" },
      });
      for (let index = 0; index < 20; index += 1)
        yield* board.applyTodoAction({
          rootId: root.id,
          requestKey: `todo-${index}`,
          viewer,
          action: { type: "create", text: `Todo ${index}` },
        });
      const continued = yield* reader.readThread({
        viewer,
        rootId: root.id,
        cursor: page.nextCursor!,
      });
      assert.equal(continued.posts[0]!.textOffset, 4_000);
      assert.equal(continued.todos.length, 20);
      yield* board.applyTodoAction({
        rootId: root.id,
        requestKey: "changed-pagination",
        viewer,
        action: { type: "create", text: "Changed during todo pagination" },
      });
      const changed = yield* reader
        .readThread({ viewer, rootId: root.id, cursor: continued.nextCursor! })
        .pipe(Effect.flip);
      assert.deepInclude(changed, { code: "conflict" });
    }).pipe(Effect.provide(layer)),
);

it.effect("bounds complete list and search responses and resumes every discussion and member", () =>
  Effect.gen(function* () {
    const board = yield* MessageBoardService.MessageBoardService;
    const reader = yield* Reader.MessageBoardAgentReader;
    const roots: BoardPostId[] = [];
    for (let index = 0; index < 25; index += 1) {
      const root = yield* board.post({
        author,
        destination: { kind: "channel", channelName: "metadata" },
        text: '\\"\n'.repeat(2_000),
      });
      roots.push(root.id);
    }
    const listed: BoardPostId[] = [];
    let cursor: string | null = null;
    do {
      const page: Effect.Success<ReturnType<typeof reader.listThreads>> = yield* reader.listThreads(
        {
          viewer,
          channelName: "metadata",
          sort: "created",
          limit: 100,
          ...(cursor === null ? {} : { cursor }),
        },
      );
      assert.isAtMost(
        new TextEncoder().encode(JSON.stringify(page)).length,
        Reader.RESPONSE_MAX_BYTES,
      );
      listed.push(...page.threads.map((thread) => thread.root.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(listed, roots.toReversed());
    const searched: BoardPostId[] = [];
    do {
      const page: Reader.SearchPage = yield* reader.search({
        channelName: "metadata",
        limit: 100,
        ...(cursor === null ? {} : { cursor }),
      });
      assert.isAtMost(
        new TextEncoder().encode(JSON.stringify(page)).length,
        Reader.RESPONSE_MAX_BYTES,
      );
      searched.push(...page.posts.map((post) => post.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(searched, roots.toReversed());
    const rootId = roots[0]!;
    const agents = Array.from({ length: 23 }, (_, index) => ThreadId.make(`member-${index}`));
    for (const threadId of agents) {
      yield* board.post({
        author: { kind: "agent", threadId, projectId: null, title: threadId, driver: null },
        destination: { kind: "reply", rootId },
        text: "Present",
      });
      yield* board.react({
        viewer: { kind: "thread", threadId },
        postId: rootId,
        emoji: "👍",
        active: true,
      });
    }
    const members: string[] = [];
    const reacted: string[] = [];
    do {
      const page: Reader.ThreadPage = yield* reader.readThread({
        viewer,
        rootId,
        ...(cursor === null ? {} : { cursor }),
      });
      assert.isAtMost(
        new TextEncoder().encode(JSON.stringify(page)).length,
        Reader.RESPONSE_MAX_BYTES,
      );
      members.push(
        ...page.members.flatMap((member) =>
          member.author.kind === "agent" ? [member.author.threadId] : [],
        ),
      );
      reacted.push(
        ...page.reactions.flatMap((reaction) =>
          reaction.by.flatMap((viewer) => (viewer.kind === "thread" ? [viewer.threadId] : [])),
        ),
      );
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.sameMembers(members, agents);
    assert.sameMembers(reacted, agents);
  }).pipe(Effect.provide(layer)),
);
