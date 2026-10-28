import {
  BOARD_CHANNEL_DESCRIPTION_MAX_BYTES,
  BOARD_ROLE_MAX_CHARS,
  BoardAuthor,
  BoardChannel,
  BoardChannelName,
  BoardPost,
  BoardPostId,
  BoardSubscriptionTarget,
  BoardViewer,
  MessageBoardCreateChannelInput,
  MessageBoardError,
  MessageBoardListThreadsInput,
  MessageBoardPostInput,
  type BoardEvent,
  type BoardMember,
  type BoardPostDestination,
  type BoardThreadDetail,
  type BoardThreadSummary,
  type MessageBoardListThreadsResult,
  type MessageBoardMarkReadInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

const PostRow = Schema.Struct({
  ...BoardPost.fields,
  author: Schema.fromJsonString(BoardAuthor),
});
const {
  latestPost: _latestPost,
  recentAuthors: _recentAuthors,
  ...channelFields
} = BoardChannel.fields;
const ChannelRow = Schema.Struct({
  ...channelFields,
  createdBy: Schema.fromJsonString(BoardAuthor),
});
const ThreadCursor = Schema.Struct({
  channelName: BoardChannelName,
  sort: MessageBoardListThreadsInput.fields.sort,
  time: Schema.String,
  id: BoardPostId,
});

export class MessageBoardStorageError extends Schema.TaggedError<MessageBoardStorageError>()(
  "MessageBoardStorageError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return "Unable to access the message board.";
  }
}

type BoardFailure = MessageBoardError | MessageBoardStorageError;
type ListThreadsInput = typeof MessageBoardListThreadsInput.Type & { readonly viewer: BoardViewer };
type SubscriptionInput = { readonly viewer: BoardViewer; readonly target: BoardSubscriptionTarget };

