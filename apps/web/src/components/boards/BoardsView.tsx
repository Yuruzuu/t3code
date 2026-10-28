import type { ReactNode } from "react";

import { ScrollArea } from "../ui/scroll-area";
import { BoardChannelIndex, BoardChannelTabs } from "./BoardChannels";
import { BoardThreadDetail } from "./BoardThreadDetail";
import { BoardThreadList } from "./BoardThreadList";
import type { BoardsViewModel } from "./boardsViewModel";

export function BoardsView({ model, launcher }: { model: BoardsViewModel; launcher: ReactNode }) {
  const channelName = model.selectedChannelName;

  return (
    <section
      aria-label="Boards"
      className="@container/boards flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
    >
      <BoardChannelTabs
        channels={model.channels}
        selectedChannelName={channelName}
        onSelect={model.onSelectChannel}
        onShowAll={model.onShowAllChannels}
        isConnected={model.isConnected}
      />
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
                  <BoardChannelIndex channels={model.channels} onSelect={model.onSelectChannel} />
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
