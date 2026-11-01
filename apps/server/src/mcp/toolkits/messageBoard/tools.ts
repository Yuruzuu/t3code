import {
  BOARD_ROLE_MAX_CHARS,
  BOARD_POST_TEXT_MAX_CHARS,
  BoardAuthor,
  BoardChannel,
  BoardChannelName,
  BoardPost,
  BoardPostId,
  BoardMember,
  BoardReactionEmoji,
  BoardReaction,
  BoardThreadSort,
  BoardThreadSummary,
  BoardTodo,
  BoardTodoStatus,
  BoardTodoAction,
  MessageBoardTodoActionInput,
  MessageBoardTodoActionResult,
  MessageBoardListTodosInput,
  MessageBoardListTodosResult,
  MessageBoardGetTodoResult,
  MessageBoardTodosResult,
  MessageBoardError,
  MessageBoardPostInput,
  BoardHandlingSnapshot,
  MessageBoardAssignLeadInput,
  MessageBoardUpdateContextInput,
  MessageBoardReassignRequestInput,
  MessageBoardResumeRequestInput,
  MessageBoardReportOutcomeInput,
  MessageBoardCloseDiscussionInput,
  MessageBoardReopenDiscussionInput,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as MessageBoardService from "../../../messageBoard/MessageBoardService.ts";
import * as MessageBoardAgentReader from "../../../messageBoard/MessageBoardAgentReader.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  MessageBoardService.MessageBoardService,
  MessageBoardAgentReader.MessageBoardAgentReader,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProjectionStore.ProjectionStoreV2,
  ProviderRegistry.ProviderRegistry,
];

export class MessageBoardToolError extends Schema.TaggedError<MessageBoardToolError>()(
  "MessageBoardToolError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Message board operation ${this.operation} failed.`;
  }
}

export class MessageBoardDestinationError extends Schema.TaggedError<MessageBoardDestinationError>()(
  "MessageBoardDestinationError",
  {},
) {
  override get message(): string {
    return "Pass exactly one of channel_name or thread_id (a board root post id).";
  }
}

const failure = Schema.Union([
  OrchestratorMcpFailure,
  MessageBoardToolError,
  MessageBoardDestinationError,
  MessageBoardError,
]);

export const BoardTargetInput = Schema.Struct({
  channel_name: Schema.optional(BoardChannelName),
  thread_id: Schema.optional(
    BoardPostId.annotate({ description: "Board root post id, not a T3 thread id." }),
  ),
});

const reply_to = Schema.optional(
  BoardPostId.annotate({
    description: "message_id of the earlier post in this board thread that you are answering.",
  }),
);
const request_key = Schema.optional(
  TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
    description:
      "Unique key for one logical post. Reuse on retries: identical payload returns the original post; changed payload returns conflict.",
  }),
);
const limit = Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })));
const author = Schema.Union([
  BoardAuthor.members[0],
  Schema.Struct({ ...BoardAuthor.members[1].fields, name: Schema.String }),
  BoardAuthor.members[2],
]);
const {
  latestPost: _latestPost,
  recentAuthors: _recentAuthors,
  ...channelFields
} = BoardChannel.fields;
const channel = Schema.Struct({ ...channelFields, createdBy: author });
const post = Schema.Struct({ ...BoardPost.fields, author });
const member = Schema.Struct({ ...BoardMember.fields, author });
const todo = Schema.Struct({ ...BoardTodo.fields, assignee: Schema.NullOr(author) });
const todosResult = Schema.Struct({ ...MessageBoardTodosResult.fields, todos: Schema.Array(todo) });
const preview = Schema.Struct({ ...post.fields, textTruncated: Schema.Boolean });
const continuation = Schema.NullOr(Schema.String);
const postChunk = Schema.Struct({
  ...preview.fields,
  textOffset: Schema.Int,
  textTotalChars: Schema.Int,
  nextCursor: continuation,
});
const summary = Schema.Struct({
  ...BoardThreadSummary.fields,
  root: preview,
  latestReply: Schema.NullOr(preview),
  participants: Schema.Array(author),
});

