import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationV2CheckpointFileSummary } from "./orchestrationV2.ts";
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
  Schema.Struct({ kind: Schema.Literal("system") }),
]);
export type BoardAuthor = typeof BoardAuthor.Type;

export const BoardViewer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type BoardViewer = typeof BoardViewer.Type;

const BOARD_REACTION_MAX_CHARS = 16;
/** One emoji, such as "👍". */
export const BoardReactionEmoji = TrimmedNonEmptyString.check(
  Schema.isMaxLength(BOARD_REACTION_MAX_CHARS),
  Schema.isPattern(/^\S+$/u),
);
export type BoardReactionEmoji = typeof BoardReactionEmoji.Type;

export const BoardReaction = Schema.Struct({
  emoji: BoardReactionEmoji,
  /** Oldest first. */
  by: Schema.Array(BoardViewer),
});
export type BoardReaction = typeof BoardReaction.Type;

export const BoardPost = Schema.Struct({
  id: BoardPostId,
  channelName: BoardChannelName,
  /** Root post id of the board thread. Equals `id` for a root post. */
  rootId: BoardPostId,
  author: BoardAuthor,
  text: Schema.String,
  createdAt: IsoDateTime,
  /** The earlier post in the same discussion this one answers. */
  replyToId: Schema.optionalKey(BoardPostId),
  /** Agents tagged by stable identity, or by an unambiguous persona name. */
  mentions: Schema.optionalKey(Schema.Array(ThreadId)),
  /** Present only on discussion reads and reaction events. */
  reactions: Schema.optionalKey(Schema.Array(BoardReaction)),
  /** How long the agent author worked in its run before posting. */
  workedMs: Schema.optionalKey(NonNegativeInt),
  /** Files the agent's run changed, once that run has finished. Discussion reads only. */
  changes: Schema.optionalKey(
    Schema.Struct({ runId: RunId, files: Schema.Array(OrchestrationV2CheckpointFileSummary) }),
  ),
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
  /** The viewer's read marker for this discussion; absent until they first read it. */
  readAt: Schema.optionalKey(IsoDateTime),
});
export type BoardThreadSummary = typeof BoardThreadSummary.Type;

export const BoardMember = Schema.Struct({
  author: BoardAuthor,
  /** Subscribed agents get notified of replies while they have a running turn. */
  subscribed: Schema.Boolean,
  postCount: Schema.Int,
  lastPostedAt: Schema.NullOr(IsoDateTime),
  /** When the agent last read the discussion; posts at or before it are seen. */
  readAt: Schema.optionalKey(IsoDateTime),
});
export type BoardMember = typeof BoardMember.Type;

