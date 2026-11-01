import {
  BoardHandlingSnapshot,
  MessageBoardAssignLeadInput,
  MessageBoardUpdateContextInput,
  MessageBoardReassignRequestInput,
  MessageBoardResumeRequestInput,
  MessageBoardReportOutcomeInput,
  MessageBoardCloseDiscussionInput,
  MessageBoardReopenDiscussionInput,
  BOARD_CHANNEL_DESCRIPTION_MAX_BYTES,
  BOARD_ROLE_MAX_CHARS,
  BoardAuthor,
  BoardChannel,
  BoardChannelName,
  BoardPost,
  BoardPostId,
  BoardSubscriptionTarget,
  BoardViewer,
  MessageBoardCreateTodoInput,
  MessageBoardUpdateTodoInput,
  MessageBoardDeleteTodoInput,
  type MessageBoardTodosResult,
  MessageBoardTodoActionInput,
  MessageBoardTodoActionResult,
  MessageBoardListTodosInput,
  MessageBoardListTodosResult,
  MessageBoardGetTodoInput,
  MessageBoardGetTodoResult,
  CommandId,
  MessageBoardCreateChannelInput,
  MessageBoardError,
  MessageBoardListThreadsInput,
  MessageBoardReadThreadInput,
  MessageBoardPostInput,
  MessageBoardReactInput,
  MessageId,
  RunId,
  ThreadId,
  type BoardEvent,
  type BoardMember,
  type BoardPostDestination,
  type BoardThreadDetail,
  type BoardThreadSummary,
  type MessageBoardListThreadsResult,
  type BoardReaction,
  type MessageBoardMarkReadInput,
} from "@t3tools/contracts";
import { boardPersona } from "@t3tools/shared/boardPersona";
import { collectBoardMentions } from "@t3tools/shared/boardMentions";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as BoardHandlingGuard from "../orchestration-v2/BoardHandlingGuard.ts";
import * as MessageBoardHandlingEvents from "./MessageBoardHandlingEvents.ts";
import * as MessageBoardSelectionStore from "./MessageBoardSelectionStore.ts";
import * as MessageBoardResponderSelection from "./MessageBoardResponderSelection.ts";
import * as MessageBoardHandlingStore from "./MessageBoardHandlingStore.ts";
import * as MessageBoardTodoStore from "./MessageBoardTodoStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

const encodeHandlingContext = Schema.encodeEffect(
  Schema.fromJsonString(MessageBoardUpdateContextInput.fields.context),
);
const encodeRequestGenerations = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ id: Schema.String, generation: Schema.Number })),
  ),
);

const {
  replyToId: _replyToId,
  mentions: _mentions,
  reactions: _reactions,
  workedMs: _workedMs,
  changes: _changes,
  ...postFields
} = BoardPost.fields;
const PostRow = Schema.Struct({
  ...postFields,
  author: Schema.fromJsonString(BoardAuthor),
  replyToId: Schema.NullOr(BoardPostId),
  mentions: Schema.NullOr(Schema.fromJsonString(Schema.Array(ThreadId))),
  workedMs: Schema.NullOr(Schema.Number),
  runId: Schema.NullOr(RunId),
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
  snapshot: Schema.optionalKey(Schema.String),
});
const ReadThreadCursor = Schema.Struct({
  rootId: BoardPostId,
  snapshotTime: Schema.String,
  snapshotId: BoardPostId,
  time: Schema.String,
  id: BoardPostId,
});
const ReadThreadMemberRow = Schema.Struct({
  author: Schema.fromJsonString(BoardAuthor),
  firstAuthor: Schema.fromJsonString(BoardAuthor),
  postCount: Schema.Number,
  lastPostedAt: Schema.String,
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
type PostInput = {
  readonly author: BoardAuthor;
  readonly destination: BoardPostDestination;
  readonly text: string;
  readonly replyToId?: BoardPostId;
  readonly requestKey?: string;
  readonly mode?: "request" | "note" | "reopen-and-send";
  readonly expectedRevision?: number;
};
export interface PostAndNotifyResult {
  readonly post: BoardPost;
  readonly notifiedThreads: ReadonlyArray<ThreadId>;
  readonly skippedThreads: ReadonlyArray<ThreadId>;
  /** Already told about this discussion and haven't read it since, so not told again. */
  readonly coalescedThreads: ReadonlyArray<ThreadId>;
  /** The post was saved, but its recipients could not be loaded. */
  readonly notificationFailed: boolean;
}

export class MessageBoardService extends Context.Service<
  MessageBoardService,
  {
    readonly readHandling: (input: {
      rootId: BoardPostId;
      viewer: BoardViewer;
    }) => Effect.Effect<BoardHandlingSnapshot, BoardFailure>;
    readonly assignLead: (
      input: typeof MessageBoardAssignLeadInput.Type & { viewer: BoardViewer },
    ) => Effect.Effect<BoardHandlingSnapshot, BoardFailure>;
    readonly updateContext: (
      input: typeof MessageBoardUpdateContextInput.Type & { viewer: BoardViewer },
    ) => Effect.Effect<BoardHandlingSnapshot, BoardFailure>;
    readonly reassignRequest: (
      input: typeof MessageBoardReassignRequestInput.Type & { viewer: BoardViewer },
    ) => Effect.Effect<BoardHandlingSnapshot, BoardFailure>;
    readonly resumeRequest: (
      input: typeof MessageBoardResumeRequestInput.Type & { viewer: BoardViewer },
    ) => Effect.Effect<BoardHandlingSnapshot, BoardFailure>;
    readonly reportOutcome: (
      input: typeof MessageBoardReportOutcomeInput.Type & { viewer: BoardViewer },
    ) => Effect.Effect<BoardHandlingSnapshot, BoardFailure>;
    readonly closeDiscussion: (
      input: typeof MessageBoardCloseDiscussionInput.Type & { viewer: BoardViewer },
    ) => Effect.Effect<BoardHandlingSnapshot, BoardFailure>;
    readonly reopenDiscussion: (
      input: typeof MessageBoardReopenDiscussionInput.Type & { viewer: BoardViewer },
    ) => Effect.Effect<BoardHandlingSnapshot, BoardFailure>;
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
      readonly limit?: number;
      readonly cursor?: string;
    }) => Effect.Effect<BoardThreadDetail, BoardFailure>;
    /** Discussions an agent posted in or is subscribed to, most recently active first. */
    readonly listAgentThreads: (input: {
      readonly viewer: BoardViewer;
      readonly threadId: ThreadId;
    }) => Effect.Effect<ReadonlyArray<BoardThreadSummary>, BoardFailure>;
    readonly readPost: (input: {
      readonly postId: BoardPostId;
    }) => Effect.Effect<BoardPost, BoardFailure>;
    readonly searchPosts: (input: {
      readonly viewer: BoardViewer;
      readonly query?: string;
      readonly channelName?: BoardChannelName;
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<BoardPost>, BoardFailure>;
    /** Stores a post silently, resolving selected identities and unambiguous persona names. */
    readonly post: (input: PostInput) => Effect.Effect<BoardPost, BoardFailure>;
    /**
     * Stores a post, subscribes an agent author to its discussion, and tells subscribers,
     * mentioned or replied-to agents and `notifyThreads` about it. Only running threads are told,
     * except that a mention or reply from the user or delegating agent starts it again.
     */
    readonly postAndNotify: (
      input: PostInput & { readonly notifyThreads?: ReadonlyArray<ThreadId> },
    ) => Effect.Effect<PostAndNotifyResult, BoardFailure>;
    readonly applyTodoAction: (
      input: typeof MessageBoardTodoActionInput.Type & { viewer: BoardViewer },
    ) => Effect.Effect<typeof MessageBoardTodoActionResult.Type, BoardFailure>;
    readonly listTodos: (
      input: typeof MessageBoardListTodosInput.Type & { viewer: BoardViewer },
    ) => Effect.Effect<typeof MessageBoardListTodosResult.Type, BoardFailure>;
    readonly getTodo: (
      input: typeof MessageBoardGetTodoInput.Type & { viewer: BoardViewer },
    ) => Effect.Effect<typeof MessageBoardGetTodoResult.Type, BoardFailure>;
    readonly createTodo: (
      input: typeof MessageBoardCreateTodoInput.Type,
    ) => Effect.Effect<MessageBoardTodosResult, BoardFailure>;
    readonly updateTodo: (
      input: typeof MessageBoardUpdateTodoInput.Type,
    ) => Effect.Effect<MessageBoardTodosResult, BoardFailure>;
    readonly deleteTodo: (
      input: typeof MessageBoardDeleteTodoInput.Type,
    ) => Effect.Effect<MessageBoardTodosResult, BoardFailure>;
    readonly react: (
      input: typeof MessageBoardReactInput.Type & { readonly viewer: BoardViewer },
    ) => Effect.Effect<void, BoardFailure>;
    /** Marks a whole channel, or one discussion (`rootId`), read for the viewer. */
    readonly markRead: (
      input: {
        readonly viewer: BoardViewer;
        readonly throughPostId?: BoardPostId;
      } & MessageBoardMarkReadInput,
    ) => Effect.Effect<void, BoardFailure>;
    /**
     * The viewer's unread posts by others in one discussion. With none, waits up to `timeoutMs`
     * for the next one; empty when it times out.
     */
    readonly waitForPosts: (input: {
      readonly viewer: BoardViewer;
      readonly rootId: BoardPostId;
      readonly timeoutMs: number;
    }) => Effect.Effect<ReadonlyArray<BoardPost>, BoardFailure>;
    /** `implicit` subscribes by participation and keeps an earlier unsubscribe. */
    readonly subscribe: (
      input: SubscriptionInput & { readonly implicit?: boolean },
    ) => Effect.Effect<void, BoardFailure>;
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
const decodePostRows = Schema.decodeUnknownEffect(Schema.Array(PostRow));
const toPost = ({
  replyToId,
  mentions,
  workedMs,
  runId: _runId,
  ...post
}: typeof PostRow.Type): BoardPost => ({
  ...post,
  ...(replyToId === null ? {} : { replyToId }),
  ...(mentions === null || mentions.length === 0 ? {} : { mentions }),
  ...(workedMs === null ? {} : { workedMs: Math.max(0, Math.round(workedMs)) }),
});
const decodePosts = (rows: unknown) =>
  decodePostRows(rows).pipe(Effect.map((decoded) => decoded.map(toPost)));
const decodeChannels = Schema.decodeUnknownEffect(Schema.Array(ChannelRow));
const decodeCreateChannel = Schema.decodeEffect(MessageBoardCreateChannelInput);
const decodeAuthor = Schema.decodeEffect(BoardAuthor);
const decodeAuthorJson = Schema.decodeUnknownEffect(Schema.fromJsonString(BoardAuthor));
const encodeMentions = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ThreadId)));
const encodeAuthor = Schema.encodeEffect(Schema.fromJsonString(BoardAuthor));
const decodeListThreads = Schema.decodeEffect(MessageBoardListThreadsInput);
const decodeParticipantRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      rootId: BoardPostId,
      author: Schema.fromJsonString(BoardAuthor),
    }),
  ),
);
const decodeCursor = Schema.decodeEffect(Schema.fromJsonString(ThreadCursor));
const encodeCursor = Schema.encodeEffect(Schema.fromJsonString(ThreadCursor));
const decodeReadThread = Schema.decodeEffect(MessageBoardReadThreadInput);
const decodeReadThreadCursor = Schema.decodeEffect(Schema.fromJsonString(ReadThreadCursor));
const encodeReadThreadCursor = Schema.encodeEffect(Schema.fromJsonString(ReadThreadCursor));
const decodeReadThreadMembers = Schema.decodeUnknownEffect(Schema.Array(ReadThreadMemberRow));
const decodePost = Schema.decodeEffect(MessageBoardPostInput);
const encodeRequestPayload = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      operation: Schema.Literals(["append", "post"]),
      destination: MessageBoardPostInput.fields.destination,
      text: Schema.String,
      replyToId: Schema.NullOr(BoardPostId),
      notifyThreads: Schema.Array(ThreadId),
      mode: Schema.String,
    }),
  ),
);
const decodeSubscriptionTarget = Schema.decodeEffect(BoardSubscriptionTarget);
const decodeViewers = Schema.decodeUnknownEffect(Schema.Array(BoardViewer));
const decodeReact = Schema.decodeEffect(MessageBoardReactInput);
const viewerFromKey = (key: string): BoardViewer =>
  key === "user" ? { kind: "user" } : { kind: "thread", threadId: ThreadId.make(key.slice(7)) };

