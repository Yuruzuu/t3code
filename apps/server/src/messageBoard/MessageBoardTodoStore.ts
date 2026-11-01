import {
  BoardAuthor,
  BoardPostId,
  BoardTodo,
  BoardTodoHistory,
  BoardTodoItem,
  BoardViewer,
  MessageBoardError,
  MessageBoardTodoActionInput,
  MessageBoardTodoActionResult,
  MessageBoardListTodosInput,
  MessageBoardGetTodoInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

const Metadata = Schema.Struct({
  blockerReason: BoardTodo.fields.blockerReason,
  reason: BoardTodo.fields.reason,
  completion: BoardTodo.fields.completion,
});
const TodoRow = Schema.Struct({
  id: BoardTodo.fields.id,
  rootId: BoardPostId,
  text: BoardTodo.fields.text,
  status: BoardTodo.fields.status,
  assignee: Schema.NullOr(Schema.fromJsonString(BoardAuthor)),
  createdAt: BoardTodo.fields.createdAt,
  updatedAt: BoardTodo.fields.updatedAt,
  version: BoardTodo.fields.version,
  metadata: Schema.fromJsonString(Metadata),
  history: Schema.fromJsonString(Schema.Array(BoardTodoHistory)),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(TodoRow));
export const decodeTodoRows = Effect.fn("MessageBoardTodoStore.decodeRows")(function* (
  rows: unknown,
) {
  return (yield* decodeRows(rows)).map(({ metadata, ...row }) => ({ ...row, ...metadata }));
});
export const todoColumns = `t.id,t.root_id AS "rootId",t.text,t.status,t.assignee_json AS assignee,t.created_at AS "createdAt",t.updated_at AS "updatedAt",t.version,t.metadata_json AS metadata,
 COALESCE((SELECT json_group_array(json(entry)) FROM (SELECT json_patch(json_object('actor',json(a.actor_json),'action',a.action,'at',a.created_at,'version',a.version),CASE WHEN a.reason IS NULL THEN '{}' ELSE json_object('reason',substr(a.reason,1,160)) END) AS entry FROM board_todo_actions a WHERE a.root_id=t.root_id AND a.todo_id=t.id AND a.changed=1 ORDER BY a.rowid DESC LIMIT 20)), '[]') AS history`;
const encodeMetadata = Schema.encodeEffect(Schema.fromJsonString(Metadata));
const encodeAuthor = Schema.encodeEffect(Schema.fromJsonString(BoardAuthor));
const encodeActor = Schema.encodeEffect(Schema.fromJsonString(BoardViewer));
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(MessageBoardTodoActionResult));
const decodeResult = Schema.decodeEffect(Schema.fromJsonString(MessageBoardTodoActionResult));
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(MessageBoardTodoActionInput));
const encodeItem = Schema.encodeEffect(Schema.fromJsonString(BoardTodoItem));
const decodeInput = Schema.decodeEffect(MessageBoardTodoActionInput, { onExcessProperty: "error" });
const decodeList = Schema.decodeEffect(MessageBoardListTodosInput);
const decodeGet = Schema.decodeEffect(MessageBoardGetTodoInput);
const Cursor = Schema.Struct({
  rootId: BoardPostId,
  filter: Schema.String,
  actor: Schema.String,
  revision: Schema.Number,
  time: Schema.String,
  id: Schema.String,
});
const decodeCursor = Schema.decodeEffect(Schema.fromJsonString(Cursor));
const encodeCursor = Schema.encodeEffect(Schema.fromJsonString(Cursor));
const invalid = () =>
  new MessageBoardError({
    code: "invalid_input",
    message: "The todo action is invalid. Read the tool schema and correct its fields.",
  });