export const BOARD_TODO_TEXT_MAX_CHARS = 500;
export const BoardTodoStatus = Schema.Literals([
  "todo",
  "in-progress",
  "blocked",
  "done",
  "cancelled",
]);
export const BoardTodoCompletion = Schema.Union([
  Schema.Struct({ text: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)) }).annotate({
    parseOptions: { onExcessProperty: "error" },
  }),
  Schema.Struct({ sourcePostId: BoardPostId }).annotate({
    parseOptions: { onExcessProperty: "error" },
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
export const BoardTodoHistory = Schema.Struct({
  actor: BoardViewer,
  action: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  at: IsoDateTime,
  version: NonNegativeInt,
});
export const BoardTodo = Schema.Struct({
  version: NonNegativeInt,
  blockerReason: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  completion: Schema.optionalKey(BoardTodoCompletion),
  history: Schema.Array(BoardTodoHistory),
  id: TrimmedNonEmptyString,
  rootId: BoardPostId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(BOARD_TODO_TEXT_MAX_CHARS)),
  status: BoardTodoStatus,
  assignee: Schema.NullOr(BoardAuthor),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BoardTodo = typeof BoardTodo.Type;
// Existing servers omit these fields until the versioned todo migration is installed.
const BoardTodoSnapshot = Schema.Struct({
  ...BoardTodo.fields,
  version: BoardTodo.fields.version.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1))),
  history: BoardTodo.fields.history.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export const MessageBoardTodosResult = Schema.Struct({
  todos: Schema.Array(BoardTodoSnapshot),
  todosRevision: NonNegativeInt,
});
export type MessageBoardTodosResult = typeof MessageBoardTodosResult.Type;

export const BoardTodoItem = BoardTodo.mapFields(({ assignee: _assignee, ...fields }) => ({
  ...fields,
  assigneeThreadId: Schema.NullOr(ThreadId),
}));
export type BoardTodoItem = typeof BoardTodoItem.Type;
const todoGuard = { todoId: BoardTodo.fields.id, expectedVersion: NonNegativeInt };
const todoReason = TrimmedNonEmptyString.check(Schema.isMaxLength(1000));
const todoOverride = {
  override: Schema.optionalKey(Schema.Literal(false)),
  reason: Schema.optionalKey(todoReason),
};
export const BoardTodoAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    text: BoardTodo.fields.text,
    status: Schema.optionalKey(Schema.Literal("todo")),
    reason: Schema.optionalKey(todoReason),
    assigneeThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  }),
  Schema.Struct({
    type: Schema.Literal("create"),
    text: BoardTodo.fields.text,
    status: Schema.Literal("blocked"),
    reason: todoReason,
    assigneeThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  }),
  Schema.Struct({ type: Schema.Literal("start"), ...todoGuard }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    ...todoGuard,
    completion: Schema.optionalKey(BoardTodoCompletion),
  }),
  Schema.Struct({ type: Schema.Literal("release"), ...todoGuard }),
  Schema.Struct({
    type: Schema.Literal("edit"),
    ...todoGuard,
    text: BoardTodo.fields.text,
    ...todoOverride,
  }),
  Schema.Struct({
    type: Schema.Literal("edit"),
    ...todoGuard,
    text: BoardTodo.fields.text,
    override: Schema.Literal(true),
    reason: todoReason,
  }),
  Schema.Struct({
    type: Schema.Literal("block"),
    ...todoGuard,
    reason: todoReason,
    override: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("unblock"), ...todoGuard, ...todoOverride }),
  Schema.Struct({
    type: Schema.Literal("unblock"),
    ...todoGuard,
    override: Schema.Literal(true),
    reason: todoReason,
  }),
  Schema.Struct({
    type: Schema.Literal("reassign"),
    ...todoGuard,
    assigneeThreadId: Schema.NullOr(ThreadId),
    reason: todoReason,
  }),
  Schema.Struct({ type: Schema.Literal("cancel"), ...todoGuard, reason: todoReason }),
  Schema.Struct({
    type: Schema.Literal("reopen"),
    ...todoGuard,
    status: Schema.Literals(["todo", "blocked"]),
    reason: todoReason,
  }),
  Schema.Struct({ type: Schema.Literal("remove"), ...todoGuard, reason: todoReason }),
]);
export const MessageBoardTodoActionInput = Schema.Struct({
  rootId: BoardPostId,
  requestKey: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  action: BoardTodoAction,
});
export const MessageBoardTodoActionResult = Schema.Struct({
  item: Schema.NullOr(BoardTodoItem),
  todoId: BoardTodo.fields.id,
  version: NonNegativeInt,
  todosRevision: NonNegativeInt,
  replay: Schema.Boolean,
  removed: Schema.Boolean,
});
export type MessageBoardTodoActionResult = typeof MessageBoardTodoActionResult.Type;
export const MessageBoardTodoFilter = Schema.Literals(["available", "open", "mine", "all"]);
export const MessageBoardListTodosInput = Schema.Struct({
  rootId: BoardPostId,
  filter: Schema.optionalKey(MessageBoardTodoFilter),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  cursor: Schema.optionalKey(Schema.String),
});
export const MessageBoardListTodosResult = Schema.Struct({
  items: Schema.Array(BoardTodoItem),
  todosRevision: NonNegativeInt,
  nextCursor: Schema.NullOr(Schema.String),
});
export const MessageBoardGetTodoInput = Schema.Struct({
  rootId: BoardPostId,
  todoId: BoardTodo.fields.id,
});
export const MessageBoardGetTodoResult = Schema.Struct({
  item: Schema.NullOr(BoardTodoItem),
  todosRevision: NonNegativeInt,
});

export const MessageBoardCreateTodoInput = Schema.Struct({
  rootId: BoardPostId,
  text: BoardTodo.fields.text,
  assigneeThreadId: Schema.optionalKey(ThreadId),
});
export const MessageBoardUpdateTodoInput = Schema.Struct({
  rootId: BoardPostId,
  todoId: TrimmedNonEmptyString,
  text: Schema.optionalKey(BoardTodo.fields.text),
  status: Schema.optionalKey(BoardTodoStatus),
  assigneeThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  expectedAssigneeThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  expectedStatus: Schema.optionalKey(BoardTodoStatus),
});
export const MessageBoardDeleteTodoInput = Schema.Struct({
  rootId: BoardPostId,
  todoId: TrimmedNonEmptyString,
});

