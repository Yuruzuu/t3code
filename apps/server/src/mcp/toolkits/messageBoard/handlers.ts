import {
  MessageBoardError,
  type BoardAuthor,
  type BoardChannel,
  type BoardPost,
  type BoardThreadSummary,
  type ThreadId,
} from "@t3tools/contracts";
import { boardPersona } from "@t3tools/shared/boardPersona";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as MessageBoardService from "../../../messageBoard/MessageBoardService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import {
  type BoardTargetInput,
  MessageBoardDestinationError,
  MessageBoardToolkit,
  MessageBoardToolError,
} from "./tools.ts";

const namedAuthor = (author: BoardAuthor) =>
  author.kind === "agent" ? { ...author, name: boardPersona(author.threadId).name } : author;

const namedChannel = ({
  latestPost: _latestPost,
  recentAuthors: _recentAuthors,
  ...channel
}: BoardChannel) => ({
  ...channel,
  createdBy: namedAuthor(channel.createdBy),
});

const namedPost = (post: BoardPost) => ({ ...post, author: namedAuthor(post.author) });

const postPreview = (post: BoardPost, maxChars = 1_000) => ({
  ...namedPost(post),
  text: post.text.length > maxChars ? `${post.text.slice(0, maxChars)}…` : post.text,
  textTruncated: post.text.length > maxChars,
});

const threadPreview = (thread: BoardThreadSummary) => ({
  ...thread,
  root: postPreview(thread.root),
  latestReply: thread.latestReply === null ? null : postPreview(thread.latestReply),
  participants: thread.participants.map(namedAuthor),
});

const resolveTarget = Effect.fn("MessageBoardToolkit.resolveTarget")(function* (
  input: typeof BoardTargetInput.Type,
) {
  if ((input.channel_name === undefined) === (input.thread_id === undefined)) {
    return yield* new MessageBoardDestinationError({});
  }
  return input.channel_name !== undefined
    ? { kind: "channel" as const, channelName: input.channel_name }
    : { kind: "thread" as const, rootId: input.thread_id! };
});

const caller = Effect.fn("MessageBoardToolkit.caller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threadScope = yield* McpInvocationContext.requireThreadScope(scope, "Message board");
  return {
    scope: threadScope,
    viewer: { kind: "thread" as const, threadId: threadScope.thread.threadId },
  };
});

const isMessageBoardError = Schema.is(MessageBoardError);
const boardFailure = (operation: string) => (cause: unknown) =>
  isMessageBoardError(cause) ? cause : new MessageBoardToolError({ operation, cause });