const compact = ({ assignee, ...todo }: BoardTodo): BoardTodoItem => ({
  ...todo,
  assigneeThreadId: assignee?.kind === "agent" ? assignee.threadId : null,
});
const actorKey = (viewer: BoardViewer) =>
  viewer.kind === "thread" ? `thread:${viewer.threadId}` : "user";

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const columns = sql.literal(todoColumns);
  const revision = Effect.fn("MessageBoardTodoStore.revision")(function* (rootId: BoardPostId) {
    const rows = yield* sql<{
      revision: number;
    }>`SELECT revision FROM board_todo_revisions WHERE root_id=${rootId}`;
    return rows[0]?.revision ?? 0;
  });
  const rootExists = Effect.fn("MessageBoardTodoStore.rootExists")(function* (rootId: BoardPostId) {
    const roots = yield* sql`SELECT 1 FROM board_posts WHERE id=${rootId} AND root_id=${rootId}`;
    if (!roots.length)
      return yield* new MessageBoardError({
        code: "not_found",
        message: "The discussion does not exist.",
      });
  });
  const read = Effect.fn("MessageBoardTodoStore.read")(function* (
    rootId: BoardPostId,
    todoId: string,
  ) {
    return (
      (yield* decodeTodoRows(
        yield* sql`SELECT ${columns} FROM board_todos t WHERE t.root_id=${rootId} AND t.id=${todoId}`,
      ))[0] ?? null
    );
  });
  const snapshot = Effect.fn("MessageBoardTodoStore.snapshot")(function* (rootId: BoardPostId) {
    const rows = yield* sql`SELECT ${columns},COALESCE(r.revision,0) AS revision
      FROM (SELECT 1) seed LEFT JOIN board_todo_revisions r ON r.root_id=${rootId}
      LEFT JOIN board_todos t ON t.root_id=${rootId} ORDER BY t.created_at,t.id`;
    return {
      todos: yield* decodeTodoRows(rows.filter((row) => row.id !== null)),
      todosRevision: Number(rows[0]?.revision ?? 0),
    };
  });
  const conflict = Effect.fn("MessageBoardTodoStore.conflict")(function* (
    rootId: BoardPostId,
    kind: NonNullable<MessageBoardError["todoConflict"]>["kind"],
    current: BoardTodo | null,
    todoId?: string,
  ) {
    return yield* new MessageBoardError({
      code: "conflict",
      message:
        "The todo action conflicts with the current task. Use the current item and version to decide what to do next.",
      todoConflict: {
        kind,
        rootId,
        current: current === null ? null : compact(current),
        todosRevision: yield* revision(rootId),
        ...(todoId === undefined ? {} : { todoId }),
      },
    });
  });
  const author = Effect.fn("MessageBoardTodoStore.author")(function* (threadId: ThreadId) {
    const thread = yield* projections.getThreadShell(threadId);
    if (thread === null || thread.deletedAt !== null) return yield* invalid();
    return {
      kind: "agent" as const,
      threadId,
      projectId: thread.projectId,
      title: thread.title,
      driver: null,
    };
  });
  const apply = Effect.fn("MessageBoardTodoStore.apply")(function* (
    input: typeof MessageBoardTodoActionInput.Type & { viewer: BoardViewer },
  ) {
    const { viewer: _viewer, ...payload } = input;
    const decoded = yield* decodeInput(payload).pipe(Effect.mapError(invalid));
    const { rootId, requestKey, action } = decoded;
    const key = actorKey(input.viewer);
    const fingerprint = yield* encodeInput(decoded);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const receipts = yield* sql<{
          fingerprint: string;
          result_json: string;
        }>`SELECT fingerprint,result_json FROM board_todo_actions WHERE actor_key=${key} AND request_key=${requestKey}`;
        if (receipts[0]) {
          if (receipts[0].fingerprint !== fingerprint)
            return yield* conflict(
              rootId,
              "request-key",
              action.type === "create" ? null : yield* read(rootId, action.todoId),
              action.type === "create" ? undefined : action.todoId,
            );
          return {
            result: { ...(yield* decodeResult(receipts[0].result_json)), replay: true },
            changed: false,
          };
        }
        yield* rootExists(rootId);
        const now = DateTime.formatIso(yield* DateTime.now);
        let current: BoardTodo | null = null;
        let next: BoardTodo;
        if (action.type === "create") {
          if (action.status === "blocked" && !action.reason) return yield* invalid();
          const assignee =
            action.assigneeThreadId == null ? null : yield* author(action.assigneeThreadId);
          next = {
            id: yield* crypto.randomUUIDv4(),
            rootId,
            text: action.text,
            status: action.status ?? "todo",
            assignee,
            version: 1,
            history: [],
            createdAt: now,
            updatedAt: now,
            ...(action.status === "blocked" ? { blockerReason: action.reason! } : {}),
          };
        } else {
          current = yield* read(rootId, action.todoId);
          if (current === null) return yield* conflict(rootId, "missing", null, action.todoId);
          if (current.version !== action.expectedVersion)
            return yield* conflict(rootId, "version", current, action.todoId);
          const owned =
            input.viewer.kind === "thread" &&
            current.assignee?.kind === "agent" &&
            current.assignee.threadId === input.viewer.threadId;
          const nonterminal = current.status !== "done" && current.status !== "cancelled";
          const ownsOrUnassigned = owned || current.assignee === null;
          const permittedOverride =
            "override" in action &&
            action.override === true &&
            "reason" in action &&
            !!action.reason;
          if (
            ["start", "complete", "release"].includes(action.type) &&
            input.viewer.kind !== "thread"
          )
            return yield* conflict(rootId, "ownership", current, current.id);
          if ((action.type === "complete" || action.type === "release") && !owned)
            return yield* conflict(rootId, "ownership", current, current.id);
          if (
            ["edit", "block", "unblock"].includes(action.type) &&
            !ownsOrUnassigned &&
            !permittedOverride
          )
            return yield* conflict(rootId, "ownership", current, current.id);
          next = { ...current, version: current.version + 1, updatedAt: now };
          switch (action.type) {
            case "start":
              if (current.status !== "todo")
                return yield* conflict(rootId, "state", current, current.id);
              if (!ownsOrUnassigned)
                return yield* conflict(rootId, "ownership", current, current.id);
              next = {
                ...next,
                status: "in-progress",
                assignee: yield* author(
                  (input.viewer as Extract<BoardViewer, { kind: "thread" }>).threadId,
                ),
              };
              break;
            case "complete":
              if (current.status !== "in-progress")
                return yield* conflict(rootId, "state", current, current.id);
              if (action.completion && "sourcePostId" in action.completion) {
                const sources =
                  yield* sql`SELECT 1 FROM board_posts WHERE id=${action.completion.sourcePostId} AND root_id=${rootId}`;
                if (!sources.length) return yield* invalid();
              }
              next = {
                ...next,
                status: "done",
                ...(action.completion ? { completion: action.completion } : {}),
              };
              break;
            case "release":
              if (!nonterminal) return yield* conflict(rootId, "state", current, current.id);
              next = {
                ...next,
                status: current.status === "blocked" ? "blocked" : "todo",
                assignee: null,
              };
              break;
            case "edit":
              if (!nonterminal) return yield* conflict(rootId, "state", current, current.id);
              next = { ...next, text: action.text };
              break;
            case "block":
              if (current.status !== "todo" && current.status !== "in-progress")
                return yield* conflict(rootId, "state", current, current.id);
              next = { ...next, status: "blocked", blockerReason: action.reason };
              break;
            case "unblock":
              if (current.status !== "blocked")
                return yield* conflict(rootId, "state", current, current.id);
              {
                const { blockerReason: _blocked, ...rest } = next;
                next = { ...rest, status: "todo" };
              }
              break;
            case "reassign":
              if (!nonterminal) return yield* conflict(rootId, "state", current, current.id);
              next = {
                ...next,
                status: current.status === "blocked" ? "blocked" : "todo",
                assignee:
                  action.assigneeThreadId === null ? null : yield* author(action.assigneeThreadId),
              };
              break;
            case "cancel":
              if (!nonterminal) return yield* conflict(rootId, "state", current, current.id);
              next = { ...next, status: "cancelled", reason: action.reason };
              break;
            case "reopen":
              if (nonterminal) return yield* conflict(rootId, "state", current, current.id);
              {
                const {
                  completion: _completion,
                  blockerReason: _blocked,
                  reason: _reason,
                  ...rest
                } = next;
                next = {
                  ...rest,
                  status: action.status,
                  assignee: null,
                  ...(action.status === "blocked" ? { blockerReason: action.reason } : {}),
                };
              }
              break;
            case "remove":
              break;
          }
        }
        const removed = action.type === "remove";
        const changed =
          current === null ||
          removed ||
          current.text !== next.text ||
          current.status !== next.status ||
          actorOf(current.assignee) !== actorOf(next.assignee) ||
          (yield* encodeMetadata(current)) !== (yield* encodeMetadata(next));
        if (!changed && current !== null) next = current;
        if (changed) {
          if (removed)
            yield* sql`DELETE FROM board_todos WHERE root_id=${rootId} AND id=${next.id}`;
          else
            yield* sql`INSERT INTO board_todos(id,root_id,text,status,assignee_json,created_at,updated_at,version,metadata_json) VALUES(${next.id},${rootId},${next.text},${next.status},${next.assignee === null ? null : yield* encodeAuthor(next.assignee)},${next.createdAt},${next.updatedAt},${next.version},${yield* encodeMetadata(next)}) ON CONFLICT(id) DO UPDATE SET text=excluded.text,status=excluded.status,assignee_json=excluded.assignee_json,updated_at=excluded.updated_at,version=excluded.version,metadata_json=excluded.metadata_json`;
          yield* sql`INSERT INTO board_todo_revisions(root_id,revision) VALUES(${rootId},1) ON CONFLICT(root_id) DO UPDATE SET revision=revision+1`;
        }
        const reason = "reason" in action ? (action.reason ?? null) : null;
        yield* sql`INSERT INTO board_todo_actions(actor_key,request_key,fingerprint,root_id,todo_id,actor_json,action,reason,created_at,version,changed,result_json) VALUES(${key},${requestKey},${fingerprint},${rootId},${next.id},${yield* encodeActor(input.viewer)},${action.type},${reason},${now},${next.version},${changed ? 1 : 0},'{}')`;
        const item = removed ? null : compact((yield* read(rootId, next.id))!);
        const result = {
          item,
          todoId: next.id,
          version: next.version,
          todosRevision: yield* revision(rootId),
          replay: false,
          removed,
        };
        yield* sql`UPDATE board_todo_actions SET result_json=${yield* encodeResult(result)} WHERE actor_key=${key} AND request_key=${requestKey}`;
        return { result, changed };
      }),
    );
  });
  const list = Effect.fn("MessageBoardTodoStore.list")(function* (
    input: typeof MessageBoardListTodosInput.Type & { viewer: BoardViewer },
  ) {
    const decoded = yield* decodeList(input).pipe(Effect.mapError(invalid));
    const filter = decoded.filter ?? "open";
    const key = actorKey(input.viewer);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* rootExists(decoded.rootId);
        const currentRevision = yield* revision(decoded.rootId);
        const cursor =
          decoded.cursor === undefined
            ? null
            : yield* decodeCursor(decoded.cursor).pipe(Effect.mapError(invalid));
        if (
          cursor &&
          (cursor.rootId !== decoded.rootId || cursor.filter !== filter || cursor.actor !== key)
        )
          return yield* invalid();
        if (cursor && cursor.revision !== currentRevision)
          return yield* conflict(decoded.rootId, "list_changed", null);
        const threadId = input.viewer.kind === "thread" ? input.viewer.threadId : null;
        const owner = sql`json_extract(t.assignee_json,'$.threadId')`;
        const selected =
          filter === "available"
            ? sql`t.status='todo' AND (t.assignee_json IS NULL OR ${owner}=${threadId})`
            : filter === "mine"
              ? sql`${owner}=${threadId}`
              : filter === "open"
                ? sql`t.status NOT IN ('done','cancelled')`
                : sql`1`;
        const limit = decoded.limit ?? 20;
        const rows = yield* decodeTodoRows(
          yield* sql`SELECT ${columns} FROM board_todos t WHERE t.root_id=${decoded.rootId} AND (${selected}) AND ${cursor === null ? sql`1` : sql`(t.created_at>${cursor.time} OR (t.created_at=${cursor.time} AND t.id>${cursor.id}))`} ORDER BY t.created_at,t.id LIMIT ${limit + 1}`,
        );
        const items: BoardTodoItem[] = [];
        let bytes = 0;
        for (const row of rows.slice(0, limit)) {
          const item = compact(row);
          const size = new TextEncoder().encode(yield* encodeItem(item)).length;
          if (bytes + size > 20_000 && items.length > 0) break;
          items.push(item);
          bytes += size;
        }
        const last = items.at(-1);
        const nextCursor =
          last !== undefined && rows.length > items.length
            ? yield* encodeCursor({
                rootId: decoded.rootId,
                filter,
                actor: key,
                revision: currentRevision,
                time: last.createdAt,
                id: last.id,
              })
            : null;
        return { items, todosRevision: currentRevision, nextCursor };
      }),
    );
  });
  const get = Effect.fn("MessageBoardTodoStore.get")(function* (
    input: typeof MessageBoardGetTodoInput.Type & { viewer: BoardViewer },
  ) {
    const decoded = yield* decodeGet(input).pipe(Effect.mapError(invalid));
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* rootExists(decoded.rootId);
        const item = yield* read(decoded.rootId, decoded.todoId);
        return {
          item: item === null ? null : compact(item),
          todosRevision: yield* revision(decoded.rootId),
        };
      }),
    );
  });
  return { snapshot, apply, list, get };
});
function actorOf(author: BoardAuthor | null) {
  return author?.kind === "agent" ? author.threadId : (author?.kind ?? null);
}
