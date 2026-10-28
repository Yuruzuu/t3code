import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const BoardChannelName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
).annotate({ description: "Lowercase channel slug, such as 'release-notes'." });
export type BoardChannelName = typeof BoardChannelName.Type;

export const BoardPostId = TrimmedNonEmptyString.pipe(Schema.brand("BoardPostId"));
export type BoardPostId = typeof BoardPostId.Type;

export const BOARD_CHANNEL_DESCRIPTION_MAX_BYTES = 512;
export const BOARD_POST_TEXT_MAX_CHARS = 20_000;
export const BOARD_ROLE_MAX_CHARS = 40;

export const BoardAuthor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    threadId: ThreadId,
    projectId: Schema.NullOr(ProjectId),
    title: Schema.String,
    driver: Schema.NullOr(ProviderDriverKind),
    /** The agent's self-chosen board role at posting time, such as "Reviewer". */
    role: Schema.optionalKey(Schema.String),
    /** Display name of the model the agent ran on at posting time, such as "GPT-5.5". */
    model: Schema.optionalKey(Schema.String),
  }),
]);
export type BoardAuthor = typeof BoardAuthor.Type;

export const BoardPost = Schema.Struct({
  id: BoardPostId,
  channelName: BoardChannelName,
  /** Root post id of the board thread. Equals `id` for a root post. */
  rootId: BoardPostId,
  author: BoardAuthor,
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type BoardPost = typeof BoardPost.Type;

export const BoardChannel = Schema.Struct({
  name: BoardChannelName,
  description: Schema.NullOr(Schema.String),
  createdBy: BoardAuthor,
  createdAt: IsoDateTime,
  lastActivityAt: IsoDateTime,
  threadCount: Schema.Int,
  postCount: Schema.Int,
  /** Posts newer than the viewer's read marker. Viewer is the user for RPC, the calling thread for MCP. */
  unreadCount: Schema.Int,
  latestPost: Schema.NullOr(BoardPost),
  /** Distinct recent authors, newest first, at most 5. */
  recentAuthors: Schema.Array(BoardAuthor),
});
export type BoardChannel = typeof BoardChannel.Type;

export const BoardThreadSummary = Schema.Struct({
  root: BoardPost,
  latestReply: Schema.NullOr(BoardPost),
  replyCount: Schema.Int,
  lastActivityAt: IsoDateTime,
  /** Distinct authors, root author first, at most 8. */
  participants: Schema.Array(BoardAuthor),
  unread: Schema.Boolean,
});
export type BoardThreadSummary = typeof BoardThreadSummary.Type;

export const BoardMember = Schema.Struct({
  author: BoardAuthor,
  /** Subscribed agents get notified of replies while they have a running turn. */
  subscribed: Schema.Boolean,
  postCount: Schema.Int,
  lastPostedAt: Schema.NullOr(IsoDateTime),
});
export type BoardMember = typeof BoardMember.Type;

export const BoardThreadDetail = Schema.Struct({
  summary: BoardThreadSummary,
  /** Agents who posted in or subscribed to the thread, most recently active first. */
  members: Schema.Array(BoardMember),
  /** Root first, then replies oldest first. */
  posts: Schema.Array(BoardPost),
});
export type BoardThreadDetail = typeof BoardThreadDetail.Type;

export const BoardThreadSort = Schema.Literals(["activity", "created"]);
export type BoardThreadSort = typeof BoardThreadSort.Type;

export const BoardPostDestination = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("channel"), channelName: BoardChannelName }),
  Schema.Struct({ kind: Schema.Literal("reply"), rootId: BoardPostId }),
]);
export type BoardPostDestination = typeof BoardPostDestination.Type;

/** Live changes pushed to clients so lists and unread indicators stay current. */
export const BoardEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("channel-upserted"), channel: BoardChannel }),
  Schema.Struct({ type: Schema.Literal("post-created"), post: BoardPost }),
  Schema.Struct({
    type: Schema.Literal("read-marker-updated"),
    channelName: BoardChannelName,
    /** Set when one discussion was read; absent when the whole channel was. */
    rootId: Schema.optionalKey(BoardPostId),
    readAt: IsoDateTime,
  }),
]);
export type BoardEvent = typeof BoardEvent.Type;

export const BoardViewer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type BoardViewer = typeof BoardViewer.Type;

export const BoardSubscriptionTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("channel"), channelName: BoardChannelName }),
  Schema.Struct({ kind: Schema.Literal("thread"), rootId: BoardPostId }),
]);
export type BoardSubscriptionTarget = typeof BoardSubscriptionTarget.Type;

export const MessageBoardListChannelsInput = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
});
export const MessageBoardCreateChannelInput = Schema.Struct({
  name: BoardChannelName,
  description: Schema.optionalKey(Schema.String),
});
export const MessageBoardListThreadsInput = Schema.Struct({
  channelName: BoardChannelName,
  sort: BoardThreadSort,
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  cursor: Schema.optionalKey(Schema.String),
});
export const MessageBoardListThreadsResult = Schema.Struct({
  threads: Schema.Array(BoardThreadSummary),
  nextCursor: Schema.NullOr(Schema.String),
});
export type MessageBoardListThreadsResult = typeof MessageBoardListThreadsResult.Type;
export const MessageBoardReadThreadInput = Schema.Struct({ rootId: BoardPostId });
export const MessageBoardPostInput = Schema.Struct({
  destination: BoardPostDestination,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(BOARD_POST_TEXT_MAX_CHARS)),
});
export const MessageBoardMarkReadInput = Schema.Union([
  Schema.Struct({ channelName: BoardChannelName }),
  Schema.Struct({ rootId: BoardPostId }),
]);
export type MessageBoardMarkReadInput = typeof MessageBoardMarkReadInput.Type;

export class MessageBoardError extends Schema.TaggedError<MessageBoardError>()(
  "MessageBoardError",
  {
    code: Schema.Literals(["not_found", "invalid_input", "conflict", "storage"]),
    message: Schema.String,
  },
) {}
