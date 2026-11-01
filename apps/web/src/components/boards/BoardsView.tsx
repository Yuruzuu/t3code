import type { ReactNode } from "react";

import { ScrollArea } from "../ui/scroll-area";
import { BoardChannelIndex } from "./BoardChannels";
import { BoardMembers, agentMembers } from "./BoardMembers";
import { BoardTabs } from "./BoardTabs";
import { BoardThreadDetail } from "./BoardThreadDetail";
import { BoardThreadList } from "./BoardThreadList";
import type { BoardsViewModel } from "./boardsViewModel";

export function BoardsView({ model, launcher }: { model: BoardsViewModel; launcher: ReactNode }) {
  const channelName = model.selectedChannelName;
  const thread = model.selectedRootId === null ? null : model.thread;
  const members = thread ? agentMembers(thread.members, model.agentActivity) : [];

  return (
    <section
      aria-label="Boards"
      className="@container/boards flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
    >
      <div className="shrink-0">
        <BoardTabs
          model={model}
          trailing={
            // The discussion panel lists the team once the boards area is wide enough for it.
            members.length > 0 ? (
              <div className="flex shrink-0 items-center gap-1 @5xl/boards:hidden">
                <BoardMembers members={members} onOpenAgentThread={model.onOpenAgentThread} />
              </div>
            ) : null
          }
        />
      </div>
      {model.error && (
        <div
          role="alert"
          className="shrink-0 border-b border-destructive/20 bg-destructive/5 px-6 py-2.5 text-sm text-destructive-foreground"
        >
          {model.error}
        </div>
      )}
      {model.selectedRootId !== null ? (
        <BoardThreadDetail key={model.selectedRootId} model={model} />
      ) : (
        <>
          <div className="min-h-0 flex-1">
            <ScrollArea>
              <div className="mx-auto w-full max-w-3xl px-5 pt-6 pb-10 @3xl/boards:px-8">
                {channelName === null ? (
                  <BoardChannelIndex model={model} />
                ) : (
                  <BoardThreadList key={channelName} model={model} channelName={channelName} />
                )}
              </div>
            </ScrollArea>
          </div>
          {launcher}
        </>
      )}
    </section>
  );
}
