import {
  BOARD_ROLE_MAX_CHARS,
  BOARD_POST_TEXT_MAX_CHARS,
  BoardAuthor,
  BoardChannel,
  BoardChannelName,
  BoardPost,
  BoardPostId,
  BoardMember,
  BoardThreadSort,
  BoardThreadSummary,
  MessageBoardError,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as MessageBoardService from "../../../messageBoard/MessageBoardService.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";

const dependencies = [
  MessageBoardService.MessageBoardService,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  OrchestratorMcpService.OrchestratorMcpService,
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

const limit = Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })));
const author = Schema.Union([
  BoardAuthor.members[0],
  Schema.Struct({ ...BoardAuthor.members[1].fields, name: Schema.String }),
]);
const {
  latestPost: _latestPost,
  recentAuthors: _recentAuthors,
  ...channelFields
} = BoardChannel.fields;
const channel = Schema.Struct({ ...channelFields, createdBy: author });
const post = Schema.Struct({ ...BoardPost.fields, author });
const member = Schema.Struct({ ...BoardMember.fields, author });
const preview = Schema.Struct({ ...post.fields, textTruncated: Schema.Boolean });
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
    "List board threads with short post previews. Sort defaults to activity; use nextCursor for another page and board_read_post for full text.",
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
    "Read a board thread and mark it read for you. Long threads/text are bounded; use board_read_post(message_id) for full post text.",
  parameters: Schema.Struct({ thread_id: BoardPostId }),
  success: Schema.Struct({
    summary,
    members: Schema.Array(member),
    posts: Schema.Array(preview),
    postsOmitted: Schema.Int,
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadPost = Tool.make("board_read_post", {
  description: "Read the full text of one board post by message_id.",
  parameters: Schema.Struct({ message_id: BoardPostId }),
  success: post,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SearchPosts = Tool.make("board_search_posts", {
  description: "Search board posts with short previews. Omit query to browse recent posts.",
  parameters: Schema.Struct({
    query: Schema.optional(TrimmedNonEmptyString),
    channel_name: Schema.optional(BoardChannelName),
    limit,
  }),
  success: Schema.Struct({ posts: Schema.Array(preview) }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const Post = Tool.make("board_post", {
  description:
    "Post as your calling T3 thread. Pass exactly one destination: channel_name for a new board thread, or thread_id for a reply. Subscribes you to that board thread. Subscribers are notified only while running; notify_threads explicitly names T3 threads to send to, including idle ones.",
  parameters: Schema.Struct({
    ...BoardTargetInput.fields,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(BOARD_POST_TEXT_MAX_CHARS)),
    notify_threads: Schema.optional(Schema.Array(ThreadId).check(Schema.isMaxLength(20))),
  }),
  success: Schema.Struct({
    post,
    notifiedThreads: Schema.Array(ThreadId),
    skippedThreads: Schema.Array(ThreadId),
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
    "Store a post silently, like board_post but without subscribing you or notifying anyone, including subscribers. Use for logs and evidence.",
  parameters: Schema.Struct({
    ...BoardTargetInput.fields,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(BOARD_POST_TEXT_MAX_CHARS)),
  }),
  success: Schema.Struct({ post }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
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

export const MessageBoardToolkit = Toolkit.make(
  GetChannels,
  CreateChannel,
  UpsertChannel,
  ListThreads,
  ReadThread,
  ReadPost,
  SearchPosts,
  Post,
  Append,
  Subscribe,
  Unsubscribe,
  SetRole,
);
