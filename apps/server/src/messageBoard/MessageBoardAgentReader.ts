import {
  BoardPost,
  BoardPostId,
  BoardTodo,
  MessageBoardError,
  ThreadId,
  type BoardAuthor,
  type BoardViewer,
  type BoardThreadSummary,
  type BoardMember,
} from "@t3tools/contracts";
import { boardPersona } from "@t3tools/shared/boardPersona";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as MessageBoardService from "./MessageBoardService.ts";
import { decodeTodoRows, todoColumns } from "./MessageBoardTodoStore.ts";

export const RESPONSE_MAX_BYTES = 24_000;
const POST_CHUNK_CHARS = 4_000;
const PAGE_SIZE = 20;

export const namedAuthor = (author: BoardAuthor) =>
  author.kind === "agent" ? { ...author, name: boardPersona(author.threadId).name } : author;
export const namedPost = ({
  workedMs: _workedMs,
  changes: _changes,
  reactions: _reactions,
  ...post
}: BoardPost) => ({ ...post, author: namedAuthor(post.author) });
export const namedTodo = (todo: BoardTodo) => ({
  ...todo,
  assignee: todo.assignee === null ? null : namedAuthor(todo.assignee),
});

const Position = {
  time: Schema.String,
  id: BoardPostId,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
};
const ThreadCursor = Schema.Struct({
  kind: Schema.Literal("thread"),
  rootId: BoardPostId,
  snapshot: Schema.String,
  section: Schema.Literals(["posts", "todos", "members", "reactions"]),
  ...Position,
  todosRevision: Schema.Int,
  todoTime: Schema.String,
  todoId: Schema.String,
  memberId: Schema.String,
  reactionSnapshot: Schema.String,
  reactionTime: Schema.String,
  reactionPostId: Schema.String,
  reactionViewer: Schema.String,
  reactionEmoji: Schema.String,
});
const PostCursor = Schema.Struct({
  kind: Schema.Literal("post"),
  postId: BoardPostId,
  offset: Position.offset,
});
const SearchCursor = Schema.Struct({
  kind: Schema.Literal("search"),
  query: Schema.String,
  channelName: Schema.String,
  rootId: Schema.String,
  snapshot: Schema.String,
  time: Schema.String,
  id: BoardPostId,
});
const threadCursorJson = Schema.fromJsonString(ThreadCursor);
const postCursorJson = Schema.fromJsonString(PostCursor);
const searchCursorJson = Schema.fromJsonString(SearchCursor);
const encodeThreadCursor = Schema.encodeSync(threadCursorJson);
const encodePostCursor = Schema.encodeSync(postCursorJson);
const encodeSearchCursor = Schema.encodeSync(searchCursorJson);
const invalidCursor = () =>
  new MessageBoardError({
    code: "invalid_input",
    message: "Invalid message board continuation cursor.",
  });
const Ranges = Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.Int, Schema.Int])));
const encodeRanges = Schema.encodeSync(Ranges);
const decodeRanges = Schema.decodeUnknownEffect(Ranges);
const isBoardError = Schema.is(MessageBoardError);
const isStorageError = Schema.is(MessageBoardService.MessageBoardStorageError);

type PostChunk = ReturnType<typeof namedPost> & {
  textOffset: number;
  textTotalChars: number;
  textTruncated: boolean;
  nextCursor: string | null;
};
export type ThreadPage = {
  summary: ReturnType<typeof previewSummary>;
  posts: PostChunk[];
  members: Array<Omit<BoardMember, "author"> & { author: ReturnType<typeof namedAuthor> }>;
  reactions: Array<{ postId: BoardPostId; emoji: string; by: BoardViewer[] }>;
  todos: ReturnType<typeof namedTodo>[];
  todosRevision: number;
  snapshot: string;
  nextCursor: string | null;
};
export type SearchPage = { posts: ReturnType<typeof previewPost>[]; nextCursor: string | null };

export const previewPost = (post: BoardPost) => ({
  ...namedPost(post),
  text: post.text.slice(0, 1_000),
  textTruncated: post.text.length > 1_000,
});
const previewSummary = (summary: BoardThreadSummary) => ({
  ...summary,
  root: previewPost(summary.root),
  latestReply: summary.latestReply === null ? null : previewPost(summary.latestReply),
  participants: summary.participants.map(namedAuthor),
});
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

