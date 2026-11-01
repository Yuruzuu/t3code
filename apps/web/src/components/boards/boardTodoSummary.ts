import type { BoardTodo } from "@t3tools/contracts";

const todoGroups = [
  {
    key: "ready",
    label: "Ready",
    matches: (todo: BoardTodo) => todo.status === "todo" && todo.assignee === null,
  },
  {
    key: "reserved",
    label: "Reserved",
    matches: (todo: BoardTodo) => todo.status === "todo" && todo.assignee !== null,
  },
  { key: "working", label: "Working", matches: (todo: BoardTodo) => todo.status === "in-progress" },
  { key: "blocked", label: "Blocked", matches: (todo: BoardTodo) => todo.status === "blocked" },
  { key: "done", label: "Done", matches: (todo: BoardTodo) => todo.status === "done" },
  {
    key: "cancelled",
    label: "Cancelled",
    matches: (todo: BoardTodo) => todo.status === "cancelled",
  },
] as const;

export function groupBoardTodos(todos: readonly BoardTodo[]) {
  return todoGroups.map(({ key, label, matches }) => ({
    key,
    label,
    items: todos.filter(matches),
  }));
}