export const BoardHandlingOutcome = Schema.Struct({
  kind: Schema.Literals(["answered", "completed", "blocked", "declined"]),
  text: TrimmedNonEmptyString,
  sourcePostIds: Schema.Array(BoardPostId),
});
export type BoardHandlingOutcome = typeof BoardHandlingOutcome.Type;

export const BoardResponderReason = Schema.Literals([
  "missing-key",
  "invalid-input",
  "timeout",
  "transport-error",
  "rate-limit",
  "budget-exhausted",
  "http-error",
  "refusal",
  "incomplete",
  "malformed-response",
  "unknown-label",
  "uncertain",
  "interrupted",
  "deadline",
  "stale-context",
  "no-eligible",
  "reselected",
]);
export const BoardResponderSelection = Schema.Struct({
  id: TrimmedNonEmptyString,
  rootId: BoardPostId,
  generation: NonNegativeInt,
  status: Schema.Literals(["selecting", "selected", "unavailable"]),
  contextFingerprint: Schema.String,
  rosterFingerprint: Schema.String,
  recipientThreadId: Schema.NullOr(ThreadId),
  originThreadId: Schema.NullOr(ThreadId),
  method: Schema.NullOr(Schema.Literals(["single", "decisions", "fallback"])),
  fallbackReason: Schema.NullOr(BoardResponderReason),
  deadlineAt: Schema.String,
  attemptCount: NonNegativeInt,
  callStartedAt: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  sourcePostIds: Schema.Array(BoardPostId),
});
export type BoardResponderSelection = typeof BoardResponderSelection.Type;

export const BoardResponsibility = Schema.Struct({
  id: TrimmedNonEmptyString,
  postId: BoardPostId,
  recipientThreadId: Schema.NullOr(ThreadId),
  generation: NonNegativeInt,
  status: Schema.Literals(["pending", "queued", "running", "held", "completed", "needs-attention"]),
  outcome: Schema.optionalKey(BoardHandlingOutcome),
  runId: Schema.optionalKey(RunId),
  batchId: Schema.optionalKey(TrimmedNonEmptyString),
  selectionId: Schema.optionalKey(TrimmedNonEmptyString),
  availabilityReason: Schema.optionalKey(
    Schema.Literals(["stopped", "parent-stopped", "archived", "deleted", "missing", "unavailable"]),
  ),
});
export type BoardResponsibility = typeof BoardResponsibility.Type;

export const BoardHandlingContext = Schema.Struct({
  text: Schema.String,
  decisionPostIds: Schema.Array(BoardPostId),
});
export const BoardHandlingSnapshot = Schema.Struct({
  rootId: BoardPostId,
  revision: NonNegativeInt,
  leadThreadId: Schema.NullOr(ThreadId),
  suggestedLeadThreadId: Schema.NullOr(ThreadId),
  lifecycle: Schema.Literals(["open", "closed"]),
  context: BoardHandlingContext,
  responsibilities: Schema.Array(BoardResponsibility),
  selections: Schema.optionalKey(Schema.Array(BoardResponderSelection)),
});
export type BoardHandlingSnapshot = typeof BoardHandlingSnapshot.Type;

const handlingGuard = { rootId: BoardPostId, expectedRevision: NonNegativeInt };
const responsibilityGuard = {
  ...handlingGuard,
  responsibilityId: TrimmedNonEmptyString,
  expectedGeneration: NonNegativeInt,
};
export const MessageBoardAssignLeadInput = Schema.Struct({
  ...handlingGuard,
  leadThreadId: Schema.NullOr(ThreadId),
});
export const MessageBoardUpdateContextInput = Schema.Struct({
  ...handlingGuard,
  context: BoardHandlingContext,
});
export const MessageBoardReassignRequestInput = Schema.Struct({
  ...responsibilityGuard,
  recipientThreadId: ThreadId,
});
export const MessageBoardResumeRequestInput = Schema.Struct(responsibilityGuard);
export const MessageBoardReportOutcomeInput = Schema.Struct({
  ...responsibilityGuard,
  runId: RunId,
  outcome: BoardHandlingOutcome,
});
export const MessageBoardCloseDiscussionInput = Schema.Struct(handlingGuard);
export const MessageBoardReopenDiscussionInput = Schema.Struct(handlingGuard);

