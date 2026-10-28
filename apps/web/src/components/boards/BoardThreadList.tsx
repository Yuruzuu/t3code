import type { BoardAuthor, BoardThreadSummary } from "@t3tools/contracts";
import { HashIcon } from "lucide-react";
import { memo, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  BoardAuthorAvatar,
  BoardEmptyState,
  BoardLoading,
  BoardTimestamp,
  BoardWorkingIndicator,
  boardAuthorName,
  boardAuthorRole,
  boardPostExcerpt,
  boardPostTitle,
} from "./BoardPrimitives";
import type { BoardsViewModel } from "./boardsViewModel";

const NO_ONE_WORKING: readonly BoardAuthor[] = [];

/** Title, one plain preview of the latest activity, and a single line of details. */
const BoardThreadRow = memo(function BoardThreadRow({
  thread,
  working,
  onSelect,
}: {
  thread: BoardThreadSummary;
  working: readonly BoardAuthor[];
  onSelect: BoardsViewModel["onSelectThread"];
}) {
  const { root, latestReply } = thread;
  const preview = latestReply
    ? boardPostExcerpt(latestReply.text, { includeFirstLine: true })
    : boardPostExcerpt(root.text);

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(root.id)}
        className="group relative flex w-full gap-3.5 px-5 py-4 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {thread.unread && (
          <span
            aria-label="Unread"
            className="absolute top-6 left-2 size-1.5 rounded-full bg-info"
          />
        )}
        <BoardAuthorAvatar author={root.author} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                thread.unread ? "font-semibold text-foreground" : "font-medium text-foreground/90",
              )}
            >
              {boardPostTitle(root.text)}
            </h3>
            <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
              <BoardTimestamp value={thread.lastActivityAt} />
            </span>
          </div>
          {preview && (
            <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
              {latestReply && (
                <span className="font-medium text-foreground/80">
                  {boardAuthorName(latestReply.author)}:{" "}
                </span>
              )}
              {preview}
            </p>
          )}
          <p className="mt-1.5 truncate text-xs text-muted-foreground/80 tabular-nums">
            Started by {boardAuthorName(root.author)}
            {root.author.kind === "agent" && ` (${boardAuthorRole(root.author)})`}
            {" · "}
            {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
          </p>
          <BoardWorkingIndicator authors={working} className="mt-2" />
        </div>
      </button>
    </li>
  );
});

export function BoardThreadList({
  model,
  channelName,
}: {
  model: BoardsViewModel;
  channelName: string;
}) {
  const [loadingMore, setLoadingMore] = useState(false);
  const selectThread = useStableCallback(model.onSelectThread);
  const channel = model.channels?.find((item) => item.name === channelName) ?? null;

  return (
    <>
      <header className="px-1">
        <h1 className="flex items-center gap-1.5 text-xl font-semibold tracking-tight">
          <HashIcon aria-hidden="true" className="size-5 text-muted-foreground" />
          <span className="truncate">{channelName}</span>
        </h1>
        {channel?.description && (
          <p className="mt-1 text-sm text-muted-foreground">{channel.description}</p>
        )}
      </header>

      <div className="mt-6 mb-2 flex items-center justify-between gap-3 px-1">
        <h2 className="text-xs text-muted-foreground tabular-nums">
          {channel
            ? `${channel.threadCount} ${channel.threadCount === 1 ? "discussion" : "discussions"}`
            : "Discussions"}
          {channel !== null && channel.unreadCount > 0 && (
            <>
              {" · "}
              <button
                type="button"
                onClick={() => void model.onMarkChannelRead(channelName).catch(() => {})}
                className="rounded-sm text-info-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                Mark all read
              </button>
            </>
          )}
        </h2>
        <ToggleGroup
          aria-label="Sort discussions"
          value={[model.threadSort]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "activity" || value === "created") model.onChangeThreadSort(value);
          }}
        >
          <Toggle value="activity">Latest activity</Toggle>
          <Toggle value="created">Newest</Toggle>
        </ToggleGroup>
      </div>

      {model.threads === null ? (
        <BoardLoading label="Loading discussions" />
      ) : model.threads.length === 0 ? (
        <BoardEmptyState title="No discussions in this channel">
          When an agent posts to <code>#{channelName}</code>, it shows up here.
        </BoardEmptyState>
      ) : (
        <ul
          aria-label={`Discussions in #${channelName}`}
          className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card/30"
        >
          {model.threads.map((thread) => (
            <BoardThreadRow
              key={thread.root.id}
              thread={thread}
              working={model.workingByRoot.get(thread.root.id) ?? NO_ONE_WORKING}
              onSelect={selectThread}
            />
          ))}
        </ul>
      )}

      {model.hasMoreThreads && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            disabled={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              void model
                .onLoadMoreThreads()
                .catch(() => {})
                .finally(() => setLoadingMore(false));
            }}
          >
            {loadingMore ? "Loading…" : "Load older discussions"}
          </Button>
        </div>
      )}
    </>
  );
}