const make = Effect.gen(function* () {
  const board = yield* MessageBoardService.MessageBoardService;
  const orchestration = yield* OrchestratorMcpService.OrchestratorMcpService;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  /** The caller, or another agent's thread once it is known to exist. */
  const subscriptionViewer = Effect.fn("MessageBoardToolkit.subscriptionViewer")(function* (
    targetThread: ThreadId | undefined,
  ) {
    const { viewer } = yield* caller();
    if (targetThread === undefined || targetThread === viewer.threadId) return viewer;
    yield* board.agentAuthor(targetThread).pipe(Effect.mapError(boardFailure("agentAuthor")));
    return { kind: "thread" as const, threadId: targetThread };
  });

  return {
    board_set_role: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        yield* board
          .setRole({ threadId: viewer.threadId, role: input.role })
          .pipe(Effect.mapError(boardFailure("setRole")));
        return { role: input.role.trim() || null };
      }),
    ),
    board_get_channels: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        const channels = yield* board
          .listChannels({ viewer, ...(input.query === undefined ? {} : { query: input.query }) })
          .pipe(Effect.mapError(boardFailure("listChannels")));
        return {
          you: { name: boardPersona(viewer.threadId).name, threadId: viewer.threadId },
          channels: channels.slice(0, 100).map(namedChannel),
          channelsOmitted: Math.max(0, channels.length - 100),
        };
      }),
    ),
    board_create_channel: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        const author = yield* board
          .agentAuthor(viewer.threadId)
          .pipe(Effect.mapError(boardFailure("agentAuthor")));
        const channel = yield* board
          .createChannel({
            author,
            name: input.channel_name,
            ...(input.description === undefined ? {} : { description: input.description }),
          })
          .pipe(Effect.mapError(boardFailure("createChannel")));
        if (input.subscribe !== false) {
          yield* board
            .subscribe({ viewer, target: { kind: "channel", channelName: channel.name } })
            .pipe(Effect.mapError(boardFailure("subscribe")));
        }
        return namedChannel(channel);
      }),
    ),
    board_upsert_channel: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        const author = yield* board
          .agentAuthor(viewer.threadId)
          .pipe(Effect.mapError(boardFailure("agentAuthor")));
        const channel = yield* board
          .upsertChannel({ author, name: input.channel_name, description: input.description })
          .pipe(Effect.mapError(boardFailure("upsertChannel")));
        return namedChannel(channel);
      }),
    ),
    board_append: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        const { viewer } = yield* caller();
        const author = yield* board
          .agentAuthor(viewer.threadId)
          .pipe(Effect.mapError(boardFailure("agentAuthor")));
        const post = yield* board
          .post({
            author,
            destination:
              target.kind === "channel" ? target : { kind: "reply", rootId: target.rootId },
            text: input.text,
          })
          .pipe(Effect.mapError(boardFailure("append")));
        return { post: namedPost(post) };
      }),
    ),
    board_list_threads: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        const result = yield* board
          .listThreads({
            viewer,
            channelName: input.channel_name,
            sort: input.sort ?? "activity",
            limit: input.limit ?? 20,
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          })
          .pipe(Effect.mapError(boardFailure("listThreads")));
        return { ...result, threads: result.threads.map(threadPreview) };
      }),
    ),
    board_read_thread: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        const result = yield* board
          .readThread({ viewer, rootId: input.thread_id })
          .pipe(Effect.mapError(boardFailure("readThread")));
        yield* board
          .markRead({ viewer, rootId: result.summary.root.id })
          .pipe(Effect.mapError(boardFailure("markRead")));
        let remaining = 24_000;
        const selected =
          result.posts.length > 50 ? [result.posts[0]!, ...result.posts.slice(-49)] : result.posts;
        const posts = selected.map((post) => {
          const preview = postPreview(post, Math.min(4_000, remaining));
          remaining = Math.max(0, remaining - preview.text.length);
          return preview;
        });
        return {
          summary: { ...threadPreview(result.summary), unread: false },
          members: result.members.map((member) => ({
            ...member,
            author: namedAuthor(member.author),
          })),
          posts,
          postsOmitted: result.posts.length - posts.length,
        };
      }),
    ),
    board_read_post: McpToolAccess.readsAsCaller((input) =>
      board
        .readPost({ postId: input.message_id })
        .pipe(Effect.map(namedPost), Effect.mapError(boardFailure("readPost"))),
    ),
    board_search_posts: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        const posts = yield* board
          .searchPosts({
            viewer,
            ...(input.query === undefined ? {} : { query: input.query }),
            ...(input.channel_name === undefined ? {} : { channelName: input.channel_name }),
            limit: input.limit ?? 20,
          })
          .pipe(Effect.mapError(boardFailure("searchPosts")));
        return { posts: posts.map((post) => postPreview(post)) };
      }),
    ),
    board_post: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        const { scope, viewer } = yield* caller();
        const author = yield* board
          .agentAuthor(viewer.threadId)
          .pipe(Effect.mapError(boardFailure("agentAuthor")));
        const post = yield* board
          .post({
            author,
            destination:
              target.kind === "channel" ? target : { kind: "reply", rootId: target.rootId },
            text: input.text,
          })
          .pipe(Effect.mapError(boardFailure("post")));
        yield* board
          .subscribe({ viewer, target: { kind: "thread", rootId: post.rootId } })
          .pipe(Effect.mapError(boardFailure("subscribe")));
        const subscriptions = yield* board.listSubscribers(target).pipe(Effect.result);
        const subscribers = subscriptions._tag === "Success" ? subscriptions.success : [];
        const explicit = new Set(input.notify_threads ?? []);
        const recipients = new Set([
          ...explicit,
          ...subscribers.flatMap((subscriber) =>
            subscriber.kind === "thread" ? [subscriber.threadId] : [],
          ),
        ]);
        recipients.delete(viewer.threadId);
        const notifiedThreads: Array<ThreadId> = [];
        const skippedThreads: Array<ThreadId> = [];
        const label =
          author.kind === "agent"
            ? `${boardPersona(author.threadId).name} (${author.threadId})`
            : "user";
        const text = post.text.replace(/\s+/g, " ");
        const message = `New post in #${post.channelName} by ${label}: ${text.slice(0, 240)}${text.length > 240 ? "…" : ""}. Read with board_read_thread ${post.rootId}`;
        for (const threadId of recipients) {
          const delivered = yield* Effect.gen(function* () {
            if (!explicit.has(threadId)) {
              const thread = yield* threads.getThreadShell(threadId);
              if (thread === null || thread.activeRunId === null || thread.status !== "running") {
                return false;
              }
            }
            yield* orchestration.sendToThread(scope, {
              threadId,
              message,
              mode: explicit.has(threadId) ? "auto" : "steer",
              clientRequestId: `board:${post.id}:${threadId}`,
            });
            return true;
          }).pipe(Effect.orElseSucceed(() => false));
          (delivered ? notifiedThreads : skippedThreads).push(threadId);
        }
        return {
          post: namedPost(post),
          notifiedThreads,
          skippedThreads,
          ...(subscriptions._tag === "Failure"
            ? {
                notificationWarning:
                  "Post saved, but subscriber notifications could not be loaded.",
              }
            : {}),
        };
      }),
    ),
    board_subscribe: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        const viewer = yield* subscriptionViewer(input.target_thread);
        yield* board.subscribe({ viewer, target }).pipe(Effect.mapError(boardFailure("subscribe")));
        return { subscribed: true, threadId: viewer.threadId };
      }),
    ),
    board_unsubscribe: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        const viewer = yield* subscriptionViewer(input.target_thread);
        yield* board
          .unsubscribe({ viewer, target })
          .pipe(Effect.mapError(boardFailure("unsubscribe")));
        return { subscribed: false, threadId: viewer.threadId };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof MessageBoardToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(MessageBoardToolkit, make);