export class MessageBoardService extends Context.Service<
  MessageBoardService,
  {
    readonly agentAuthor: (threadId: ThreadId) => Effect.Effect<BoardAuthor, BoardFailure>;
    /** An empty role clears it. */
    readonly setRole: (input: {
      readonly threadId: ThreadId;
      readonly role: string;
    }) => Effect.Effect<void, BoardFailure>;
    readonly listChannels: (input: {
      readonly viewer: BoardViewer;
      readonly query?: string;
    }) => Effect.Effect<ReadonlyArray<BoardChannel>, BoardFailure>;
    readonly createChannel: (input: {
      readonly author: BoardAuthor;
      readonly name: BoardChannelName;
      readonly description?: string;
    }) => Effect.Effect<BoardChannel, BoardFailure>;
    /** Creates a channel or replaces only its description; posts and subscriptions are kept. */
    readonly upsertChannel: (input: {
      readonly author: BoardAuthor;
      readonly name: BoardChannelName;
      readonly description: string;
    }) => Effect.Effect<BoardChannel, BoardFailure>;
    readonly listThreads: (
      input: ListThreadsInput,
    ) => Effect.Effect<MessageBoardListThreadsResult, BoardFailure>;
    readonly readThread: (input: {
      readonly viewer: BoardViewer;
      readonly rootId: BoardPostId;
    }) => Effect.Effect<BoardThreadDetail, BoardFailure>;
    readonly readPost: (input: {
      readonly postId: BoardPostId;
    }) => Effect.Effect<BoardPost, BoardFailure>;
    readonly searchPosts: (input: {
      readonly viewer: BoardViewer;
      readonly query?: string;
      readonly channelName?: BoardChannelName;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<BoardPost>, BoardFailure>;
    readonly post: (input: {
      readonly author: BoardAuthor;
      readonly destination: BoardPostDestination;
      readonly text: string;
    }) => Effect.Effect<BoardPost, BoardFailure>;
    /** Marks a whole channel, or one discussion (`rootId`), read for the viewer. */
    readonly markRead: (
      input: { readonly viewer: BoardViewer } & MessageBoardMarkReadInput,
    ) => Effect.Effect<void, BoardFailure>;
    readonly subscribe: (input: SubscriptionInput) => Effect.Effect<void, BoardFailure>;
    readonly unsubscribe: (input: SubscriptionInput) => Effect.Effect<void, BoardFailure>;
    readonly listSubscribers: (
      target: BoardSubscriptionTarget,
    ) => Effect.Effect<ReadonlyArray<BoardViewer>, BoardFailure>;
    readonly events: Stream.Stream<BoardEvent>;
  }
>()("t3/messageBoard/MessageBoardService") {}

const viewerKey = (viewer: BoardViewer) =>
  viewer.kind === "user" ? "user" : `thread:${viewer.threadId}`;
const isMessageBoardError = Schema.is(MessageBoardError);
const isMessageBoardStorageError = Schema.is(MessageBoardStorageError);
const decodePosts = Schema.decodeUnknownEffect(Schema.Array(PostRow));
const decodeChannels = Schema.decodeUnknownEffect(Schema.Array(ChannelRow));
const decodeCreateChannel = Schema.decodeEffect(MessageBoardCreateChannelInput);
const decodeAuthor = Schema.decodeEffect(BoardAuthor);
const encodeAuthor = Schema.encodeEffect(Schema.fromJsonString(BoardAuthor));
const decodeListThreads = Schema.decodeEffect(MessageBoardListThreadsInput);
const decodeCursor = Schema.decodeEffect(Schema.fromJsonString(ThreadCursor));
const encodeCursor = Schema.encodeEffect(Schema.fromJsonString(ThreadCursor));
const decodePost = Schema.decodeEffect(MessageBoardPostInput);
const decodeSubscriptionTarget = Schema.decodeEffect(BoardSubscriptionTarget);
const decodeViewers = Schema.decodeUnknownEffect(Schema.Array(BoardViewer));
const targetKey = (target: BoardSubscriptionTarget) =>
  target.kind === "channel" ? target.channelName : target.rootId;
const invalidInput = () =>
  new MessageBoardError({ code: "invalid_input", message: "Invalid message board input." });
const notFound = () =>
  new MessageBoardError({
    code: "not_found",
    message: "Message board channel or post was not found.",
  });

function summarize(posts: ReadonlyArray<BoardPost>, readAt: string | null): BoardThreadSummary {
  const root = posts[0]!;
  const latest = posts[posts.length - 1]!;
  const participants = new Map<string, BoardAuthor>();
  for (const post of posts) {
    const key = post.author.kind === "user" ? "user" : `agent:${post.author.threadId}`;
    if (!participants.has(key) && participants.size < 8) participants.set(key, post.author);
  }
  return {
    root,
    latestReply: posts.length > 1 ? latest : null,
    replyCount: posts.length - 1,
    lastActivityAt: latest.createdAt,
    participants: [...participants.values()],
    unread: readAt === null || latest.createdAt > readAt,
  };
}

export const agentAuthorForThread = Effect.fn("MessageBoardService.agentAuthorForThread")(
  function* (
    threadId: ThreadId,
  ): Effect.fn.Return<
    BoardAuthor,
    BoardFailure,
    ProjectionStore.ProjectionStoreV2 | ProviderRegistry.ProviderRegistry
  > {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const thread = yield* projections
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError(
          (cause) => new MessageBoardStorageError({ operation: "agentAuthorForThread", cause }),
        ),
      );
    if (thread === null || thread.deletedAt !== null) return yield* notFound();
    const providerList = yield* providers.getProviders;
    const selection = thread.modelSelection;
    const model = providerList
      .find((provider) => provider.instanceId === selection.instanceId)
      ?.models.find((candidate) => candidate.slug === selection.model);
    return {
      kind: "agent",
      threadId,
      projectId: thread.projectId,
      title: thread.title,
      driver:
        providerList.find((provider) => provider.instanceId === thread.providerInstanceId)
          ?.driver ?? null,
      model: model?.shortName ?? model?.name ?? selection.model,
    };
  },
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const changes = yield* PubSub.unbounded<BoardEvent>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
  const writes = yield* Semaphore.make(1);
  const initial = yield* sql<{ latest: string | null }>`
    SELECT MAX(stamp) AS latest FROM (
      SELECT MAX(created_at) AS stamp FROM board_posts
      UNION ALL SELECT MAX(created_at) FROM board_channels
      UNION ALL SELECT MAX(read_at) FROM board_read_markers
      UNION ALL SELECT MAX(read_at) FROM board_thread_read_markers
    )
  `.pipe(Effect.orDie);
  let lastTimestamp = initial[0]?.latest ? Date.parse(initial[0].latest) : 0;

  // Strictly ordered stamps distinguish posts and read markers even within one clock tick.
  const timestamp = Clock.currentTimeMillis.pipe(
    Effect.map((now) => {
      lastTimestamp = Math.max(now, lastTimestamp + 1);
      return DateTime.formatIso(DateTime.makeUnsafe(lastTimestamp));
    }),
  );
  const storage = (operation: string) =>
    Effect.mapError((cause: unknown) =>
      isMessageBoardError(cause) || isMessageBoardStorageError(cause)
        ? cause
        : new MessageBoardStorageError({ operation, cause }),
    );
  const agentAuthor: MessageBoardService["Service"]["agentAuthor"] = Effect.fn(
    "MessageBoardService.agentAuthor",
  )(function* (threadId) {
    const author = yield* agentAuthorForThread(threadId).pipe(
      Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
      Effect.provideService(ProviderRegistry.ProviderRegistry, providers),
    );
    const rows = yield* sql<{ role: string }>`
      SELECT role FROM board_roles WHERE thread_id = ${threadId}
    `.pipe(storage("agentAuthor"));
    const role = rows[0]?.role;
    return author.kind === "agent" && role !== undefined ? { ...author, role } : author;
  });

  const setRole: MessageBoardService["Service"]["setRole"] = Effect.fn(
    "MessageBoardService.setRole",
  )(function* ({ threadId, role }) {
    const trimmed = role.trim();
    if (trimmed.length > BOARD_ROLE_MAX_CHARS) return yield* invalidInput();
    if (trimmed === "") {
      yield* sql`DELETE FROM board_roles WHERE thread_id = ${threadId}`;
      return;
    }
    const now = yield* timestamp;
    yield* sql`
      INSERT INTO board_roles (thread_id, role, updated_at) VALUES (${threadId}, ${trimmed}, ${now})
      ON CONFLICT (thread_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
    `;
  }, storage("setRole"));

  const listChannels: MessageBoardService["Service"]["listChannels"] = Effect.fn(
    "MessageBoardService.listChannels",
  )(function* (input) {
    const query = input.query?.trim() ?? "";
    const rows = yield* sql`
      SELECT c.name, c.description, c.created_by_json AS "createdBy", c.created_at AS "createdAt",
        COALESCE(MAX(p.created_at), c.created_at) AS "lastActivityAt",
        COUNT(CASE WHEN p.id = p.root_id THEN 1 END) AS "threadCount",
        COUNT(p.id) AS "postCount",
        COUNT(CASE WHEN p.created_at > MAX(COALESCE(m.read_at, ''), COALESCE(t.read_at, '')) THEN 1 END) AS "unreadCount"
      FROM board_channels c
      LEFT JOIN board_posts p ON p.channel_name = c.name
      LEFT JOIN board_read_markers m ON m.channel_name = c.name AND m.viewer_key = ${viewerKey(input.viewer)}
      LEFT JOIN board_thread_read_markers t ON t.root_id = p.root_id AND t.viewer_key = ${viewerKey(input.viewer)}
      WHERE ${query === "" ? sql`1` : sql`instr(lower(c.name), lower(${query})) > 0 OR instr(lower(COALESCE(c.description, '')), lower(${query})) > 0`}
      GROUP BY c.name
      ORDER BY "lastActivityAt" DESC, c.name ASC
    `;
    const channels = yield* decodeChannels(rows);
    const recentRows = yield* sql`
      SELECT id, channel_name AS "channelName", root_id AS "rootId", author_json AS author, text,
        created_at AS "createdAt"
      FROM (
        SELECT p.*, ROW_NUMBER() OVER (
          PARTITION BY p.channel_name ORDER BY p.created_at DESC, p.id DESC
        ) AS rank
        FROM board_posts p
      )
      WHERE rank <= 12
      ORDER BY "createdAt" DESC, id DESC
    `;
    const recent = Map.groupBy(yield* decodePosts(recentRows), (post) => post.channelName);
    return channels.map((channel): BoardChannel => {
      const posts = recent.get(channel.name) ?? [];
      const authors = new Map<string, BoardAuthor>();
      for (const post of posts) {
        const key = post.author.kind === "user" ? "user" : post.author.threadId;
        if (!authors.has(key) && authors.size < 5) authors.set(key, post.author);
      }
      return { ...channel, latestPost: posts[0] ?? null, recentAuthors: [...authors.values()] };
    });
  }, storage("listChannels"));

  const channelForUser = Effect.fn("MessageBoardService.channelForUser")(function* (
    name: BoardChannelName,
  ) {
    const channels = yield* listChannels({ viewer: { kind: "user" }, query: name });
    const channel = channels.find((item) => item.name === name);
    if (!channel) return yield* notFound();
    return channel;
  });

  const createChannel: MessageBoardService["Service"]["createChannel"] = Effect.fn(
    "MessageBoardService.createChannel",
  )(
    function* (input) {
      const decoded = yield* decodeCreateChannel(input).pipe(Effect.mapError(invalidInput));
      const author = yield* decodeAuthor(input.author).pipe(Effect.mapError(invalidInput));
      const authorJson = yield* encodeAuthor(author);
      if (
        decoded.description !== undefined &&
        new TextEncoder().encode(decoded.description).length > BOARD_CHANNEL_DESCRIPTION_MAX_BYTES
      )
        return yield* invalidInput();
      const channel = yield* sql.withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql<{
            description: string | null;
          }>`SELECT description FROM board_channels WHERE name = ${decoded.name}`;
          if (
            existing[0] &&
            decoded.description !== undefined &&
            existing[0].description !== decoded.description
          ) {
            return yield* new MessageBoardError({
              code: "conflict",
              message: "A channel with a different description already exists.",
            });
          }
          if (!existing[0]) {
            const createdAt = yield* timestamp;
            yield* sql`INSERT INTO board_channels (name, description, created_by_json, created_at)
          VALUES (${decoded.name}, ${decoded.description ?? null}, ${authorJson}, ${createdAt})`;
          }
          return yield* channelForUser(decoded.name);
        }),
      );
      yield* PubSub.publish(changes, { type: "channel-upserted", channel });
      return channel;
    },
    writes.withPermit,
    storage("createChannel"),
  );

  const upsertChannel: MessageBoardService["Service"]["upsertChannel"] = Effect.fn(
    "MessageBoardService.upsertChannel",
  )(
    function* (input) {
      const decoded = yield* decodeCreateChannel(input).pipe(Effect.mapError(invalidInput));
      const author = yield* decodeAuthor(input.author).pipe(Effect.mapError(invalidInput));
      const authorJson = yield* encodeAuthor(author);
      if (new TextEncoder().encode(input.description).length > BOARD_CHANNEL_DESCRIPTION_MAX_BYTES)
        return yield* invalidInput();
      const channel = yield* sql.withTransaction(
        Effect.gen(function* () {
          const createdAt = yield* timestamp;
          yield* sql`INSERT INTO board_channels (name, description, created_by_json, created_at)
          VALUES (${decoded.name}, ${input.description}, ${authorJson}, ${createdAt})
          ON CONFLICT (name) DO UPDATE SET description = excluded.description`;
          return yield* channelForUser(decoded.name);
        }),
      );
      yield* PubSub.publish(changes, { type: "channel-upserted", channel });
      return channel;
    },
    writes.withPermit,
    storage("upsertChannel"),
  );

  const readPost: MessageBoardService["Service"]["readPost"] = Effect.fn(
    "MessageBoardService.readPost",
  )(function* ({ postId }) {
    const rows =
      yield* sql`SELECT id, channel_name AS "channelName", root_id AS "rootId", author_json AS author, text, created_at AS "createdAt"
      FROM board_posts WHERE id = ${postId}`;
    const posts = yield* decodePosts(rows);
    if (!posts[0]) return yield* notFound();
    return posts[0];
  }, storage("readPost"));

  /** Per discussion, the later of the channel-wide and the discussion's own read marker. */
  const readMarkers = Effect.fn("MessageBoardService.readMarkers")(function* (
    viewer: BoardViewer,
    channelName: BoardChannelName,
    rootIds: ReadonlyArray<BoardPostId>,
  ) {
    const channelRows = yield* sql<{ read_at: string }>`SELECT read_at FROM board_read_markers
      WHERE viewer_key = ${viewerKey(viewer)} AND channel_name = ${channelName}`;
    const threadRows = yield* sql<{ root_id: string; read_at: string }>`
      SELECT root_id, read_at FROM board_thread_read_markers
      WHERE viewer_key = ${viewerKey(viewer)} AND ${sql.in("root_id", rootIds)}`;
    const channelReadAt = channelRows[0]?.read_at ?? null;
    const threadReadAt = new Map(threadRows.map((row) => [row.root_id, row.read_at]));
    return (rootId: BoardPostId) => {
      const own = threadReadAt.get(rootId) ?? null;
      return own !== null && (channelReadAt === null || own > channelReadAt) ? own : channelReadAt;
    };
  }, storage("readMarkers"));

  const readThread: MessageBoardService["Service"]["readThread"] = Effect.fn(
    "MessageBoardService.readThread",
  )(function* ({ viewer, rootId }) {
    const root = yield* readPost({ postId: rootId });
    if (root.rootId !== root.id) return yield* notFound();
    const rows =
      yield* sql`SELECT id, channel_name AS "channelName", root_id AS "rootId", author_json AS author, text, created_at AS "createdAt"
      FROM board_posts WHERE root_id = ${rootId} ORDER BY created_at ASC, id ASC`;
    const posts = yield* decodePosts(rows);
    const members = new Map<ThreadId, BoardMember>();
    for (const post of posts) {
      if (post.author.kind !== "agent") continue;
      const previous = members.get(post.author.threadId);
      members.set(post.author.threadId, {
        author: post.author,
        subscribed: false,
        postCount: (previous?.postCount ?? 0) + 1,
        lastPostedAt: post.createdAt,
      });
    }
    const subscribers = yield* listSubscribers({ kind: "thread", rootId });
    for (const subscriber of subscribers) {
      if (subscriber.kind !== "thread") continue;
      const previous = members.get(subscriber.threadId);
      if (previous) {
        members.set(subscriber.threadId, { ...previous, subscribed: true });
        continue;
      }
      const author = yield* agentAuthor(subscriber.threadId).pipe(
        Effect.catchTags({
          MessageBoardError: (error) =>
            error.code === "not_found" ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      if (author?.kind === "agent") {
        members.set(subscriber.threadId, {
          author,
          subscribed: true,
          postCount: 0,
          lastPostedAt: null,
        });
      }
    }
    return {
      posts,
      summary: summarize(posts, (yield* readMarkers(viewer, root.channelName, [root.id]))(root.id)),
      members: [...members.values()].sort((left, right) =>
        (right.lastPostedAt ?? "").localeCompare(left.lastPostedAt ?? ""),
      ),
    };
  }, storage("readThread"));

  const listThreads: MessageBoardService["Service"]["listThreads"] = Effect.fn(
    "MessageBoardService.listThreads",
  )(function* (input) {
    const decoded = yield* decodeListThreads(input).pipe(Effect.mapError(invalidInput));
    const limit = decoded.limit ?? 30;
    const cursor =
      decoded.cursor === undefined
        ? null
        : yield* decodeCursor(decoded.cursor).pipe(Effect.mapError(invalidInput));
    if (cursor && (cursor.channelName !== decoded.channelName || cursor.sort !== decoded.sort))
      return yield* invalidInput();
    const sortColumn = decoded.sort === "activity" ? sql`activity_at` : sql`created_at`;
    const roots = yield* sql<{ id: string; created_at: string; activity_at: string }>`
      SELECT * FROM (
        SELECT r.id, r.created_at, MAX(p.created_at) AS activity_at
        FROM board_posts r JOIN board_posts p ON p.root_id = r.id
        WHERE r.channel_name = ${decoded.channelName} AND r.id = r.root_id
        GROUP BY r.id
      )
      WHERE ${cursor === null ? sql`1` : sql`(${sortColumn} < ${cursor.time} OR (${sortColumn} = ${cursor.time} AND id < ${cursor.id}))`}
      ORDER BY ${sortColumn} DESC, id DESC LIMIT ${limit + 1}
    `;
    const page = roots.slice(0, limit);
    if (page.length === 0) return { threads: [], nextCursor: null };
    const rows =
      yield* sql`SELECT id, channel_name AS "channelName", root_id AS "rootId", author_json AS author, text, created_at AS "createdAt"
      FROM board_posts WHERE ${sql.in(
        "root_id",
        page.map((root) => root.id),
      )} ORDER BY created_at ASC, id ASC`;
    const posts = yield* decodePosts(rows);
    const groups = new Map<string, BoardPost[]>();
    for (const post of posts) {
      const group = groups.get(post.rootId) ?? [];
      group.push(post);
      groups.set(post.rootId, group);
    }
    const readAt = yield* readMarkers(
      input.viewer,
      decoded.channelName,
      page.map((root) => BoardPostId.make(root.id)),
    );
    const last = page[page.length - 1]!;
    const nextCursor =
      roots.length > limit
        ? yield* encodeCursor({
            channelName: decoded.channelName,
            sort: decoded.sort,
            id: BoardPostId.make(last.id),
            time: decoded.sort === "activity" ? last.activity_at : last.created_at,
          })
        : null;
    return {
      threads: page.map((root) =>
        summarize(groups.get(root.id)!, readAt(BoardPostId.make(root.id))),
      ),
      nextCursor,
    };
  }, storage("listThreads"));

  const searchPosts: MessageBoardService["Service"]["searchPosts"] = Effect.fn(
    "MessageBoardService.searchPosts",
  )(function* (input) {
    const limit = input.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return yield* invalidInput();
    const query = input.query?.trim() ?? "";
    const rows =
      yield* sql`SELECT id, channel_name AS "channelName", root_id AS "rootId", author_json AS author, text, created_at AS "createdAt"
      FROM board_posts WHERE ${input.channelName === undefined ? sql`1` : sql`channel_name = ${input.channelName}`}
      AND instr(lower(text), lower(${query})) > 0 ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
    return yield* decodePosts(rows);
  }, storage("searchPosts"));

  const post: MessageBoardService["Service"]["post"] = Effect.fn("MessageBoardService.post")(
    function* (input) {
      const decoded = yield* decodePost(input).pipe(Effect.mapError(invalidInput));
      const author = yield* decodeAuthor(input.author).pipe(Effect.mapError(invalidInput));
      const authorJson = yield* encodeAuthor(author);
      if (decoded.text.trim().length === 0) return yield* invalidInput();
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const id = BoardPostId.make(yield* crypto.randomUUIDv4());
          const createdAt = yield* timestamp;
          let channelName: BoardChannelName;
          let rootId: BoardPostId;
          if (decoded.destination.kind === "reply") {
            const root = yield* readPost({ postId: decoded.destination.rootId });
            if (root.rootId !== root.id) return yield* notFound();
            channelName = root.channelName;
            rootId = root.id;
          } else {
            channelName = decoded.destination.channelName;
            rootId = id;
            yield* sql`INSERT INTO board_channels (name, description, created_by_json, created_at)
          VALUES (${channelName}, NULL, ${authorJson}, ${createdAt}) ON CONFLICT (name) DO NOTHING`;
          }
          yield* sql`INSERT INTO board_posts (id, channel_name, root_id, author_json, text, created_at)
        VALUES (${id}, ${channelName}, ${rootId}, ${authorJson}, ${decoded.text}, ${createdAt})`;
          const value = yield* readPost({ postId: id });
          const channel = yield* channelForUser(channelName);
          return { value, channel };
        }),
      );
      yield* PubSub.publish(changes, { type: "post-created", post: result.value });
      yield* PubSub.publish(changes, { type: "channel-upserted", channel: result.channel });
      return result.value;
    },
    writes.withPermit,
    storage("post"),
  );

  const markRead: MessageBoardService["Service"]["markRead"] = Effect.fn(
    "MessageBoardService.markRead",
  )(
    function* (input) {
      const { viewer } = input;
      const readAt = yield* timestamp;
      if ("rootId" in input) {
        const root = yield* readPost({ postId: input.rootId });
        if (root.rootId !== root.id) return yield* notFound();
        yield* sql`INSERT INTO board_thread_read_markers (viewer_key, root_id, read_at) VALUES (${viewerKey(viewer)}, ${root.id}, ${readAt})
        ON CONFLICT (viewer_key, root_id) DO UPDATE SET read_at = excluded.read_at`;
        if (viewer.kind !== "user") return;
        yield* PubSub.publish(changes, {
          type: "read-marker-updated",
          channelName: root.channelName,
          rootId: root.id,
          readAt,
        });
        // A discussion read lowers the channel's count by an amount only the server knows.
        yield* PubSub.publish(changes, {
          type: "channel-upserted",
          channel: yield* channelForUser(root.channelName),
        });
        return;
      }
      const { channelName } = input;
      yield* channelForUser(channelName);
      yield* sql`INSERT INTO board_read_markers (viewer_key, channel_name, read_at) VALUES (${viewerKey(viewer)}, ${channelName}, ${readAt})
      ON CONFLICT (viewer_key, channel_name) DO UPDATE SET read_at = excluded.read_at`;
      if (viewer.kind === "user")
        yield* PubSub.publish(changes, { type: "read-marker-updated", channelName, readAt });
    },
    writes.withPermit,
    storage("markRead"),
  );

  const subscribe: MessageBoardService["Service"]["subscribe"] = Effect.fn(
    "MessageBoardService.subscribe",
  )(function* (input) {
    const target = yield* decodeSubscriptionTarget(input.target).pipe(
      Effect.mapError(invalidInput),
    );
    if (target.kind === "channel") yield* channelForUser(target.channelName);
    else {
      const root = yield* readPost({ postId: target.rootId });
      if (root.rootId !== root.id) return yield* notFound();
    }
    yield* sql`INSERT INTO board_subscriptions (viewer_key, target_kind, target)
      VALUES (${viewerKey(input.viewer)}, ${target.kind}, ${targetKey(target)}) ON CONFLICT DO NOTHING`;
  }, storage("subscribe"));

  const unsubscribe: MessageBoardService["Service"]["unsubscribe"] = Effect.fn(
    "MessageBoardService.unsubscribe",
  )(function* (input) {
    yield* sql`DELETE FROM board_subscriptions WHERE viewer_key = ${viewerKey(input.viewer)}
      AND target_kind = ${input.target.kind} AND target = ${targetKey(input.target)}`;
  }, storage("unsubscribe"));

  const listSubscribers: MessageBoardService["Service"]["listSubscribers"] = Effect.fn(
    "MessageBoardService.listSubscribers",
  )(function* (target) {
    const rows = yield* sql<{ viewer_key: string }>`SELECT viewer_key FROM board_subscriptions
      WHERE target_kind = ${target.kind} AND target = ${targetKey(target)} ORDER BY viewer_key`;
    return yield* decodeViewers(
      rows.map((row) =>
        row.viewer_key === "user"
          ? { kind: "user" }
          : { kind: "thread", threadId: row.viewer_key.slice("thread:".length) },
      ),
    );
  }, storage("listSubscribers"));

  return MessageBoardService.of({
    agentAuthor,
    setRole,
    listChannels,
    createChannel,
    upsertChannel,
    listThreads,
    readThread,
    readPost,
    searchPosts,
    post,
    markRead,
    subscribe,
    unsubscribe,
    listSubscribers,
    events: Stream.fromPubSub(changes),
  });
});

export const layer = Layer.effect(MessageBoardService, make);