function chunk(post: BoardPost, offset: number, end: number): PostChunk {
  return {
    ...namedPost(post),
    text: post.text.slice(offset, end),
    textOffset: offset,
    textTotalChars: post.text.length,
    textTruncated: offset > 0 || end < post.text.length,
    nextCursor:
      end < post.text.length
        ? encodePostCursor({ kind: "post", postId: post.id, offset: end })
        : null,
  };
}

function fitChunk(post: BoardPost, offset: number, response: (post: PostChunk) => unknown) {
  let low = offset;
  let high = Math.min(post.text.length, offset + POST_CHUNK_CHARS);
  while (low < high) {
    const end = Math.ceil((low + high) / 2);
    if (jsonBytes(response(chunk(post, offset, end))) < RESPONSE_MAX_BYTES) low = end;
    else high = end - 1;
  }
  if (low < post.text.length && /[\uD800-\uDBFF]/.test(post.text.charAt(low - 1))) low -= 1;
  return low > offset ? chunk(post, offset, low) : null;
}

export class MessageBoardAgentReader extends Context.Service<
  MessageBoardAgentReader,
  {
    readonly listThreads: (
      input: Parameters<MessageBoardService.MessageBoardService["Service"]["listThreads"]>[0],
    ) => Effect.Effect<
      { threads: ReturnType<typeof previewSummary>[]; nextCursor: string | null },
      MessageBoardError | MessageBoardService.MessageBoardStorageError
    >;
    readonly readThread: (input: {
      viewer: BoardViewer;
      rootId: BoardPostId;
      cursor?: string;
    }) => Effect.Effect<
      ThreadPage,
      MessageBoardError | MessageBoardService.MessageBoardStorageError
    >;
    readonly readPost: (input: {
      viewer: BoardViewer;
      postId: BoardPostId;
      cursor?: string;
    }) => Effect.Effect<
      PostChunk,
      MessageBoardError | MessageBoardService.MessageBoardStorageError
    >;
    readonly search: (input: {
      query?: string;
      channelName?: string;
      rootId?: BoardPostId;
      limit?: number;
      cursor?: string;
    }) => Effect.Effect<
      SearchPage,
      MessageBoardError | MessageBoardService.MessageBoardStorageError
    >;
  }