/** Selected agent identities, with an unambiguous name fallback for plain `@Name` tags. */
export function resolveMentions(
  text: string,
  candidates: Iterable<ThreadId>,
): ReadonlyArray<ThreadId> {
  const identities = new Set(candidates);
  const byName = Map.groupBy([...identities], (threadId) =>
    boardPersona(threadId).name.toLowerCase(),
  );
  return [
    ...new Set(
      collectBoardMentions(text).flatMap((mention) => {
        if (mention.threadId !== undefined)
          return identities.has(ThreadId.make(mention.threadId))
            ? [ThreadId.make(mention.threadId)]
            : [];
        const matches = byName.get(mention.name.toLowerCase()) ?? [];
        return matches.length === 1 ? matches : [];
      }),
    ),
  ];
}
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
    if (post.author.kind === "system") continue;
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
    ...(readAt === null ? {} : { readAt }),
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
  const handling = yield* MessageBoardHandlingStore.make;
  const selections = yield* MessageBoardSelectionStore.make;
  const responder = yield* MessageBoardResponderSelection.MessageBoardResponderSelection;
  const todoStore = yield* MessageBoardTodoStore.make;
  const outbox = yield* Effect.serviceOption(EffectOutbox.EffectOutboxV2);
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  // When each agent was last told about each discussion. In memory: after a restart the worst
  // case is one extra notice, which doesn't justify storing it.
  const pendingNotices = new Map<string, string>();
  const postColumns = sql.literal(
    `id, channel_name AS "channelName", root_id AS "rootId", author_json AS author, text, created_at AS "createdAt", reply_to_id AS "replyToId", mentions_json AS mentions, worked_ms AS "workedMs", run_id AS "runId"`,
  );
  const handlingEvents = yield* Effect.serviceOption(
    MessageBoardHandlingEvents.MessageBoardHandlingEvents,
  );
  const changes = Option.isSome(handlingEvents)
    ? handlingEvents.value.changes
    : yield* PubSub.unbounded<BoardEvent>();
  if (Option.isNone(handlingEvents)) yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
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
    if (channels.length === 0) return [];
    const recentRows = yield* sql`
      SELECT ${postColumns}
      FROM (
        SELECT p.*, ROW_NUMBER() OVER (
          PARTITION BY p.channel_name ORDER BY p.created_at DESC, p.id DESC
        ) AS rank
        FROM board_posts p WHERE ${sql.in(
          "p.channel_name",
          channels.map((channel) => channel.name),
        )}
      )
      WHERE rank <= 12
      ORDER BY "createdAt" DESC, id DESC
    `;
    const recent = Map.groupBy(yield* decodePosts(recentRows), (post) => post.channelName);
    return channels.map((channel): BoardChannel => {
      const posts = recent.get(channel.name) ?? [];
      const authors = new Map<string, BoardAuthor>();
      for (const post of posts) {
        if (post.author.kind === "system") continue;
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
      if (author.kind === "system") return yield* invalidInput();
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
    const rows = yield* sql`SELECT ${postColumns}
      FROM board_posts WHERE id = ${postId}`;
    const posts = yield* decodePosts(rows);
    if (!posts[0]) return yield* notFound();
    return posts[0];
  }, storage("readPost"));

  /** Per discussion, the later of the channel-wide and the discussion's own read marker. */
  const readMarkers = Effect.fn("MessageBoardService.readMarkers")(function* (
    viewer: BoardViewer,
    rootIds: ReadonlyArray<BoardPostId>,
  ) {
    const rows = yield* sql<{ root_id: string; read_at: string }>`
      SELECT p.id AS root_id, MAX(COALESCE(c.read_at, ''), COALESCE(t.read_at, '')) AS read_at
      FROM board_posts p
      LEFT JOIN board_read_markers c
        ON c.viewer_key = ${viewerKey(viewer)} AND c.channel_name = p.channel_name
      LEFT JOIN board_thread_read_markers t
        ON t.viewer_key = ${viewerKey(viewer)} AND t.root_id = p.id
      WHERE ${sql.in("p.id", rootIds)}`;
    const markers = new Map(rows.map((row) => [row.root_id, row.read_at || null]));
    return (rootId: BoardPostId) => markers.get(rootId) ?? null;
  }, storage("readMarkers"));

  const reactionsFor = Effect.fn("MessageBoardService.reactionsFor")(function* (
    postIds: ReadonlyArray<BoardPostId>,
  ) {
    const result = new Map<BoardPostId, Array<BoardReaction>>();
    if (postIds.length === 0) return result;
    const rows = yield* sql<{ post_id: string; viewer_key: string; emoji: string }>`
      SELECT post_id, viewer_key, emoji FROM board_reactions
      WHERE ${sql.in("post_id", postIds)} ORDER BY created_at ASC, viewer_key ASC`;
    for (const row of rows) {
      const postId = BoardPostId.make(row.post_id);
      const reactions = result.get(postId) ?? [];
      const viewer = viewerFromKey(row.viewer_key);
      const index = reactions.findIndex((reaction) => reaction.emoji === row.emoji);
      if (index === -1) reactions.push({ emoji: row.emoji, by: [viewer] });
      else reactions[index] = { ...reactions[index]!, by: [...reactions[index]!.by, viewer] };
      result.set(postId, reactions);
    }
    return result;
  });

  /** One agent's membership of a discussion, or null when it has none to show. */
  const memberFor = Effect.fn("MessageBoardService.memberFor")(function* (
    rootId: BoardPostId,
    threadId: ThreadId,
  ) {
    const key = viewerKey({ kind: "thread", threadId });
    const posted = yield* sql<{ author: string; postCount: number; lastPostedAt: string }>`
      SELECT author_json AS author, COUNT(*) OVER () AS "postCount", created_at AS "lastPostedAt"
      FROM board_posts WHERE root_id = ${rootId} AND json_extract(author_json, '$.threadId') = ${threadId}
      ORDER BY created_at DESC LIMIT 1`;
    const subscribed = yield* sql<{ enabled: number }>`
      SELECT enabled FROM board_subscriptions
      WHERE viewer_key = ${key} AND target_kind = 'thread' AND target = ${rootId}`;
    const read = yield* sql<{ read_at: string }>`
      SELECT read_at FROM board_thread_read_markers WHERE viewer_key = ${key} AND root_id = ${rootId}`;
    const author = posted[0]
      ? yield* decodeAuthorJson(posted[0].author)
      : yield* agentAuthor(threadId).pipe(
          Effect.catchTags({
            MessageBoardError: (error) =>
              error.code === "not_found" ? Effect.succeed(null) : Effect.fail(error),
          }),
        );
    if (author?.kind !== "agent") return null;
    const member: BoardMember = {
      author,
      subscribed: subscribed[0]?.enabled === 1,
      postCount: posted[0]?.postCount ?? 0,
      lastPostedAt: posted[0]?.lastPostedAt ?? null,
      ...(read[0] ? { readAt: read[0].read_at } : {}),
    };
    return member;
  });

  const publishMember = Effect.fn("MessageBoardService.publishMember")(
    function* (rootId: BoardPostId, threadId: ThreadId) {
      const member = yield* memberFor(rootId, threadId);
      if (member) yield* PubSub.publish(changes, { type: "member-updated", rootId, member });
    },
    (effect) => Effect.ignore(effect),
  );

  /**
   * The files each agent run changed, on that run's last post here. A run's checkpoint covers the
   * whole checkout, which agents may share, so only files the agent itself edited are kept.
   */
  const changesFor = Effect.fn("MessageBoardService.changesFor")(function* (
    rows: ReadonlyArray<typeof PostRow.Type>,
  ) {
    const lastPostByRun = new Map<
      RunId,
      { readonly id: BoardPostId; readonly threadId: ThreadId }
    >();
    for (const row of rows) {
      if (row.author.kind === "agent" && row.runId !== null) {
        lastPostByRun.set(row.runId, { id: row.id, threadId: row.author.threadId });
      }
    }
    const changes = new Map<BoardPostId, NonNullable<BoardPost["changes"]>>();
    const byThread = Map.groupBy(lastPostByRun, ([, post]) => post.threadId);
    for (const [threadId, runs] of byThread) {
      const runIds = runs.map(([runId]) => runId);
      const records = yield* threadManagement
        .getThreadRecords(threadId, ["checkpoints", "turnItems"], {
          turnItemRunIds: runIds,
          turnItemTypes: ["file_change"],
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (records === null) continue;
      for (const [runId, post] of runs) {
        const edited = records.turnItems.flatMap((item) =>
          item.type === "file_change" && item.runId === runId
            ? [item.fileName, ...(item.changes ?? []).map((change) => change.path)]
            : [],
        );
        const checkpoint = records.checkpoints.findLast(
          (candidate) =>
            candidate.runId === runId &&
            candidate.appRunOrdinal !== null &&
            candidate.status === "ready",
        );
        const files = (checkpoint?.files ?? []).filter((file) =>
          edited.some((path) => path === file.path || path.endsWith(`/${file.path}`)),
        );
        if (files.length > 0) changes.set(post.id, { runId, files });
      }
    }
    return changes;
  });

  const todosFor = todoStore.snapshot;
  const applyTodoAction: MessageBoardService["Service"]["applyTodoAction"] = Effect.fn(
    "MessageBoardService.applyTodoAction",
  )(
    function* (input) {
      const { result, changed } = yield* todoStore.apply(input);
      if (changed)
        yield* PubSub.publish(changes, {
          type: "todos-changed",
          rootId: input.rootId,
          ...(yield* todoStore.snapshot(input.rootId)),
        });
      return result;
    },
    writes.withPermit,
    storage("applyTodoAction"),
  );
  const listTodos: MessageBoardService["Service"]["listTodos"] = Effect.fn(
    "MessageBoardService.listTodos",
  )(function* (input) {
    return yield* todoStore.list(input);
  }, storage("listTodos"));
  const getTodo: MessageBoardService["Service"]["getTodo"] = Effect.fn(
    "MessageBoardService.getTodo",
  )(function* (input) {
    return yield* todoStore.get(input);
  }, storage("getTodo"));
  const refreshTodoTools = () =>
    new MessageBoardError({
      code: "compatibility",
      message:
        "Refresh the message-board tools and use board_todo_action with a request key and expected item version.",
    });
  const createTodo: MessageBoardService["Service"]["createTodo"] = Effect.fn(
    "MessageBoardService.createTodo",
  )(function* (_input) {
    return yield* refreshTodoTools();
  });
  const updateTodo: MessageBoardService["Service"]["updateTodo"] = Effect.fn(
    "MessageBoardService.updateTodo",
  )(function* (_input) {
    return yield* refreshTodoTools();
  });
  const deleteTodo: MessageBoardService["Service"]["deleteTodo"] = Effect.fn(
    "MessageBoardService.deleteTodo",
  )(function* (_input) {
    return yield* refreshTodoTools();
  });

  const readThread: MessageBoardService["Service"]["readThread"] = Effect.fn(
    "MessageBoardService.readThread",
  )(function* (input) {
    const { viewer } = input;
    const decoded = yield* decodeReadThread(input).pipe(Effect.mapError(invalidInput));
    const { rootId } = decoded;
    const paged = decoded.limit !== undefined || decoded.cursor !== undefined;
    let rows: ReadonlyArray<typeof PostRow.Type>;
    let summaryPosts: ReadonlyArray<BoardPost>;
    let participants: ReadonlyArray<BoardAuthor> | undefined;
    let replyCount: number;
    let olderPostsCursor: string | null = null;
    const members = new Map<ThreadId, BoardMember>();
    if (!paged) {
      rows = yield* decodePostRows(
        yield* sql`SELECT ${postColumns}
        FROM board_posts WHERE root_id = ${rootId} ORDER BY created_at ASC, id ASC`,
      );
      summaryPosts = rows.map(toPost);
      if (!summaryPosts.some((post) => post.id === rootId)) return yield* notFound();
      replyCount = rows.length - 1;
      for (const post of summaryPosts) {
        if (post.author.kind !== "agent") continue;
        const previous = members.get(post.author.threadId);
        members.set(post.author.threadId, {
          author: post.author,
          subscribed: false,
          postCount: (previous?.postCount ?? 0) + 1,
          lastPostedAt: post.createdAt,
        });
      }
    } else {
      const limit = decoded.limit ?? 40;
      const cursor =
        decoded.cursor === undefined
          ? null
          : yield* decodeReadThreadCursor(decoded.cursor).pipe(Effect.mapError(invalidInput));
      if (
        cursor &&
        (cursor.rootId !== rootId ||
          cursor.time > cursor.snapshotTime ||
          (cursor.time === cursor.snapshotTime && cursor.id > cursor.snapshotId))
      )
        return yield* invalidInput();
      const pageState = yield* sql.withTransaction(
        Effect.gen(function* () {
          const roots = yield* decodePostRows(
            yield* sql`SELECT ${postColumns} FROM board_posts WHERE id = ${rootId} AND root_id = ${rootId}`,
          );
          const root = roots[0];
          if (root === undefined) return yield* notFound();
          const latestRows = yield* decodePostRows(
            yield* sql`SELECT ${postColumns} FROM board_posts WHERE root_id = ${rootId} ORDER BY created_at DESC, id DESC LIMIT 1`,
          );
          const latest = latestRows[0]!;
          const snapshotTime = cursor?.snapshotTime ?? latest.createdAt;
          const snapshotId = cursor?.snapshotId ?? latest.id;
          const replies = yield* decodePostRows(
            yield* sql`SELECT ${postColumns} FROM board_posts
        WHERE root_id = ${rootId} AND id != ${rootId}
          AND (created_at < ${snapshotTime} OR (created_at = ${snapshotTime} AND id <= ${snapshotId}))
          AND ${cursor === null ? sql`1` : sql`(created_at < ${cursor.time} OR (created_at = ${cursor.time} AND id < ${cursor.id}))`}
        ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
          );
          const page = replies.slice(0, limit).toReversed();
          const counts = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM board_posts WHERE root_id = ${rootId}`;
          let nextCursor: string | null = null;
          if (replies.length > limit) {
            const oldest = page[0]!;
            nextCursor = yield* encodeReadThreadCursor({
              rootId,
              snapshotTime,
              snapshotId,
              time: oldest.createdAt,
              id: oldest.id,
            });
          }
          const authors = yield* decodeReadThreadMembers(
            yield* sql`
        SELECT author_json AS author, first_author AS "firstAuthor", post_count AS "postCount", created_at AS "lastPostedAt" FROM (
          SELECT author_json, created_at,
            COUNT(*) OVER identities AS post_count,
            ROW_NUMBER() OVER newest AS position,
            FIRST_VALUE(author_json) OVER oldest AS first_author,
            FIRST_VALUE(created_at) OVER oldest AS first_posted_at,
            FIRST_VALUE(id) OVER oldest AS first_id
          FROM board_posts WHERE root_id = ${rootId} AND json_extract(author_json, '$.kind') != 'system'
          WINDOW identities AS (PARTITION BY CASE WHEN json_extract(author_json, '$.kind') = 'user' THEN 'user' ELSE 'agent:' || json_extract(author_json, '$.threadId') END),
            newest AS (identities ORDER BY created_at DESC, id DESC), oldest AS (identities ORDER BY created_at ASC, id ASC)
        ) WHERE position = 1 ORDER BY first_posted_at ASC, first_id ASC`,
          );
          return {
            rows: [root, ...page],
            summaryPosts: latest.id === root.id ? [toPost(root)] : [toPost(root), toPost(latest)],
            replyCount: counts[0]!.count - 1,
            olderPostsCursor: nextCursor,
            authors,
          };
        }),
      );
      rows = pageState.rows;
      summaryPosts = pageState.summaryPosts;
      replyCount = pageState.replyCount;
      olderPostsCursor = pageState.olderPostsCursor;
      participants = pageState.authors.slice(0, 8).map((row) => row.firstAuthor);
      for (const row of pageState.authors) {
        if (row.author.kind !== "agent") continue;
        members.set(row.author.threadId, {
          author: row.author,
          subscribed: false,
          postCount: row.postCount,
          lastPostedAt: row.lastPostedAt,
        });
      }
    }
    const posts = rows.map(toPost);
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
    const readers = yield* sql<{ viewer_key: string; read_at: string }>`
      SELECT viewer_key, read_at FROM board_thread_read_markers
      WHERE root_id = ${rootId} AND viewer_key LIKE 'thread:%'`;
    for (const reader of readers) {
      const threadId = ThreadId.make(reader.viewer_key.slice(7));
      const previous = members.get(threadId);
      if (previous) {
        members.set(threadId, { ...previous, readAt: reader.read_at });
        continue;
      }
      const author = yield* agentAuthor(threadId).pipe(
        Effect.catchTags({
          MessageBoardError: (error) =>
            error.code === "not_found" ? Effect.succeed(null) : Effect.fail(error),
        }),
      );
      if (author?.kind === "agent") {
        members.set(threadId, {
          author,
          subscribed: false,
          postCount: 0,
          lastPostedAt: null,
          readAt: reader.read_at,
        });
      }
    }
    const reactions = yield* reactionsFor(posts.map((post) => post.id));
    let changeRows = rows;
    if (paged) {
      const runIds = [...new Set(rows.flatMap((row) => (row.runId === null ? [] : [row.runId])))];
      if (runIds.length > 0) {
        const lastPosts = yield* sql<{ id: string }>`SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY created_at DESC, id DESC) AS position
          FROM board_posts WHERE root_id = ${rootId} AND ${sql.in("run_id", runIds)}
        ) WHERE position = 1`;
        const lastPostIds = new Set(lastPosts.map((post) => post.id));
        changeRows = rows.filter((row) => lastPostIds.has(row.id));
      }
    }
    const changes = yield* changesFor(changeRows);
    const todoState = yield* todosFor(rootId);
    return {
      posts: posts.map((post) => {
        const postReactions = reactions.get(post.id);
        const postChanges = changes.get(post.id);
        return {
          ...post,
          ...(postReactions ? { reactions: postReactions } : {}),
          ...(postChanges ? { changes: postChanges } : {}),
        };
      }),
      ...todoState,
      handling: yield* handling.snapshot(rootId),
      summary: {
        ...summarize(summaryPosts, (yield* readMarkers(viewer, [rootId]))(rootId)),
        replyCount,
        ...(participants === undefined ? {} : { participants }),
      },
      ...(paged ? { olderPostsCursor } : {}),
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
    const snapshot =
      cursor?.snapshot ??
      (yield* sql<{ time: string | null }>`SELECT MAX(created_at) AS time FROM board_posts`)[0]
        ?.time ??
      "";
    const sortColumn = decoded.sort === "activity" ? sql`activity_at` : sql`created_at`;
    const roots = yield* sql<{
      id: string;
      created_at: string;
      activity_at: string;
      post_count: number;
    }>`
      SELECT * FROM (
        SELECT r.id, r.created_at, MAX(p.created_at) AS activity_at, COUNT(p.id) AS post_count
        FROM board_posts r JOIN board_posts p ON p.root_id = r.id
        WHERE r.channel_name = ${decoded.channelName} AND r.id = r.root_id AND p.created_at <= ${snapshot}
        GROUP BY r.id
      )
      WHERE ${cursor === null ? sql`1` : sql`(${sortColumn} < ${cursor.time} OR (${sortColumn} = ${cursor.time} AND id < ${cursor.id}))`}
      ORDER BY ${sortColumn} DESC, id DESC LIMIT ${limit + 1}
    `;
    const page = roots.slice(0, limit);
    if (page.length === 0) return { threads: [], nextCursor: null };
    const rootIds = page.map((root) => root.id);
    const rows = yield* sql`SELECT ${postColumns}
      FROM board_posts WHERE ${sql.in("id", rootIds)} OR id IN (
        SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY root_id ORDER BY created_at DESC, id DESC) AS position
          FROM board_posts WHERE ${sql.in("root_id", rootIds)} AND created_at <= ${snapshot}) WHERE position = 1
      ) ORDER BY created_at ASC, id ASC`;
    const posts = yield* decodePosts(rows);
    const groups = new Map<string, BoardPost[]>();
    for (const post of posts) {
      const group = groups.get(post.rootId) ?? [];
      group.push(post);
      groups.set(post.rootId, group);
    }
    const participantRows = yield* sql`SELECT root_id AS "rootId", author_json AS author FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY root_id ORDER BY first_post) AS position FROM (
        SELECT root_id, author_json, MIN(created_at) AS first_post FROM board_posts
        WHERE ${sql.in("root_id", rootIds)} AND created_at <= ${snapshot}
        GROUP BY root_id, COALESCE(json_extract(author_json, '$.threadId'), 'user')
      )) WHERE position <= 8 ORDER BY root_id, position`;
    const participants = Map.groupBy(
      yield* decodeParticipantRows(participantRows),
      (row) => row.rootId,
    );
    const readAt = yield* readMarkers(
      input.viewer,
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
            snapshot,
          })
        : null;
    return {
      threads: page.map((root) => ({
        ...summarize(groups.get(root.id)!, readAt(BoardPostId.make(root.id))),
        replyCount: root.post_count - 1,
        participants: (participants.get(BoardPostId.make(root.id)) ?? []).map((row) => row.author),
      })),
      nextCursor,
    };
  }, storage("listThreads"));

  const listAgentThreads: MessageBoardService["Service"]["listAgentThreads"] = Effect.fn(
    "MessageBoardService.listAgentThreads",
  )(function* ({ viewer, threadId }) {
    const roots = yield* sql<{ id: string }>`
      SELECT p.root_id AS id FROM board_posts p
      WHERE p.root_id IN (
        SELECT root_id FROM board_posts WHERE json_extract(author_json, '$.threadId') = ${threadId}
        UNION SELECT target FROM board_subscriptions
        WHERE viewer_key = ${viewerKey({ kind: "thread", threadId })}
          AND target_kind = 'thread' AND enabled = 1
      )
      GROUP BY p.root_id ORDER BY MAX(p.created_at) DESC, p.root_id DESC LIMIT 20`;
    if (roots.length === 0) return [];
    const rows = yield* sql`SELECT ${postColumns}
      FROM board_posts WHERE ${sql.in(
        "root_id",
        roots.map((root) => root.id),
      )} ORDER BY created_at ASC, id ASC`;
    const groups = Map.groupBy(yield* decodePosts(rows), (post) => post.rootId);
    const readAt = yield* readMarkers(
      viewer,
      roots.map((root) => BoardPostId.make(root.id)),
    );
    return [...groups.values()]
      .map((posts) => summarize(posts, readAt(posts[0]!.id)))
      .sort(
        (left, right) =>
          right.lastActivityAt.localeCompare(left.lastActivityAt) ||
          right.root.id.localeCompare(left.root.id),
      );
  }, storage("listAgentThreads"));

  const searchPosts: MessageBoardService["Service"]["searchPosts"] = Effect.fn(
    "MessageBoardService.searchPosts",
  )(function* (input) {
    const limit = input.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return yield* invalidInput();
    const query = input.query?.trim() ?? "";
    const rows = yield* sql`SELECT ${postColumns}
      FROM board_posts WHERE ${input.channelName === undefined ? sql`1` : sql`channel_name = ${input.channelName}`}
      AND instr(lower(text), lower(${query})) > 0 ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
    return yield* decodePosts(rows);
  }, storage("searchPosts"));

  const storePost = Effect.fn("MessageBoardService.storePost")(
    function* (input: PostInput, notifyThreads?: ReadonlyArray<ThreadId>) {
      const decoded = yield* decodePost(input).pipe(Effect.mapError(invalidInput));
      const author = yield* decodeAuthor(input.author).pipe(Effect.mapError(invalidInput));
      if (author.kind === "system") return yield* invalidInput();
      const authorJson = yield* encodeAuthor(author);
      const authorKey = author.kind === "user" ? "user" : `thread:${author.threadId}`;
      const fingerprint =
        decoded.requestKey === undefined
          ? null
          : Hex.encode(
              yield* crypto.digest(
                "SHA-256",
                new TextEncoder().encode(
                  encodeRequestPayload({
                    operation: notifyThreads === undefined ? "append" : "post",
                    destination: decoded.destination,
                    text: decoded.text,
                    mode: decoded.mode ?? "request",
                    replyToId: decoded.replyToId ?? null,
                    notifyThreads: [...new Set(notifyThreads ?? [])].sort(),
                  }),
                ),
              ),
            );
      if (decoded.text.trim().length === 0) return yield* invalidInput();
      const shell =
        author.kind === "agent"
          ? yield* threadManagement
              .getThreadShell(author.threadId)
              .pipe(Effect.orElseSucceed(() => null))
          : null;
      const runStartedAt = shell?.activityRunStartedAt ?? null;
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          if (decoded.requestKey !== undefined) {
            const previous = yield* sql<{
              fingerprint: string;
              post_id: string;
            }>`SELECT fingerprint, post_id
              FROM board_post_requests WHERE author_key = ${authorKey} AND request_key = ${decoded.requestKey}`;
            if (previous[0]) {
              if (previous[0].fingerprint !== fingerprint)
                return yield* new MessageBoardError({
                  code: "conflict",
                  message: "This request key already belongs to a different board post payload.",
                });
              return {
                value: yield* readPost({ postId: BoardPostId.make(previous[0].post_id) }),
                channel: null,
                replayed: true,
              };
            }
          }
          const id = BoardPostId.make(yield* crypto.randomUUIDv4());
          const createdAt = yield* timestamp;
          let channelName: BoardChannelName;
          let rootId: BoardPostId;
          if (decoded.destination.kind === "reply") {
            const root = yield* readPost({ postId: decoded.destination.rootId });
            if (root.rootId !== root.id) return yield* notFound();
            channelName = root.channelName;
            rootId = root.id;
            const state = yield* handling.snapshot(rootId);
            if (
              decoded.expectedRevision !== undefined &&
              decoded.expectedRevision !== state.revision
            )
              return yield* handling.conflict(state, "revision");
            if (decoded.mode === "reopen-and-send") {
              if (decoded.expectedRevision === undefined) return yield* invalidInput();
              yield* sql`UPDATE board_discussions SET lifecycle='open' WHERE root_id=${rootId}`;
            } else if (state.lifecycle === "closed" && decoded.mode !== "note")
              return yield* handling.conflict(state, "closed");
            if (decoded.replyToId !== undefined) {
              const target = yield* readPost({ postId: decoded.replyToId });
              if (target.rootId !== rootId) return yield* invalidInput();
            }
          } else {
            if (decoded.replyToId !== undefined) return yield* invalidInput();
            channelName = decoded.destination.channelName;
            rootId = id;
            yield* sql`INSERT INTO board_channels (name, description, created_by_json, created_at)
          VALUES (${channelName}, NULL, ${authorJson}, ${createdAt}) ON CONFLICT (name) DO NOTHING`;
          }
          const candidates = yield* sql<{ thread_id: string }>`
            SELECT DISTINCT json_extract(author_json, '$.threadId') AS thread_id FROM board_posts
            WHERE channel_name = ${channelName} AND json_extract(author_json, '$.kind') = 'agent'
            UNION SELECT substr(viewer_key, 8) FROM board_subscriptions
            WHERE viewer_key LIKE 'thread:%' AND enabled = 1
              AND ((target_kind = 'channel' AND target = ${channelName})
                OR (target_kind = 'thread' AND target = ${rootId}))`;
          const identities = new Set(candidates.map((row) => ThreadId.make(row.thread_id)));
          for (const mention of collectBoardMentions(decoded.text)) {
            if (mention.threadId === undefined) continue;
            const threadId = ThreadId.make(mention.threadId);
            if (identities.has(threadId)) continue;
            identities.add(threadId);
          }
          const mentions = resolveMentions(
            decoded.text,
            [...identities].filter(
              (threadId) => author.kind !== "agent" || threadId !== author.threadId,
            ),
          );
          const mentionsJson = mentions.length === 0 ? null : yield* encodeMentions(mentions);
          let workedMs: number | null = null;
          if (author.kind === "agent" && runStartedAt !== null) {
            // A second post in the same run counts only the work since the first.
            const previous = yield* sql<{ latest: string | null }>`
              SELECT MAX(created_at) AS latest FROM board_posts
              WHERE json_extract(author_json, '$.threadId') = ${author.threadId}`;
            const since = Math.max(
              DateTime.toEpochMillis(runStartedAt),
              previous[0]?.latest ? Date.parse(previous[0].latest) : 0,
            );
            workedMs = Math.max(0, Date.parse(createdAt) - since);
          }
          yield* sql`INSERT INTO board_posts (id, channel_name, root_id, author_json, text, created_at, reply_to_id, mentions_json, worked_ms, run_id)
        VALUES (${id}, ${channelName}, ${rootId}, ${authorJson}, ${decoded.text}, ${createdAt},
          ${decoded.replyToId ?? null}, ${mentionsJson}, ${workedMs}, ${shell?.activeRunId ?? null})`;
          if (decoded.requestKey !== undefined)
            yield* sql`INSERT INTO board_post_requests (author_key, request_key, fingerprint, post_id)
            VALUES (${authorKey}, ${decoded.requestKey}, ${fingerprint!}, ${id})`;
          const requested = new Set<ThreadId>();
          if (author.kind === "user" && decoded.mode !== "note") {
            for (const threadId of [...mentions, ...(notifyThreads ?? [])]) requested.add(threadId);
            if (decoded.replyToId !== undefined) {
              const replied = yield* readPost({ postId: decoded.replyToId });
              if (replied.author.kind === "agent") requested.add(replied.author.threadId);
            }
          }
          yield* handling.createForPost({
            rootId,
            postId: id,
            suggestedLeadThreadId: author.kind === "agent" ? author.threadId : null,
            recipients: [...requested],
            requireAssignment: false,
          });
          for (const recipientThreadId of requested) {
            const reason = yield* MessageBoardResponderSelection.classifyAvailability(
              recipientThreadId,
            ).pipe(
              Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
              Effect.provideService(SqlClient.SqlClient, sql),
            );
            if (reason !== null)
              yield* sql`UPDATE board_responsibilities SET status='held',availability_reason=${reason}
                WHERE root_id=${rootId} AND post_id=${id} AND recipient_thread_id=${recipientThreadId}`;
          }
          if (author.kind === "user" && decoded.mode !== "note" && requested.size === 0)
            yield* selections.createIntent({ rootId, postId: id, now: createdAt });
          if (author.kind === "user")
            yield* sql`UPDATE board_discussions SET context_revision=context_revision+1 WHERE root_id=${rootId}`;
          if (Option.isSome(outbox))
            for (const recipientThreadId of requested) {
              const pending =
                yield* sql`SELECT 1 FROM board_responsibilities WHERE post_id=${id} AND recipient_thread_id=${recipientThreadId} AND status='pending'`;
              if (pending.length === 0) continue;
              yield* outbox.value.enqueue([
                {
                  id: `board-dispatch:${id}:${recipientThreadId}`,
                  commandId: CommandId.make(`board-post:${id}`),
                  threadId: recipientThreadId,
                  request: { type: "board-dispatch", rootId, recipientThreadId },
                },
              ]);
            }
          const value = yield* readPost({ postId: id });
          const channel = yield* channelForUser(channelName);
          return { value, channel, replayed: false };
        }),
      );
      if (result.channel !== null) {
        yield* PubSub.publish(changes, { type: "post-created", post: result.value });
        yield* PubSub.publish(changes, { type: "channel-upserted", channel: result.channel });
      }
      if (Option.isSome(outbox)) yield* outbox.value.notifyAvailable();
      yield* PubSub.publish(changes, {
        type: "handling-changed",
        handling: yield* handling.snapshot(result.value.rootId),
      });
      return { post: result.value, replayed: result.replayed };
    },
    writes.withPermit,
    storage("post"),
  );

  const post: MessageBoardService["Service"]["post"] = Effect.fn("MessageBoardService.post")(
    (input) => storePost(input).pipe(Effect.map((result) => result.post)),
  );

  const postAndNotify: MessageBoardService["Service"]["postAndNotify"] = Effect.fn(
    "MessageBoardService.postAndNotify",
  )(function* ({ notifyThreads = [], ...input }) {
    const stored = yield* storePost(input, notifyThreads);
    const saved = stored.post;
    const selection =
      saved.author.kind === "user" && input.mode !== "note"
        ? yield* sql`SELECT 1 FROM board_responder_selection_posts WHERE post_id=${saved.id}`
        : [];
    if (selection.length > 0)
      yield* responder
        .activate(saved.rootId)
        .pipe(
          Effect.mapError(
            (cause) => new MessageBoardStorageError({ operation: "selectResponder", cause }),
          ),
        );
    if (stored.replayed)
      return {
        post: saved,
        notifiedThreads: [],
        skippedThreads: [],
        coalescedThreads: [],
        notificationFailed: false,
      };
    const { author } = saved;
    if (author.kind === "system") return yield* invalidInput();
    if (author.kind === "agent") {
      yield* subscribe({
        viewer: { kind: "thread", threadId: author.threadId },
        target: { kind: "thread", rootId: saved.rootId },
        implicit: true,
      });
    }
    const subscribers = yield* listSubscribers(
      saved.id === saved.rootId
        ? { kind: "channel", channelName: saved.channelName }
        : { kind: "thread", rootId: saved.rootId },
    ).pipe(Effect.result);
    const mentioned = new Set(saved.mentions ?? []);
    const replyTarget =
      saved.replyToId === undefined ? null : yield* readPost({ postId: saved.replyToId });
    const repliedThreadId =
      replyTarget?.author.kind === "agent" ? replyTarget.author.threadId : null;
    const recipients = new Set([
      ...notifyThreads,
      ...mentioned,
      ...(repliedThreadId === null ? [] : [repliedThreadId]),
      ...(subscribers._tag === "Success" ? subscribers.success : []).flatMap((viewer) =>
        viewer.kind === "thread" ? [viewer.threadId] : [],
      ),
    ]);
    if (author.kind === "agent") recipients.delete(author.threadId);
    const label =
      author.kind === "agent"
        ? `${boardPersona(author.threadId).name} (${author.threadId})`
        : "the user";
    const text = saved.text.replace(/\s+/g, " ");
    const preview = `${text.slice(0, 240)}${text.length > 240 ? "…" : ""}`;
    const explicit = new Set(notifyThreads);
    const notifiedThreads: Array<ThreadId> = [];
    const skippedThreads: Array<ThreadId> = [];
    const coalescedThreads: Array<ThreadId> = [];
    for (const threadId of recipients) {
      if (author.kind === "user") {
        if (
          input.mode !== "note" &&
          (yield* handling.snapshot(saved.rootId)).responsibilities.some(
            (r) => r.postId === saved.id && r.recipientThreadId === threadId,
          )
        )
          notifiedThreads.push(threadId);
        continue;
      }
      const addressed = mentioned.has(threadId) || repliedThreadId === threadId;
      const what = mentioned.has(threadId) ? "You were mentioned" : "New post";
      const noticeKey = `${threadId}\u0000${saved.rootId}`;
      if (!addressed && !explicit.has(threadId)) {
        const pendingSince = pendingNotices.get(noticeKey);
        if (pendingSince !== undefined) {
          const read = yield* sql<{ read_at: string }>`
            SELECT read_at FROM board_thread_read_markers
            WHERE viewer_key = ${viewerKey({ kind: "thread", threadId })} AND root_id = ${saved.rootId}`;
          if ((read[0]?.read_at ?? "") < pendingSince) {
            coalescedThreads.push(threadId);
            continue;
          }
        }
      }
      const delivered = yield* Effect.gen(function* () {
        const thread = yield* threadManagement.getThreadShell(threadId);
        if (thread === null) return false;
        const running = thread.activeRunId !== null && thread.status === "running";
        // Only the user or the agent that delegated a thread may start it again; anything
        // looser lets agents wake each other forever.
        const followUp =
          addressed &&
          thread.lineage.relationshipToParent === "subagent" &&
          thread.lineage.parentThreadId === author.threadId;
        const resume = !running && thread.activeRunId === null && followUp;
        if (!running && !resume) return false;
        const message = {
          commandId: CommandId.make(`board:${saved.id}:${threadId}`),
          threadId,
          ...(author.kind === "agent" ? { senderThreadId: author.threadId } : {}),
          messageId: MessageId.make(`board:${saved.id}:${threadId}`),
          text: resume
            ? `${what} in #${saved.channelName} by ${label}: ${preview}. Read with board_read_thread ${saved.rootId}, then reply there.`
            : `${what} in #${saved.channelName} by ${label}: ${preview}. Read with board_read_thread ${saved.rootId}; further posts there won't notify you until you do.`,
          attachments: [],
        };
        if (followUp) {
          yield* threadManagement.sendToThread({
            ...message,
            projectId: thread.projectId,
            mode: resume ? "auto" : "steer",
            createdBy: author.kind === "agent" ? "agent" : "user",
            creationSource: author.kind === "agent" ? "mcp" : "web",
          });
        } else {
          yield* threadManagement.dispatch({
            ...message,
            type: "message.dispatch",
            dispatchMode: { type: "steer_active", targetRunId: thread.activeRunId! },
            notificationOnly: true,
            createdBy: "agent",
            creationSource: "server",
          });
        }
        return true;
      }).pipe(Effect.orElseSucceed(() => false));
      if (delivered) pendingNotices.set(noticeKey, saved.createdAt);
      (delivered ? notifiedThreads : skippedThreads).push(threadId);
    }
    return {
      post: saved,
      notifiedThreads,
      skippedThreads,
      coalescedThreads,
      notificationFailed: subscribers._tag === "Failure",
    };
  }, storage("postAndNotify"));

  const react: MessageBoardService["Service"]["react"] = Effect.fn("MessageBoardService.react")(
    function* (input) {
      const decoded = yield* decodeReact(input).pipe(Effect.mapError(invalidInput));
      const target = yield* readPost({ postId: decoded.postId });
      const key = viewerKey(input.viewer);
      if (decoded.active) {
        const now = yield* timestamp;
        yield* sql`INSERT INTO board_reactions (post_id, viewer_key, emoji, created_at)
          VALUES (${target.id}, ${key}, ${decoded.emoji}, ${now}) ON CONFLICT DO NOTHING`;
      } else {
        yield* sql`DELETE FROM board_reactions
          WHERE post_id = ${target.id} AND viewer_key = ${key} AND emoji = ${decoded.emoji}`;
      }
      const reactions = (yield* reactionsFor([target.id])).get(target.id) ?? [];
      yield* PubSub.publish(changes, {
        type: "reactions-changed",
        rootId: target.rootId,
        postId: target.id,
        reactions,
      });
    },
    writes.withPermit,
    storage("react"),
  );

  const markRead: MessageBoardService["Service"]["markRead"] = Effect.fn(
    "MessageBoardService.markRead",
  )(
    function* (input) {
      const { viewer } = input;
      const through =
        input.throughPostId === undefined ? null : yield* readPost({ postId: input.throughPostId });
      if (through !== null && (!("rootId" in input) || through.rootId !== input.rootId))
        return yield* invalidInput();
      const readAt = through?.createdAt ?? (yield* timestamp);
      if ("rootId" in input) {
        const root = yield* readPost({ postId: input.rootId });
        if (root.rootId !== root.id) return yield* notFound();
        yield* sql`INSERT INTO board_thread_read_markers (viewer_key, root_id, read_at) VALUES (${viewerKey(viewer)}, ${root.id}, ${readAt})
        ON CONFLICT (viewer_key, root_id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)`;
        if (viewer.kind === "thread") return yield* publishMember(root.id, viewer.threadId);
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
    yield* input.implicit
      ? sql`INSERT INTO board_subscriptions (viewer_key, target_kind, target)
        VALUES (${viewerKey(input.viewer)}, ${target.kind}, ${targetKey(target)}) ON CONFLICT DO NOTHING`
      : sql`INSERT INTO board_subscriptions (viewer_key, target_kind, target, enabled)
        VALUES (${viewerKey(input.viewer)}, ${target.kind}, ${targetKey(target)}, 1)
        ON CONFLICT DO UPDATE SET enabled = 1`;
    if (target.kind === "thread" && input.viewer.kind === "thread")
      yield* publishMember(target.rootId, input.viewer.threadId);
  }, storage("subscribe"));

  const unsubscribe: MessageBoardService["Service"]["unsubscribe"] = Effect.fn(
    "MessageBoardService.unsubscribe",
  )(function* (input) {
    yield* sql`INSERT INTO board_subscriptions (viewer_key, target_kind, target, enabled)
      VALUES (${viewerKey(input.viewer)}, ${input.target.kind}, ${targetKey(input.target)}, 0)
      ON CONFLICT DO UPDATE SET enabled = 0`;
    if (input.target.kind === "thread" && input.viewer.kind === "thread")
      yield* publishMember(input.target.rootId, input.viewer.threadId);
  }, storage("unsubscribe"));

  const listSubscribers: MessageBoardService["Service"]["listSubscribers"] = Effect.fn(
    "MessageBoardService.listSubscribers",
  )(function* (target) {
    const rows = yield* sql<{ viewer_key: string }>`SELECT viewer_key FROM board_subscriptions
      WHERE target_kind = ${target.kind} AND target = ${targetKey(target)} AND enabled = 1
      ORDER BY viewer_key`;
    return yield* decodeViewers(
      rows.map((row) =>
        row.viewer_key === "user"
          ? { kind: "user" }
          : { kind: "thread", threadId: row.viewer_key.slice("thread:".length) },
      ),
    );
  }, storage("listSubscribers"));

  const waitForPosts: MessageBoardService["Service"]["waitForPosts"] = Effect.fn(
    "MessageBoardService.waitForPosts",
  )(function* ({ viewer, rootId, timeoutMs }) {
    const key = viewerKey(viewer);
    const fromOthers = (post: BoardPost) =>
      post.author.kind === "system" ||
      viewerKey(
        post.author.kind === "user"
          ? post.author
          : { kind: "thread", threadId: post.author.threadId },
      ) !== key;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Subscribe before reading, so a post landing in between still ends the wait.
        const subscription = yield* PubSub.subscribe(changes);
        const root =
          yield* sql`SELECT 1 FROM board_posts WHERE id = ${rootId} AND root_id = ${rootId}`;
        if (root.length === 0) return yield* notFound();
        const readAt = (yield* readMarkers(viewer, [rootId]))(rootId) ?? "";
        const unread = (yield* decodePostRows(
          yield* sql`SELECT ${postColumns} FROM board_posts
              WHERE root_id = ${rootId} AND created_at > ${readAt}
              ORDER BY created_at ASC, id ASC`,
        ))
          .map(toPost)
          .filter(fromOthers);
        if (unread.length > 0) return unread;
        const next = yield* Effect.gen(function* () {
          while (true) {
            const event = yield* PubSub.take(subscription);
            if (
              event.type === "post-created" &&
              event.post.rootId === rootId &&
              fromOthers(event.post)
            )
              return event.post;
          }
        }).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)));
        return Option.isSome(next) ? [next.value] : [];
      }),
    );
  }, storage("waitForPosts"));

  const readHandling: MessageBoardService["Service"]["readHandling"] = Effect.fn(
    "MessageBoardService.readHandling",
  )(({ rootId }) => handling.snapshot(rootId), storage("readHandling"));
  const publishHandling = Effect.fn("MessageBoardService.publishHandling")(function* (
    state: BoardHandlingSnapshot,
  ) {
    yield* PubSub.publish(changes, { type: "handling-changed", handling: state });
    return state;
  });
  const assignLead: MessageBoardService["Service"]["assignLead"] = Effect.fn(
    "MessageBoardService.assignLead",
  )(
    function* (input) {
      const state = yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* handling.snapshot(input.rootId);
          if (
            current.leadThreadId === null &&
            input.viewer.kind === "thread" &&
            input.leadThreadId === input.viewer.threadId
          ) {
            if (current.revision !== input.expectedRevision)
              return yield* handling.conflict(current, "revision");
          } else {
            yield* handling.guard(input);
          }
          if (input.leadThreadId !== null) yield* agentAuthor(input.leadThreadId);
          yield* sql`UPDATE board_discussions SET lead_thread_id=${input.leadThreadId} WHERE root_id=${input.rootId}`;
          if (current.leadThreadId === null && input.leadThreadId !== null) {
            const adopted = yield* sql<{
              id: string;
              generation: number;
            }>`UPDATE board_responsibilities
              SET recipient_thread_id=${input.leadThreadId},generation=generation+1,status='pending'
              WHERE root_id=${input.rootId} AND recipient_thread_id IS NULL RETURNING id,generation`;
            if (Option.isSome(outbox)) {
              for (const request of adopted) {
                const identity = `board-adopt:${request.id}:${request.generation}`;
                yield* outbox.value.enqueue([
                  {
                    id: identity,
                    commandId: CommandId.make(identity),
                    threadId: input.leadThreadId,
                    request: {
                      type: "board-dispatch",
                      rootId: input.rootId,
                      recipientThreadId: input.leadThreadId,
                    },
                  },
                ]);
              }
            }
          }
          return yield* handling.bump(input.rootId);
        }),
      );
      if (Option.isSome(outbox)) yield* outbox.value.notifyAvailable();
      return yield* publishHandling(state);
    },
    writes.withPermit,
    storage("assignLead"),
  );
  const updateContext: MessageBoardService["Service"]["updateContext"] = Effect.fn(
    "MessageBoardService.updateContext",
  )(
    function* (input) {
      const state = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* handling.guard(input);
          for (const postId of input.context.decisionPostIds) {
            const post = yield* readPost({ postId });
            if (post.rootId !== input.rootId) return yield* invalidInput();
          }
          yield* sql`UPDATE board_discussions SET context_json=${yield* encodeHandlingContext(input.context)},context_revision=context_revision+1 WHERE root_id=${input.rootId}`;
          return yield* handling.bump(input.rootId);
        }),
      );
      return yield* publishHandling(state);
    },
    writes.withPermit,
    storage("updateContext"),
  );
  const reassignRequest: MessageBoardService["Service"]["reassignRequest"] = Effect.fn(
    "MessageBoardService.reassignRequest",
  )(
    function* (input) {
      const state = yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* handling.guard(input, input);
          const previous = current.responsibilities.find(
            (request) => request.id === input.responsibilityId,
          )!;
          if (previous.batchId !== undefined) {
            yield* sql`UPDATE board_dispatch_batches SET status='superseded' WHERE id=${previous.batchId}`;
            yield* sql`UPDATE board_responsibilities SET status='held' WHERE batch_id=${previous.batchId} AND status IN ('queued','running')`;
          }
          yield* agentAuthor(input.recipientThreadId);
          yield* sql`UPDATE board_responsibilities SET recipient_thread_id=${input.recipientThreadId},generation=generation+1,status='pending',outcome_json=NULL,batch_id=NULL,run_id=NULL,selection_id=NULL,selection_generation=NULL,availability_reason=NULL WHERE id=${input.responsibilityId}`;
          if (Option.isSome(outbox))
            yield* outbox.value.enqueue([
              {
                id: `board-reassign:${input.responsibilityId}:${input.expectedGeneration + 1}`,
                commandId: CommandId.make(
                  `board-reassign:${input.responsibilityId}:${input.expectedGeneration + 1}`,
                ),
                threadId: input.recipientThreadId,
                request: {
                  type: "board-dispatch",
                  rootId: input.rootId,
                  recipientThreadId: input.recipientThreadId,
                },
              },
            ]);
          return yield* handling.bump(input.rootId);
        }),
      );
      if (Option.isSome(outbox)) yield* outbox.value.notifyAvailable();
      return yield* publishHandling(state);
    },
    writes.withPermit,
    storage("reassignRequest"),
  );
  const resumeRequest: MessageBoardService["Service"]["resumeRequest"] = Effect.fn(
    "MessageBoardService.resumeRequest",
  )(
    function* (input) {
      const state = yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* handling.guard(input, input);
          const request = current.responsibilities.find((r) => r.id === input.responsibilityId)!;
          if (request.recipientThreadId === null) return yield* invalidInput();
          if (request.status !== "held" && request.status !== "needs-attention")
            return yield* handling.conflict(current, "generation", request.id);
          const batchId = `board-resume:${yield* crypto.randomUUIDv4()}`;
          const stopReceipts = yield* sql<{
            receipt: number;
          }>`SELECT COALESCE(MAX(rowid),0) AS receipt FROM orchestration_command_receipts WHERE aggregate_kind='thread' AND aggregate_id=${request.recipientThreadId} AND command_type='thread.stop' AND status='accepted'`;
          const scopedStopReceipt = stopReceipts[0]!.receipt;
          const generation = request.generation + 1;
          yield* sql`INSERT INTO board_dispatch_batches(id,root_id,recipient_thread_id,requests_json,scoped_resume,scoped_stop_receipt) VALUES(${batchId},${input.rootId},${request.recipientThreadId},${yield* encodeRequestGenerations([{ id: request.id, generation }])},1,${scopedStopReceipt})`;
          yield* sql`UPDATE board_responsibilities SET generation=${generation},status='queued',batch_id=${batchId},run_id=NULL,outcome_json=NULL,selection_id=NULL,selection_generation=NULL,availability_reason=NULL WHERE id=${request.id}`;
          if (Option.isSome(outbox))
            yield* outbox.value.enqueue([
              {
                id: batchId,
                commandId: CommandId.make(batchId),
                threadId: request.recipientThreadId,
                request: {
                  type: "board-dispatch",
                  rootId: input.rootId,
                  recipientThreadId: request.recipientThreadId,
                },
              },
            ]);
          return yield* handling.bump(input.rootId);
        }),
      );
      if (Option.isSome(outbox)) yield* outbox.value.notifyAvailable();
      return yield* publishHandling(state);
    },
    writes.withPermit,
    storage("resumeRequest"),
  );
  const reportOutcome: MessageBoardService["Service"]["reportOutcome"] = Effect.fn(
    "MessageBoardService.reportOutcome",
  )(
    function* (input) {
      const state = yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* handling.snapshot(input.rootId);
          const request = current.responsibilities.find((r) => r.id === input.responsibilityId);
          if (request && input.viewer.kind === "thread") {
            const resumeStopReceipt =
              request.batchId === undefined
                ? null
                : yield* handling.resumeStopReceipt({
                    batchId: request.batchId,
                    threadId: input.viewer.threadId,
                  });
            if (
              yield* BoardHandlingGuard.isBoardHandlingStopped({
                threadId: input.viewer.threadId,
                runId: input.runId,
                resumeStopReceipt,
              }).pipe(
                Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
                Effect.provideService(SqlClient.SqlClient, sql),
              )
            )
              return yield* handling.conflict(current, "stopped", request.id);
          }
          return yield* handling.reportOutcome(input);
        }),
      );
      return yield* publishHandling(state);
    },
    writes.withPermit,
    storage("reportOutcome"),
  );
  const closeDiscussion: MessageBoardService["Service"]["closeDiscussion"] = Effect.fn(
    "MessageBoardService.closeDiscussion",
  )(
    function* (input) {
      const state = yield* sql.withTransaction(
        Effect.gen(function* () {
          const state = yield* handling.guard(input);
          if (
            state.selections?.some((selection) => selection.status !== "selected") ||
            state.responsibilities.some(
              (r) => r.status !== "completed" || !r.outcome || r.outcome.kind === "blocked",
            )
          )
            return yield* handling.conflict(state, "unresolved");
          yield* sql`UPDATE board_discussions SET lifecycle='closed' WHERE root_id=${input.rootId}`;
          return yield* handling.bump(input.rootId);
        }),
      );
      return yield* publishHandling(state);
    },
    writes.withPermit,
    storage("closeDiscussion"),
  );
  const reopenDiscussion: MessageBoardService["Service"]["reopenDiscussion"] = Effect.fn(
    "MessageBoardService.reopenDiscussion",
  )(
    function* (input) {
      const state = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* handling.guard(input);
          yield* sql`UPDATE board_discussions SET lifecycle='open' WHERE root_id=${input.rootId}`;
          return yield* handling.bump(input.rootId);
        }),
      );
      return yield* publishHandling(state);
    },
    writes.withPermit,
    storage("reopenDiscussion"),
  );

  return MessageBoardService.of({
    readHandling,
    assignLead,
    updateContext,
    reassignRequest,
    resumeRequest,
    reportOutcome,
    closeDiscussion,
    reopenDiscussion,
    agentAuthor,
    setRole,
    listChannels,
    createChannel,
    upsertChannel,
    listThreads,
    readThread,
    readPost,
    listAgentThreads,
    searchPosts,
    post,
    postAndNotify,
    react,
    applyTodoAction,
    listTodos,
    getTodo,
    createTodo,
    updateTodo,
    deleteTodo,
    markRead,
    waitForPosts,
    subscribe,
    unsubscribe,
    listSubscribers,
    events: Stream.fromPubSub(changes),
  });
});

export const layer = Layer.effect(MessageBoardService, make).pipe(
  Layer.provideMerge(MessageBoardResponderSelection.layer),
  Layer.provideMerge(EffectOutbox.layer),
  Layer.provideMerge(MessageBoardHandlingEvents.layer),
);