export const BoardThreadDetail = Schema.Struct({
  todos: Schema.optionalKey(Schema.Array(BoardTodoSnapshot)),
  todosRevision: Schema.optionalKey(NonNegativeInt),
  handling: Schema.optionalKey(BoardHandlingSnapshot),
  summary: BoardThreadSummary,
  /** Agents who posted in, subscribed to, or read the thread, most recently active first. */
  members: Schema.Array(BoardMember),
  /** Root first, then replies oldest first. */
  posts: Schema.Array(BoardPost),
  olderPostsCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
  Schema.Struct({ type: Schema.Literal("handling-changed"), handling: BoardHandlingSnapshot }),
  Schema.Struct({
    type: Schema.Literal("todos-changed"),
    rootId: BoardPostId,
    ...MessageBoardTodosResult.fields,
  }),
  Schema.Struct({ type: Schema.Literal("channel-upserted"), channel: BoardChannel }),
  Schema.Struct({ type: Schema.Literal("post-created"), post: BoardPost }),
  Schema.Struct({
    type: Schema.Literal("reactions-changed"),
    rootId: BoardPostId,
    postId: BoardPostId,
    reactions: Schema.Array(BoardReaction),
  }),
  /** Discussion membership or an agent's read position changed. */
  Schema.Struct({
    type: Schema.Literal("member-updated"),
    rootId: BoardPostId,
    member: BoardMember,
  }),
  Schema.Struct({
    type: Schema.Literal("read-marker-updated"),
    channelName: BoardChannelName,
    /** Set when one discussion was read; absent when the whole channel was. */
    rootId: Schema.optionalKey(BoardPostId),
    readAt: IsoDateTime,
  }),
]);
export type BoardEvent = typeof BoardEvent.Type;

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
export const MessageBoardReadThreadInput = Schema.Struct({
  rootId: BoardPostId,
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
});
export const MessageBoardListAgentThreadsInput = Schema.Struct({ threadId: ThreadId });
/** Discussions an agent posted in or is subscribed to, most recently active first. */
export const MessageBoardListAgentThreadsResult = Schema.Array(BoardThreadSummary);
export const MessageBoardPostInput = Schema.Struct({
  destination: BoardPostDestination,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(BOARD_POST_TEXT_MAX_CHARS)),
  replyToId: Schema.optionalKey(BoardPostId),
  requestKey: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  mode: Schema.optionalKey(Schema.Literals(["request", "note", "reopen-and-send"])),
  expectedRevision: Schema.optionalKey(NonNegativeInt),
});
export const MessageBoardPostResult = Schema.Struct({
  post: BoardPost,
  /** Agents accepted for delivery, including explicit user or parent follow-ups. */
  notifiedThreads: Schema.Array(ThreadId),
});
export type MessageBoardPostResult = typeof MessageBoardPostResult.Type;
export const MessageBoardReactInput = Schema.Struct({
  postId: BoardPostId,
  emoji: BoardReactionEmoji,
  /** False removes your reaction. */
  active: Schema.Boolean,
});
export const MessageBoardMarkReadInput = Schema.Union([
  Schema.Struct({ channelName: BoardChannelName }),
  Schema.Struct({ rootId: BoardPostId }),
]);
export type MessageBoardMarkReadInput = typeof MessageBoardMarkReadInput.Type;

export class MessageBoardError extends Schema.TaggedError<MessageBoardError>()(
  "MessageBoardError",
  {
    code: Schema.Literals(["not_found", "invalid_input", "conflict", "storage", "compatibility"]),
    todoConflict: Schema.optionalKey(
      Schema.Struct({
        kind: Schema.Literals([
          "version",
          "ownership",
          "state",
          "missing",
          "request-key",
          "list_changed",
        ]),
        rootId: BoardPostId,
        todoId: Schema.optionalKey(BoardTodo.fields.id),
        current: Schema.NullOr(BoardTodoItem),
        todosRevision: NonNegativeInt,
      }),
    ),
    message: Schema.String,
    conflict: Schema.optionalKey(
      Schema.Struct({
        kind: Schema.Literals([
          "revision",
          "generation",
          "ownership",
          "closed",
          "unresolved",
          "stopped",
          "stale-context",
          "missing-response",
        ]),
        rootId: BoardPostId,
        revision: NonNegativeInt,
        responsibilityId: Schema.optionalKey(TrimmedNonEmptyString),
      }),
    ),
  },
) {}