const GetChannels = Tool.make("board_get_channels", {
  description: "Find this environment's message board channels, with unread counts for you.",
  parameters: Schema.Struct({ query: Schema.optional(TrimmedNonEmptyString) }),
  success: Schema.Struct({
    you: Schema.Struct({ name: Schema.String, threadId: ThreadId }),
    channels: Schema.Array(channel),
    channelsOmitted: Schema.Int,
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CreateChannel = Tool.make("board_create_channel", {
  description: "Create a board channel. Subscribes you unless subscribe is false.",
  parameters: Schema.Struct({
    channel_name: BoardChannelName,
    description: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
    subscribe: Schema.optional(Schema.Boolean),
  }),
  success: channel,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UpsertChannel = Tool.make("board_upsert_channel", {
  description:
    "Create a channel or replace only its description. Keeps posts and subscriptions, subscribes no one, and sends no notifications.",
  parameters: Schema.Struct({
    channel_name: BoardChannelName,
    description: Schema.String.check(Schema.isMaxLength(512)),
  }),
  success: channel,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreads = Tool.make("board_list_threads", {
  description:
    "List discussion previews by activity or creation. Follow nextCursor for a stable snapshot. Read complete text with board_read_thread or board_read_post.",
  parameters: Schema.Struct({
    channel_name: BoardChannelName,
    sort: Schema.optional(BoardThreadSort),
    limit,
    cursor: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({
    threads: Schema.Array(summary),
    nextCursor: Schema.NullOr(Schema.String),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadThread = Tool.make("board_read_thread", {
  description:
    "Read chronological post chunks, then shared todos and members. Follow nextCursor until null. textOffset/textTotalChars locate chunks. Only returned text advances read progress. Cursors freeze posts; restart without one for new arrivals.",
  parameters: Schema.Struct({
    thread_id: BoardPostId,
    cursor: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({
    summary,
    members: Schema.Array(member),
    reactions: Schema.Array(Schema.Struct({ postId: BoardPostId, ...BoardReaction.fields })),
    posts: Schema.Array(postChunk),
    ...todosResult.fields,
    snapshot: Schema.String,
    nextCursor: continuation,
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadPost = Tool.make("board_read_post", {
  description:
    "Read one post in chunks. Follow nextCursor until null; textOffset locates each chunk. Only returned text advances read progress.",
  parameters: Schema.Struct({
    message_id: BoardPostId,
    cursor: Schema.optional(TrimmedNonEmptyString),
  }),
  success: postChunk,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SearchPosts = Tool.make("board_search_posts", {
  description:
    "Search post text, newest first; omit query to browse. Follow nextCursor with the same filters; thread_id scopes a discussion. Previews stay unread. Read full text with board_read_post.",
  parameters: Schema.Struct({
    query: Schema.optional(TrimmedNonEmptyString),
    channel_name: Schema.optional(BoardChannelName),
    thread_id: Schema.optional(BoardPostId),
    cursor: Schema.optional(TrimmedNonEmptyString),
    limit,
  }),
  success: Schema.Struct({ posts: Schema.Array(preview), nextCursor: continuation }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const Wait = Tool.make("board_wait", {
  description:
    "Wait for others' posts in one discussion. Returns your unread ones at once, else the next one, else none on timeout. Read them with board_read_thread before waiting again. Lead with open questions or reviews: wait here instead of ending your turn.",
  parameters: Schema.Struct({
    thread_id: BoardPostId.annotate({ description: "Board root post id, not a T3 thread id." }),
    timeout_ms: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 3_600_000 })).annotate({
        description: "Default 10 minutes.",
      }),
    ),
  }),
  success: Schema.Struct({ posts: Schema.Array(preview), timedOut: Schema.Boolean }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const Post = Tool.make("board_post", {
  description:
    "Post as the calling thread. Use channel_name for a new discussion or thread_id for a reply. Reuse request_key on retries. Tag @Name[thread-id]; plain @Name must be unique. Subscribes you unless opted out. Notices reach only the intended active turn with non-interrupting steering. Addressing your finished delegate resumes it. Subscriber notices coalesce until read.",
  parameters: Schema.Struct({
    ...BoardTargetInput.fields,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(BOARD_POST_TEXT_MAX_CHARS)),
    reply_to,
    request_key,
    mode: MessageBoardPostInput.fields.mode,
    expectedRevision: MessageBoardPostInput.fields.expectedRevision,
    notify_threads: Schema.optional(Schema.Array(ThreadId).check(Schema.isMaxLength(20))),
  }),
  success: Schema.Struct({
    post,
    notifiedThreads: Schema.Array(ThreadId),
    skippedThreads: Schema.Array(ThreadId),
    coalescedThreads: Schema.Array(ThreadId),
    notificationWarning: Schema.optional(Schema.String),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const Append = Tool.make("board_append", {
  description:
    "Store a post silently without subscriptions or notifications. Reuse request_key on retries.",
  parameters: Schema.Struct({
    ...BoardTargetInput.fields,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(BOARD_POST_TEXT_MAX_CHARS)),
    reply_to,
    request_key,
    mode: MessageBoardPostInput.fields.mode,
    expectedRevision: MessageBoardPostInput.fields.expectedRevision,
  }),
  success: Schema.Struct({ post }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const React = Tool.make("board_react", {
  description:
    "React to a board post with one emoji, such as 👍 to acknowledge it without a reply. Notifies no one. remove: true takes it back.",
  parameters: Schema.Struct({
    message_id: BoardPostId,
    emoji: BoardReactionEmoji,
    remove: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({ message_id: BoardPostId, emoji: Schema.String, active: Schema.Boolean }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const todoThread = BoardPostId.annotate({ description: "Board root post id, not a T3 thread id." });
const assigneeThread = ThreadId.annotate({
  description: "Agent T3 thread id. Assignment does not start or notify the agent.",
});
const todoFailureResult = Schema.Struct({ error: MessageBoardError });

const ReadTodos = Tool.make("board_read_todos", {
  description:
    "Read tasks without marking discussion posts read. query.type get reads one todoId; list reads a bounded page. Filters: available is ready todo unassigned or reserved for you; open excludes done/cancelled and includes blocked; mine is owned by you; all includes terminal work. Follow nextCursor; list_changed means restart the list, not an indefinite retry. Read discussion context separately when needed. Domain failures return error.todoConflict with the current item/version or absence.",
  parameters: Schema.Struct({
    thread_id: todoThread,
    query: Schema.Union([
      Schema.Struct({
        type: Schema.Literal("get"),
        todoId: BoardTodo.fields.id,
        filter: Schema.optionalKey(Schema.Never),
        limit: Schema.optionalKey(Schema.Never),
        cursor: Schema.optionalKey(Schema.Never),
      }).annotate({
        parseOptions: { onExcessProperty: "error" },
      }),
      Schema.Struct({
        type: Schema.Literal("list"),
        todoId: Schema.optionalKey(Schema.Never),
        filter: MessageBoardListTodosInput.fields.filter,
        limit: MessageBoardListTodosInput.fields.limit,
        cursor: MessageBoardListTodosInput.fields.cursor,
      }).annotate({ parseOptions: { onExcessProperty: "error" } }),
    ]).annotate({ parseOptions: { onExcessProperty: "error" } }),
  }),
  success: Schema.Union([
    MessageBoardListTodosResult,
    MessageBoardGetTodoResult,
    todoFailureResult,
  ]),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const TodoAction = Tool.make("board_todo_action", {
  description:
    "Apply one versioned todo action quietly: no post, notification, turn, read marker, request outcome, or reviewer agreement. Every action requires a stable request_key; reuse the identical action/key after a lost response. Replays acknowledge historical committed results, not fresh snapshots. Use the task's expectedVersion for all non-create actions. Start/complete/release infer you as worker; another worker's task requires explicit permitted management or override with a reason. Create/reopen directly as blocked with a reason for future work. Todo may be reserved but is not working until start. Blocked retains its reason on release; unblock makes todo and still needs start. Cancel withdrawn work with a reason; remove only accidental/temporary rows. Use the conflict's current task or board_read_todos query get to recover; never overwrite a new owner. Changing a task owner does not transfer filesystem ownership. Domain conflicts return error.todoConflict with cause, current task/version or absence, and list revision.",
  parameters: Schema.Struct({
    thread_id: todoThread,
    request_key: MessageBoardTodoActionInput.fields.requestKey,
    action: BoardTodoAction,
  }),
  success: Schema.Union([MessageBoardTodoActionResult, todoFailureResult]),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CreateTodo = Tool.make("board_create_todo", {
  description:
    "Legacy todo endpoint. Refresh tools and use board_todo_action with request_key and a semantic action; this endpoint returns a compatibility error without changing work.",
  parameters: Schema.Struct({
    thread_id: todoThread,
    text: BoardTodo.fields.text,
    assignee_thread: Schema.optional(assigneeThread),
  }),
  success: todosResult,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const UpdateTodo = Tool.make("board_update_todo", {
  description:
    "Legacy todo endpoint. Refresh tools and use board_todo_action with request_key and expectedVersion; this endpoint returns a compatibility error without changing work.",
  parameters: Schema.Struct({
    thread_id: todoThread,
    todo_id: BoardTodo.fields.id,
    text: Schema.optional(BoardTodo.fields.text),
    status: Schema.optional(BoardTodoStatus),
    assignee_thread: Schema.optional(Schema.NullOr(assigneeThread)),
    expected_assignee_thread: Schema.optional(Schema.NullOr(ThreadId)),
    expected_status: Schema.optional(BoardTodoStatus),
  }),
  success: todosResult,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DeleteTodo = Tool.make("board_delete_todo", {
  description:
    "Legacy todo endpoint. Refresh tools and use board_todo_action remove with request_key, expectedVersion, and reason; this endpoint returns a compatibility error without changing work.",
  parameters: Schema.Struct({ thread_id: todoThread, todo_id: BoardTodo.fields.id }),
  success: todosResult,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const SubscriptionInput = Schema.Struct({
  ...BoardTargetInput.fields,
  target_thread: Schema.optional(
    ThreadId.annotate({ description: "Another agent's T3 thread id. Defaults to you." }),
  ),
});
const subscriptionResult = Schema.Struct({ subscribed: Schema.Boolean, threadId: ThreadId });

const Subscribe = Tool.make("board_subscribe", {
  description:
    "Subscribe yourself or another agent (target_thread) to exactly one board channel_name or thread_id (board root post id).",
  parameters: SubscriptionInput,
  success: subscriptionResult,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const Unsubscribe = Tool.make("board_unsubscribe", {
  description:
    "Unsubscribe yourself or another agent (target_thread) from exactly one board channel_name or thread_id (board root post id).",
  parameters: SubscriptionInput,
  success: subscriptionResult,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SetRole = Tool.make("board_set_role", {
  description:
    "Set your short board role, shown under your name on later posts (e.g. Reviewer, Release captain). Empty clears it.",
  parameters: Schema.Struct({
    role: Schema.String.check(Schema.isMaxLength(BOARD_ROLE_MAX_CHARS)),
  }),
  success: Schema.Struct({ role: Schema.NullOr(Schema.String) }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadHandling = Tool.make("board_read_handling", {
  description:
    "Read current discussion ownership, request generations, outcomes, context and revision before handling or closing work. Seen and agent activity are separate from handling.",
  parameters: Schema.Struct({ rootId: BoardPostId }),
  success: BoardHandlingSnapshot,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AssignLead = Tool.make("board_assign_lead", {
  description:
    "New agent-created discussions already name their creator as lead. To coordinate an existing unassigned discussion, claim it by assigning your own authenticated thread at the inspected revision; do not ask the user to appoint you. The first lead adopts unassigned requests, while existing recipients keep their contributions. An assigned lead can hand coordination over; other agents cannot take it over.",
  parameters: MessageBoardAssignLeadInput,
  success: BoardHandlingSnapshot,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const UpdateContext = Tool.make("board_update_context", {
  description:
    "As lead, maintain optional extra context and decision source post ids using the inspected revision. Request execution already includes the discussion goal, current user corrections, and reply sources; never require the user to fill this field. Re-read after a conflict.",
  parameters: MessageBoardUpdateContextInput,
  success: BoardHandlingSnapshot,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ReassignRequest = Tool.make("board_reassign_request", {
  description:
    "Reassign only one individual request at its inspected generation. This does not change the discussion lead.",
  parameters: MessageBoardReassignRequestInput,
  success: BoardHandlingSnapshot,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ResumeRequest = Tool.make("board_resume_request", {
  description:
    "Resume only the selected held request and generation. Other held requests stay held; Stop remains in effect for unrelated work.",
  parameters: MessageBoardResumeRequestInput,
  success: BoardHandlingSnapshot,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ReportOutcome = Tool.make("board_report_outcome", {
  description:
    "Report an explicit outcome for your own assigned request in its current run and generation. Seen, posting, and finishing a turn do not resolve a request. Cite the source post ids used. A blocked outcome leaves the request unresolved.",
  parameters: MessageBoardReportOutcomeInput,
  success: BoardHandlingSnapshot,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CloseDiscussion = Tool.make("board_close_discussion", {
  description:
    "Close only after inspecting the latest revision and resolving every required contribution, including older gaps. Silence and Seen are not outcomes.",
  parameters: MessageBoardCloseDiscussionInput,
  success: BoardHandlingSnapshot,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ReopenDiscussion = Tool.make("board_reopen_discussion", {
  description: "Reopen the discussion at the inspected revision. Reopening does not override Stop.",
  parameters: MessageBoardReopenDiscussionInput,
  success: BoardHandlingSnapshot,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const MessageBoardToolkit = Toolkit.make(
  ReadHandling,
  AssignLead,
  UpdateContext,
  ReassignRequest,
  ResumeRequest,
  ReportOutcome,
  CloseDiscussion,
  ReopenDiscussion,
  GetChannels,
  CreateChannel,
  UpsertChannel,
  ListThreads,
  ReadThread,
  ReadPost,
  SearchPosts,
  Wait,
  Post,
  Append,
  React,
  Subscribe,
  Unsubscribe,
  SetRole,
  ReadTodos,
  TodoAction,
  CreateTodo,
  UpdateTodo,
  DeleteTodo,
);
