import type { BoardPostId, BoardTodo } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CirclePauseIcon,
  CircleXIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { cn } from "~/lib/utils";
import { BoardAuthorAvatar, BoardAuthorLabel } from "./BoardPrimitives";
import { groupBoardTodos } from "./boardTodoSummary";

type TodoProps = {
  todos: readonly BoardTodo[];
  onJumpTo: (postId: BoardPostId) => void;
};

const statusLabels = {
  todo: "Ready",
  "in-progress": "Working",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

function TodoStatusIcon({ status }: { status: BoardTodo["status"] }) {
  const className = "size-3.5 shrink-0";
  if (status === "done") {
    return <CircleCheckIcon aria-hidden="true" className={cn(className, "text-success")} />;
  }
  if (status === "in-progress") {
    return <CircleDotIcon aria-hidden="true" className={cn(className, "text-info")} />;
  }
  if (status === "blocked") {
    return <CirclePauseIcon aria-hidden="true" className={cn(className, "text-warning")} />;
  }
  if (status === "cancelled") {
    return <CircleXIcon aria-hidden="true" className={cn(className, "text-muted-foreground")} />;
  }
  return <CircleIcon aria-hidden="true" className={cn(className, "text-muted-foreground/60")} />;
}

export function BoardTodos({ todos, onJumpTo }: TodoProps) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);

  return (
    <section aria-label="Discussion todos" className="mb-2 rounded-xl border border-border/60">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-muted-foreground outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="shrink-0 font-medium text-foreground">Todos</span>
        <span className="min-w-0 flex-1 leading-4 tabular-nums">{todos.length}</span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn("size-3.5 shrink-0", !expanded && "-rotate-90")}
        />
      </button>
      <div
        id={panelId}
        hidden={!expanded}
        className="max-h-64 overflow-y-auto border-t border-border/60 px-1.5 py-1"
      >
        {todos.length === 0 ? (
          <p className="px-1.5 py-1.5 text-xs text-muted-foreground">
            Agents add scoped work here.
          </p>
        ) : (
          <BoardTodoGroups todos={todos} onJumpTo={onJumpTo} />
        )}
      </div>
    </section>
  );
}

export function BoardTodoGroups({ todos, onJumpTo }: TodoProps) {
  return groupBoardTodos(todos).map((group) => {
    if (group.items.length === 0) return null;
    return (
      <section key={group.key} aria-label={`${group.label} todos`} className="py-1">
        <h4 className="px-1.5 py-1 text-2xs font-medium text-muted-foreground">
          {group.label} <span className="tabular-nums opacity-70">{group.items.length}</span>
        </h4>
        <ul>
          {group.items.map((todo) => (
            <TodoRow key={todo.id} todo={todo} onJumpTo={onJumpTo} />
          ))}
        </ul>
      </section>
    );
  });
}

function TodoRow({ todo, onJumpTo }: { todo: BoardTodo; onJumpTo: TodoProps["onJumpTo"] }) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const terminal = todo.status === "done" || todo.status === "cancelled";
  const reason =
    todo.status === "blocked"
      ? todo.blockerReason
      : todo.status === "cancelled"
        ? todo.reason
        : undefined;

  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex h-4 items-center">
          <TodoStatusIcon status={todo.status} />
          <span className="sr-only">
            {todo.status === "todo" && todo.assignee ? "Reserved" : statusLabels[todo.status]}:{" "}
          </span>
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 leading-4",
            expanded ? "wrap-anywhere" : "line-clamp-2 wrap-anywhere",
            terminal
              ? "text-muted-foreground line-through decoration-muted-foreground/50"
              : "text-foreground",
          )}
        >
          {todo.text}
        </span>
        {todo.assignee && (
          <span className="flex h-4 max-w-24 shrink-0 items-center gap-1 text-2xs text-muted-foreground">
            <BoardAuthorAvatar author={todo.assignee} size="2xs" />
            <span className="truncate">
              <BoardAuthorLabel author={todo.assignee} />
            </span>
          </span>
        )}
      </button>
      {reason && <p className="wrap-anywhere px-7 pb-1 text-2xs text-muted-foreground">{reason}</p>}
      <div
        id={detailsId}
        hidden={!expanded}
        className="space-y-1 px-7 pb-1 text-2xs text-muted-foreground"
      >
        {todo.reason && todo.reason !== reason && <p className="wrap-anywhere">{todo.reason}</p>}
        {todo.completion &&
          ("text" in todo.completion ? (
            <p className="whitespace-pre-wrap wrap-anywhere">{todo.completion.text}</p>
          ) : (
            <a
              href={`#board-post-${todo.completion.sourcePostId}`}
              className="text-primary underline underline-offset-2"
              onClick={(event) => {
                event.preventDefault();
                if (todo.completion && "sourcePostId" in todo.completion)
                  onJumpTo(todo.completion.sourcePostId);
              }}
            >
              View completion post
            </a>
          ))}
      </div>
    </li>
  );
}