>()("t3/messageBoard/MessageBoardAgentReader") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const board = yield* MessageBoardService.MessageBoardService;
  const writes = yield* Semaphore.make(1);
  const storage = (operation: string) =>
    Effect.mapError((cause: unknown) =>
      isBoardError(cause) || isStorageError(cause)
        ? cause
        : new MessageBoardService.MessageBoardStorageError({ operation, cause }),
    );
  const keyFor = (viewer: BoardViewer) =>
    viewer.kind === "user" ? "user" : `thread:${viewer.threadId}`;
  const columns = sql.literal(
    `id, root_id AS "rootId", channel_name AS "channelName", author_json AS author, text, created_at AS "createdAt", reply_to_id AS "replyToId", mentions_json AS mentions`,
  );
  const Row = Schema.Struct({
    id: BoardPostId,
    rootId: BoardPostId,
    channelName: Schema.String,
    author: Schema.fromJsonString(Schema.toType(BoardPost.fields.author)),
    text: Schema.String,
    createdAt: Schema.String,
    replyToId: Schema.NullOr(BoardPostId),
    mentions: Schema.NullOr(Schema.fromJsonString(Schema.Array(ThreadId))),
  });
  const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
  const decodeAuthor = Schema.decodeUnknownEffect(Schema.fromJsonString(BoardPost.fields.author));
  const postsFor = Effect.fn("MessageBoardAgentReader.postsFor")(function* (rows: unknown) {
    return (yield* decodeRows(rows)).map(({ replyToId, mentions, ...post }) => ({
      ...post,
      ...(replyToId === null ? {} : { replyToId }),
      ...(mentions === null ? {} : { mentions }),
    }));
  });
  const marker = Effect.fn("MessageBoardAgentReader.marker")(function* (
    viewer: BoardViewer,
    rootId: BoardPostId,
  ) {
    const rows = yield* sql<{ read_at: string | null }>`SELECT MAX(read_at) AS read_at FROM (
      SELECT read_at FROM board_thread_read_markers WHERE root_id = ${rootId} AND viewer_key = ${keyFor(viewer)}
      UNION ALL SELECT read_at FROM board_read_markers WHERE viewer_key = ${keyFor(viewer)}
        AND channel_name = (SELECT channel_name FROM board_posts WHERE id = ${rootId}))`;
    return rows[0]?.read_at ?? "";
  });
  const record = Effect.fn("MessageBoardAgentReader.recordDelivery")(function* (
    viewer: BoardViewer,
    posts: PostChunk[],
  ) {
    if (posts.length === 0) return;
    const boundaries = yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const post of posts) {
          const rows = yield* sql<{
            ranges_json: string;
          }>`SELECT ranges_json FROM board_post_deliveries
          WHERE viewer_key = ${keyFor(viewer)} AND post_id = ${post.id}`;
          const ranges = [
            ...(rows[0] ? yield* decodeRanges(rows[0].ranges_json) : []),
            [post.textOffset, post.textOffset + post.text.length] as const,
          ].sort((left, right) => left[0] - right[0]);
          const merged: [number, number][] = [];
          for (const [start, end] of ranges) {
            const previous = merged.at(-1);
            if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
            else merged.push([start, end]);
          }
          const complete = merged[0]?.[0] === 0 && merged[0][1] >= post.textTotalChars;
          yield* sql`INSERT INTO board_post_deliveries (viewer_key, post_id, ranges_json, complete)
          VALUES (${keyFor(viewer)}, ${post.id}, ${encodeRanges(merged)}, ${complete ? 1 : 0})
          ON CONFLICT (viewer_key, post_id) DO UPDATE SET ranges_json = excluded.ranges_json, complete = excluded.complete`;
        }
        const result: { rootId: BoardPostId; throughPostId: BoardPostId }[] = [];
        for (const rootId of new Set(posts.map((post) => post.rootId))) {
          const readAt = yield* marker(viewer, rootId);
          const rows = yield* sql<{ id: string }>`SELECT id FROM board_posts
          WHERE root_id = ${rootId} AND created_at > ${readAt}
            AND created_at < COALESCE((SELECT MIN(p.created_at) FROM board_posts p
              LEFT JOIN board_post_deliveries d ON d.post_id = p.id AND d.viewer_key = ${keyFor(viewer)}
              WHERE p.root_id = ${rootId} AND p.created_at > ${readAt} AND COALESCE(d.complete, 0) = 0), '9999')
          ORDER BY created_at DESC, id DESC LIMIT 1`;
          if (rows[0]) result.push({ rootId, throughPostId: BoardPostId.make(rows[0].id) });
        }
        return result;
      }),
    );
    for (const boundary of boundaries) yield* board.markRead({ viewer, ...boundary });
  }, writes.withPermit);

  const readPost: MessageBoardAgentReader["Service"]["readPost"] = Effect.fn(
    "MessageBoardAgentReader.readPost",
  )(function* (input) {
    const cursor =
      input.cursor === undefined
        ? null
        : yield* Schema.decodeEffect(postCursorJson)(input.cursor).pipe(
            Effect.mapError(invalidCursor),
          );
    if (cursor !== null && cursor.postId !== input.postId) return yield* invalidCursor();
    const post = yield* board.readPost({ postId: input.postId });
    const offset = cursor?.offset ?? 0;
    if (offset >= post.text.length) return yield* invalidCursor();
    const result = fitChunk(post, offset, (post) => post);
    if (result === null)
      return yield* new MessageBoardError({
        code: "invalid_input",
        message: "Post metadata exceeds the response budget.",
      });
    yield* record(input.viewer, [result]);
    return result;
  }, storage("readPost"));

  const readThread: MessageBoardAgentReader["Service"]["readThread"] = Effect.fn(
    "MessageBoardAgentReader.readThread",
  )(function* (input) {
    const root = yield* board.readPost({ postId: input.rootId });
    if (root.rootId !== root.id)
      return yield* new MessageBoardError({
        code: "not_found",
        message: "Board discussion was not found.",
      });
    const revisions = yield* sql<{
      revision: number;
    }>`SELECT revision FROM board_todo_revisions WHERE root_id = ${root.id}`;
    const todosRevision = revisions[0]?.revision ?? 0;
    const reactionSnapshot =
      input.cursor === undefined
        ? ((yield* sql<{
            time: string | null;
          }>`SELECT MAX(r.created_at) AS time FROM board_reactions r
          JOIN board_posts p ON p.id = r.post_id WHERE p.root_id = ${root.id}`)[0]?.time ?? "")
        : "";
    const last = (yield* postsFor(
      yield* sql`SELECT ${columns} FROM board_posts WHERE root_id = ${root.id} ORDER BY created_at DESC, id DESC LIMIT 1`,
    ))[0]!;
    let cursor =
      input.cursor === undefined
        ? {
            kind: "thread" as const,
            rootId: root.id,
            snapshot: last.createdAt,
            section: "posts" as const,
            time: "",
            id: root.id,
            offset: 0,
            todosRevision,
            todoTime: "",
            todoId: "",
            memberId: "",
            reactionSnapshot,
            reactionTime: "",
            reactionPostId: "",
            reactionViewer: "",
            reactionEmoji: "",
          }
        : yield* Schema.decodeEffect(threadCursorJson)(input.cursor).pipe(
            Effect.mapError(invalidCursor),
          );
    if (cursor.rootId !== root.id) return yield* invalidCursor();
    if (cursor.section === "posts") cursor = { ...cursor, todosRevision };
    if (cursor.section === "todos" && cursor.todosRevision !== todosRevision)
      return yield* new MessageBoardError({
        code: "conflict",
        message: "The shared todos changed. Restart board_read_thread without a cursor.",
      });
    const startCursor = encodeThreadCursor(cursor);
    const count = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM board_posts WHERE root_id = ${root.id}`;
    const participants = yield* sql<{
      author: string;
    }>`SELECT author_json AS author, MIN(created_at) AS first_post
      FROM board_posts WHERE root_id = ${root.id}
      GROUP BY COALESCE(json_extract(author_json, '$.threadId'), 'user') ORDER BY first_post LIMIT 8`;
    const response: ThreadPage = {
      summary: previewSummary({
        root,
        latestReply: last.id === root.id ? null : last,
        replyCount: (count[0]?.count ?? 1) - 1,
        lastActivityAt: last.createdAt,
        participants: yield* Effect.forEach(participants, (row) => decodeAuthor(row.author)),
        unread: last.createdAt > (yield* marker(input.viewer, root.id)),
      }),
      posts: [],
      members: [],
      reactions: [],
      todos: [],
      todosRevision: cursor.todosRevision,
      snapshot: cursor.snapshot,
      nextCursor: encodeThreadCursor(cursor),
    };
    if (cursor.section === "posts") {
      const rows = yield* postsFor(
        yield* sql`SELECT ${columns} FROM board_posts
        WHERE root_id = ${root.id} AND created_at <= ${cursor.snapshot}
          AND (created_at > ${cursor.time} OR (created_at = ${cursor.time} AND id >= ${cursor.id}))
        ORDER BY created_at, id LIMIT ${PAGE_SIZE + 1}`,
      );
      let finished = rows.length <= PAGE_SIZE;
      for (const post of rows.slice(0, PAGE_SIZE)) {
        const offset = post.id === cursor.id ? cursor.offset : 0;
        if (offset > post.text.length) return yield* invalidCursor();
        if (offset === post.text.length) continue;
        const makeNext = (part: PostChunk) => ({
          ...cursor,
          time: post.createdAt,
          id: post.id,
          offset: part.textOffset + part.text.length,
        });
        const part = fitChunk(post, offset, (part) => ({
          ...response,
          posts: [...response.posts, part],
          nextCursor: encodeThreadCursor(makeNext(part)),
        }));
        if (part === null) {
          finished = false;
          break;
        }
        response.posts.push(part);
        cursor = makeNext(part);
        response.nextCursor = encodeThreadCursor(cursor);
        if (part.nextCursor !== null) {
          finished = false;
          break;
        }
      }
      if (finished) cursor = { ...cursor, section: "todos" };
    }
    if (cursor.section === "todos") {
      const rows = yield* sql`SELECT ${sql.literal(todoColumns)} FROM board_todos t
        WHERE t.root_id = ${root.id} AND (t.created_at > ${cursor.todoTime} OR (t.created_at = ${cursor.todoTime} AND t.id > ${cursor.todoId}))
        ORDER BY t.created_at, t.id LIMIT ${PAGE_SIZE + 1}`;
      const todos = yield* decodeTodoRows(rows);
      let finished = todos.length <= PAGE_SIZE;
      for (const todo of todos.slice(0, PAGE_SIZE)) {
        const next = { ...cursor, todoTime: todo.createdAt, todoId: todo.id };
        const candidate = {
          ...response,
          todos: [...response.todos, namedTodo(todo)],
          nextCursor: encodeThreadCursor(next),
        };
        if (jsonBytes(candidate) >= RESPONSE_MAX_BYTES) {
          finished = false;
          break;
        }
        response.todos.push(namedTodo(todo));
        cursor = next;
      }
      if (finished) cursor = { ...cursor, section: "members" };
      response.nextCursor = encodeThreadCursor(cursor);
    }
    if (cursor.section === "members") {
      const rows = yield* sql<{
        thread_id: string;
        author: string | null;
        post_count: number;
        last_posted_at: string | null;
        read_at: string | null;
        subscribed: number;
      }>`
        SELECT thread_id,
          (SELECT author_json FROM board_posts p WHERE p.root_id = ${root.id} AND json_extract(p.author_json, '$.threadId') = thread_id ORDER BY p.created_at DESC LIMIT 1) AS author,
          (SELECT COUNT(*) FROM board_posts p WHERE p.root_id = ${root.id} AND json_extract(p.author_json, '$.threadId') = thread_id) AS post_count,
          (SELECT MAX(created_at) FROM board_posts p WHERE p.root_id = ${root.id} AND json_extract(p.author_json, '$.threadId') = thread_id) AS last_posted_at,
          (SELECT read_at FROM board_thread_read_markers r WHERE r.root_id = ${root.id} AND r.viewer_key = 'thread:' || thread_id) AS read_at,
          EXISTS(SELECT 1 FROM board_subscriptions s WHERE s.target_kind = 'thread' AND s.target = ${root.id} AND s.viewer_key = 'thread:' || thread_id AND s.enabled = 1) AS subscribed
        FROM (
          SELECT json_extract(author_json, '$.threadId') AS thread_id FROM board_posts WHERE root_id = ${root.id} AND json_extract(author_json, '$.kind') = 'agent'
          UNION SELECT substr(viewer_key, 8) FROM board_subscriptions WHERE target_kind = 'thread' AND target = ${root.id} AND enabled = 1 AND viewer_key LIKE 'thread:%'
          UNION SELECT substr(viewer_key, 8) FROM board_thread_read_markers WHERE root_id = ${root.id} AND viewer_key LIKE 'thread:%'
        ) WHERE thread_id > ${cursor.memberId} ORDER BY thread_id LIMIT ${PAGE_SIZE + 1}`;
      let finished = rows.length <= PAGE_SIZE;
      for (const member of rows.slice(0, PAGE_SIZE)) {
        const author =
          member.author === null
            ? yield* board.agentAuthor(ThreadId.make(member.thread_id)).pipe(
                Effect.catchTags({
                  MessageBoardError: (error) =>
                    error.code === "not_found" ? Effect.succeed(null) : Effect.fail(error),
                }),
              )
            : yield* decodeAuthor(member.author);
        const next = { ...cursor, memberId: member.thread_id };
        if (author?.kind === "agent") {
          const value = {
            author: namedAuthor(author),
            subscribed: member.subscribed === 1,
            postCount: member.post_count,
            lastPostedAt: member.last_posted_at,
            ...(member.read_at === null ? {} : { readAt: member.read_at }),
          };
          if (
            jsonBytes({
              ...response,
              members: [...response.members, value],
              nextCursor: encodeThreadCursor(next),
            }) >= RESPONSE_MAX_BYTES
          ) {
            finished = false;
            break;
          }
          response.members.push(value);
        }
        cursor = next;
      }
      if (finished) cursor = { ...cursor, section: "reactions" };
      response.nextCursor = encodeThreadCursor(cursor);
    }
    if (cursor.section === "reactions") {
      const rows = yield* sql<{
        post_id: string;
        viewer_key: string;
        emoji: string;
        created_at: string;
      }>`
        SELECT r.* FROM board_reactions r JOIN board_posts p ON p.id = r.post_id
        WHERE p.root_id = ${root.id} AND p.created_at <= ${cursor.snapshot} AND r.created_at <= ${cursor.reactionSnapshot}
          AND (r.created_at > ${cursor.reactionTime} OR (r.created_at = ${cursor.reactionTime}
            AND (r.post_id > ${cursor.reactionPostId} OR (r.post_id = ${cursor.reactionPostId}
              AND (r.viewer_key > ${cursor.reactionViewer} OR (r.viewer_key = ${cursor.reactionViewer} AND r.emoji > ${cursor.reactionEmoji}))))))
        ORDER BY r.created_at, r.post_id, r.viewer_key, r.emoji LIMIT ${PAGE_SIZE + 1}`;
      let finished = rows.length <= PAGE_SIZE;
      for (const reaction of rows.slice(0, PAGE_SIZE)) {
        const viewer: BoardViewer =
          reaction.viewer_key === "user"
            ? { kind: "user" }
            : { kind: "thread", threadId: ThreadId.make(reaction.viewer_key.slice(7)) };
        const value = {
          postId: BoardPostId.make(reaction.post_id),
          emoji: reaction.emoji,
          by: [viewer],
        };
        const next = {
          ...cursor,
          reactionTime: reaction.created_at,
          reactionPostId: reaction.post_id,
          reactionViewer: reaction.viewer_key,
          reactionEmoji: reaction.emoji,
        };
        if (
          jsonBytes({
            ...response,
            reactions: [...response.reactions, value],
            nextCursor: encodeThreadCursor(next),
          }) >= RESPONSE_MAX_BYTES
        ) {
          finished = false;
          break;
        }
        response.reactions.push(value);
        cursor = next;
      }
      response.nextCursor = finished ? null : encodeThreadCursor(cursor);
    }
    if (
      jsonBytes(response) >= RESPONSE_MAX_BYTES ||
      (response.posts.length === 0 &&
        response.todos.length === 0 &&
        response.members.length === 0 &&
        response.reactions.length === 0 &&
        response.nextCursor === startCursor)
    )
      return yield* new MessageBoardError({
        code: "invalid_input",
        message: "Discussion metadata exceeds the response budget.",
      });
    yield* record(input.viewer, response.posts);
    response.summary.unread = last.createdAt > (yield* marker(input.viewer, root.id));
    return response;
  }, storage("readThread"));

  const search: MessageBoardAgentReader["Service"]["search"] = Effect.fn(
    "MessageBoardAgentReader.search",
  )(function* (input) {
    const query = input.query?.trim() ?? "";
    const channelName = input.channelName ?? "";
    const rootId = input.rootId ?? "";
    const limit = input.limit ?? PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return yield* invalidCursor();
    const cursor =
      input.cursor === undefined
        ? null
        : yield* Schema.decodeEffect(searchCursorJson)(input.cursor).pipe(
            Effect.mapError(invalidCursor),
          );
    if (
      cursor &&
      (cursor.query !== query || cursor.channelName !== channelName || cursor.rootId !== rootId)
    )
      return yield* invalidCursor();
    const latest = yield* sql<{
      time: string | null;
    }>`SELECT MAX(created_at) AS time FROM board_posts`;
    const snapshot = cursor?.snapshot ?? latest[0]?.time ?? "";
    const posts = yield* postsFor(
      yield* sql`SELECT ${columns} FROM board_posts
      WHERE (${channelName} = '' OR channel_name = ${channelName}) AND (${rootId} = '' OR root_id = ${rootId})
        AND instr(lower(text), lower(${query})) > 0 AND created_at <= ${snapshot}
        AND ${cursor === null ? sql`1` : sql`(created_at < ${cursor.time} OR (created_at = ${cursor.time} AND id < ${cursor.id}))`}
      ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
    );
    const result: SearchPage = { posts: [], nextCursor: null };
    for (const post of posts.slice(0, limit)) {
      const nextCursor = encodeSearchCursor({
        kind: "search",
        query,
        channelName,
        rootId,
        snapshot,
        time: post.createdAt,
        id: post.id,
      });
      const candidate = { posts: [...result.posts, previewPost(post)], nextCursor };
      if (jsonBytes(candidate) > RESPONSE_MAX_BYTES) break;
      result.posts = candidate.posts;
      result.nextCursor = nextCursor;
    }
    if (result.posts.length === posts.length) result.nextCursor = null;
    if (posts.length > 0 && result.posts.length === 0)
      return yield* new MessageBoardError({
        code: "invalid_input",
        message: "Post metadata exceeds the response budget.",
      });
    return result;
  }, storage("search"));
  const listThreads: MessageBoardAgentReader["Service"]["listThreads"] = Effect.fn(
    "MessageBoardAgentReader.listThreads",
  )(function* (input) {
    let limit = Math.min(input.limit ?? PAGE_SIZE, PAGE_SIZE);
    for (;;) {
      const result = yield* board.listThreads({ ...input, limit });
      const response = { ...result, threads: result.threads.map(previewSummary) };
      if (jsonBytes(response) <= RESPONSE_MAX_BYTES) return response;
      if (limit === 1)
        return yield* new MessageBoardError({
          code: "invalid_input",
          message: "Discussion metadata exceeds the response budget.",
        });
      limit = Math.max(1, Math.floor(limit / 2));
    }
  }, storage("listThreads"));
  return MessageBoardAgentReader.of({ readThread, readPost, search, listThreads });
});

export const layer = Layer.effect(MessageBoardAgentReader, make);
