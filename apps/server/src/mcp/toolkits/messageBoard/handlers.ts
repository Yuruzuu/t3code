import {
  MessageBoardError,
  type BoardChannel,
  type MessageBoardTodosResult,
  type ThreadId,
} from "@t3tools/contracts";
import { boardPersona } from "@t3tools/shared/boardPersona";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as MessageBoardService from "../../../messageBoard/MessageBoardService.ts";
import * as MessageBoardAgentReader from "../../../messageBoard/MessageBoardAgentReader.ts";
import {
  namedAuthor,
  namedPost,
  namedTodo,
} from "../../../messageBoard/MessageBoardAgentReader.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  type BoardTargetInput,
  MessageBoardDestinationError,
  MessageBoardToolkit,
  MessageBoardToolError,
} from "./tools.ts";

const namedChannel = ({
  latestPost: _latestPost,
  recentAuthors: _recentAuthors,
  ...channel
}: BoardChannel) => ({
  ...channel,
  createdBy: namedAuthor(channel.createdBy),
});

const namedTodos = (result: MessageBoardTodosResult) => ({
  ...result,
  todos: result.todos.map(namedTodo),
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

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const isMessageBoardError = Schema.is(MessageBoardError);
const boardFailure = (operation: string) => (cause: unknown) =>
  isMessageBoardError(cause) ? cause : new MessageBoardToolError({ operation, cause });

const make = Effect.gen(function* () {
  const board = yield* MessageBoardService.MessageBoardService;
  const reader = yield* MessageBoardAgentReader.MessageBoardAgentReader;

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
    board_read_handling: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        return yield* board
          .readHandling({ ...input, viewer })
          .pipe(Effect.mapError(boardFailure("readHandling")));
      }),
    ),
    board_assign_lead: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        return yield* board
          .assignLead({ ...input, viewer })
          .pipe(Effect.mapError(boardFailure("assignLead")));
      }),
    ),
    board_update_context: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        return yield* board
          .updateContext({ ...input, viewer })
          .pipe(Effect.mapError(boardFailure("updateContext")));
      }),
    ),
    board_reassign_request: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        return yield* board
          .reassignRequest({ ...input, viewer })
          .pipe(Effect.mapError(boardFailure("reassignRequest")));
      }),
    ),
    board_resume_request: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        return yield* board
          .resumeRequest({ ...input, viewer })
          .pipe(Effect.mapError(boardFailure("resumeRequest")));
      }),
    ),
    board_report_outcome: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        return yield* board
          .reportOutcome({ ...input, viewer })
          .pipe(Effect.mapError(boardFailure("reportOutcome")));
      }),
    ),
    board_close_discussion: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        return yield* board
          .closeDiscussion({ ...input, viewer })
          .pipe(Effect.mapError(boardFailure("closeDiscussion")));
      }),
    ),
    board_reopen_discussion: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        return yield* board
          .reopenDiscussion({ ...input, viewer })
          .pipe(Effect.mapError(boardFailure("reopenDiscussion")));
      }),
    ),
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
            ...(input.mode === undefined ? {} : { mode: input.mode }),
            ...(input.expectedRevision === undefined
              ? {}
              : { expectedRevision: input.expectedRevision }),
            ...(input.request_key === undefined ? {} : { requestKey: input.request_key }),
            ...(input.reply_to === undefined ? {} : { replyToId: input.reply_to }),
          })
          .pipe(Effect.mapError(boardFailure("append")));
        return { post: namedPost(post) };
      }),
    ),
    board_list_threads: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        const result = yield* reader
          .listThreads({
            viewer,
            channelName: input.channel_name,
            sort: input.sort ?? "activity",
            limit: input.limit ?? 20,
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          })
          .pipe(Effect.mapError(boardFailure("listThreads")));
        return result;
      }),
    ),
    board_read_thread: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        return yield* reader
          .readThread({
            viewer,
            rootId: input.thread_id,
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          })
          .pipe(Effect.mapError(boardFailure("readThread")));
      }),
    ),
    board_read_post: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        return yield* reader
          .readPost({
            viewer,
            postId: input.message_id,
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          })
          .pipe(Effect.mapError(boardFailure("readPost")));
      }),
    ),
    board_search_posts: McpToolAccess.readsAsCaller((input) =>
      reader
        .search({
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.channel_name === undefined ? {} : { channelName: input.channel_name }),
          ...(input.thread_id === undefined ? {} : { rootId: input.thread_id }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          limit: input.limit ?? 20,
        })
        .pipe(Effect.mapError(boardFailure("searchPosts"))),
    ),
    board_wait: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        const posts = yield* board
          .waitForPosts({
            viewer,
            rootId: input.thread_id,
            timeoutMs: input.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS,
          })
          .pipe(Effect.mapError(boardFailure("waitForPosts")));
        return {
          posts: posts.map(MessageBoardAgentReader.previewPost),
          timedOut: posts.length === 0,
        };
      }),
    ),
    board_post: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const target = yield* resolveTarget(input);
        const { viewer } = yield* caller();
        const author = yield* board
          .agentAuthor(viewer.threadId)
          .pipe(Effect.mapError(boardFailure("agentAuthor")));
        const result = yield* board
          .postAndNotify({
            author,
            destination:
              target.kind === "channel" ? target : { kind: "reply", rootId: target.rootId },
            text: input.text,
            ...(input.mode === undefined ? {} : { mode: input.mode }),
            ...(input.expectedRevision === undefined
              ? {}
              : { expectedRevision: input.expectedRevision }),
            ...(input.request_key === undefined ? {} : { requestKey: input.request_key }),
            ...(input.reply_to === undefined ? {} : { replyToId: input.reply_to }),
            ...(input.notify_threads === undefined ? {} : { notifyThreads: input.notify_threads }),
          })
          .pipe(Effect.mapError(boardFailure("post")));
        return {
          post: namedPost(result.post),
          notifiedThreads: result.notifiedThreads,
          skippedThreads: result.skippedThreads,
          coalescedThreads: result.coalescedThreads,
          ...(result.notificationFailed
            ? {
                notificationWarning:
                  "Post saved, but subscriber notifications could not be loaded.",
              }
            : {}),
        };
      }),
    ),
    board_react: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        const active = input.remove !== true;
        yield* board
          .react({ viewer, postId: input.message_id, emoji: input.emoji, active })
          .pipe(Effect.mapError(boardFailure("react")));
        return { message_id: input.message_id, emoji: input.emoji, active };
      }),
    ),
    board_read_todos: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        if (input.query.type === "get")
          return yield* board
            .getTodo({ rootId: input.thread_id, todoId: input.query.todoId, viewer })
            .pipe(
              Effect.catchTags({ MessageBoardError: (error) => Effect.succeed({ error }) }),
              Effect.mapError(boardFailure("readTodos")),
            );
        return yield* board
          .listTodos({
            rootId: input.thread_id,
            viewer,
            ...(input.query.filter === undefined ? {} : { filter: input.query.filter }),
            ...(input.query.limit === undefined ? {} : { limit: input.query.limit }),
            ...(input.query.cursor === undefined ? {} : { cursor: input.query.cursor }),
          })
          .pipe(
            Effect.catchTags({ MessageBoardError: (error) => Effect.succeed({ error }) }),
            Effect.mapError(boardFailure("readTodos")),
          );
      }),
    ),
    board_todo_action: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { viewer } = yield* caller();
        return yield* board
          .applyTodoAction({
            rootId: input.thread_id,
            requestKey: input.request_key,
            action: input.action,
            viewer,
          })
          .pipe(
            Effect.catchTags({ MessageBoardError: (error) => Effect.succeed({ error }) }),
            Effect.mapError(boardFailure("todoAction")),
          );
      }),
    ),
    board_create_todo: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        yield* caller();
        return yield* board
          .createTodo({
            rootId: input.thread_id,
            text: input.text,
            ...(input.assignee_thread === undefined
              ? {}
              : { assigneeThreadId: input.assignee_thread }),
          })
          .pipe(Effect.map(namedTodos), Effect.mapError(boardFailure("createTodo")));
      }),
    ),
    board_update_todo: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        yield* caller();
        return yield* board
          .updateTodo({
            rootId: input.thread_id,
            todoId: input.todo_id,
            ...(input.text === undefined ? {} : { text: input.text }),
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.assignee_thread === undefined
              ? {}
              : { assigneeThreadId: input.assignee_thread }),
            ...(input.expected_assignee_thread === undefined
              ? {}
              : { expectedAssigneeThreadId: input.expected_assignee_thread }),
            ...(input.expected_status === undefined
              ? {}
              : { expectedStatus: input.expected_status }),
          })
          .pipe(Effect.map(namedTodos), Effect.mapError(boardFailure("updateTodo")));
      }),
    ),
    board_delete_todo: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        yield* caller();
        return yield* board
          .deleteTodo({ rootId: input.thread_id, todoId: input.todo_id })
          .pipe(Effect.map(namedTodos), Effect.mapError(boardFailure("deleteTodo")));
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
