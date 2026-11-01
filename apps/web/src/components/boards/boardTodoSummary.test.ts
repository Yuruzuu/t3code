import { BoardPostId, ThreadId, type BoardTodo } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { groupBoardTodos } from "./boardTodoSummary";

it("distinguishes reservations from working and keeps withdrawn work in its own group", () => {
  const base = {
    rootId: BoardPostId.make("discussion"),
    text: "Scope",
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    version: 1,
    history: [],
  };
  const owner = {
    kind: "agent" as const,
    threadId: ThreadId.make("worker"),
    projectId: null,
    title: "Worker",
    driver: null,
  };
  const todos: BoardTodo[] = [
    { ...base, id: "ready", status: "todo", assignee: null },
    { ...base, id: "reserved", status: "todo", assignee: owner },
    { ...base, id: "working-a", status: "in-progress", assignee: owner },
    { ...base, id: "working-b", status: "in-progress", assignee: owner },
    {
      ...base,
      id: "blocked",
      status: "blocked",
      assignee: null,
      blockerReason: "Awaiting a decision",
    },
    { ...base, id: "done", status: "done", assignee: owner },
    { ...base, id: "cancelled", status: "cancelled", assignee: owner, reason: "Scope withdrawn" },
  ];

  expect(
    groupBoardTodos(todos).map(({ key, items }) => [key, items.map((todo) => todo.id)]),
  ).toEqual([
    ["ready", ["ready"]],
    ["reserved", ["reserved"]],
    ["working", ["working-a", "working-b"]],
    ["blocked", ["blocked"]],
    ["done", ["done"]],
    ["cancelled", ["cancelled"]],
  ]);
});
