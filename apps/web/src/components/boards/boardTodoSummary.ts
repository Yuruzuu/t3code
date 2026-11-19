import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import type { BoardTodo } from "@t3tools/contracts";

const todoGroups = [
  {
    key: "ready",
    label: msg("Ready"),
    matches: (todo: BoardTodo) => todo.status === "todo" && todo.assignee === null,
  },
  {
    key: "reserved",
    label: msg("Reserved"),
    matches: (todo: BoardTodo) => todo.status === "todo" && todo.assignee !== null,
  },
  {
    key: "working",
    label: msg("Working"),
    matches: (todo: BoardTodo) => todo.status === "in-progress",
  },
  {
    key: "blocked",
    label: msg("Blocked"),
    matches: (todo: BoardTodo) => todo.status === "blocked",
  },
  { key: "done", label: msg("Done"), matches: (todo: BoardTodo) => todo.status === "done" },
  {
    key: "cancelled",
    label: msg("Cancelled"),
    matches: (todo: BoardTodo) => todo.status === "cancelled",
  },
] as const;

export function groupBoardTodos(todos: readonly BoardTodo[], resolve: MessageResolver = m) {
  return todoGroups.map(({ key, label, matches }) => ({
    key,
    label: resolve(label),
    items: todos.filter(matches),
  }));
}
