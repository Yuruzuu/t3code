import { createFileRoute } from "@tanstack/react-router";
import type { BoardPostId, EnvironmentId } from "@t3tools/contracts";

import { BoardsView } from "../components/boards/BoardsView";
import { useBoardsViewModel } from "../components/boards/useBoardsViewModel";

export interface BoardsSearch {
  channel?: string | undefined;
  thread?: BoardPostId | undefined;
  boardSort?: "activity" | "created" | undefined;
  environmentId?: EnvironmentId;
}

export const Route = createFileRoute("/_chat/boards")({
  validateSearch: (raw: Record<string, unknown>): BoardsSearch => ({
    ...(typeof raw.channel === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.channel)
      ? { channel: raw.channel }
      : {}),
    ...(typeof raw.thread === "string" && raw.thread ? { thread: raw.thread as BoardPostId } : {}),
    ...(raw.boardSort === "created" ? { boardSort: "created" } : {}),
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
  }),
  component: BoardsPage,
});

function BoardsPage() {
  return <BoardsView model={useBoardsViewModel()} launcher={null} />;
}
