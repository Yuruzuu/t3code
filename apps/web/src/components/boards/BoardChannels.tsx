import { useAtomValue } from "@effect/atom-react";
import type { BoardChannel, BoardThreadSummary } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import { memo } from "react";
import { Atom } from "effect/reactivity";

import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { BoardOrb } from "./BoardOrb";
import {
  BoardAuthorAvatar,
  BoardAuthorLabel,
  BoardEmptyState,
  BoardLoading,
  BoardTimestamp,
  BoardUnreadCount,
  boardPostExcerpt,
} from "./BoardPrimitives";
import { boardMainPostContent } from "./boardDiscussion";
import { messageBoardAtoms } from "./boardState";
import type { BoardsViewModel } from "./boardsViewModel";

/** The most recent discussions a channel shows here; the rest are a click away on its own page. */
const CATEGORY_THREAD_LIMIT = 5;
const CATEGORY_ROW_CLASS = "h-14";
const emptyPage = Atom.make(null);

const BoardCategoryThreadRow = memo(function BoardCategoryThreadRow({
  thread,
  onSelect,
}: {
  thread: BoardThreadSummary;
  onSelect: (thread: BoardThreadSummary) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { root, latestReply } = thread;
  const { title, description } = boardMainPostContent(root, m);
  const preview = boardPostExcerpt(latestReply?.text ?? description, { includeFirstLine: true });

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(thread)}
        className={cn(
          "relative flex w-full items-center gap-3 px-4 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          CATEGORY_ROW_CLASS,
        )}
      >
        {thread.unread && (
          <span
            aria-label={gt("Unread")}
            className="absolute top-1/2 left-1.5 size-1.5 -translate-y-1/2 rounded-full bg-info"
          />
        )}
        <BoardAuthorAvatar author={root.author} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                thread.unread ? "font-semibold text-foreground" : "font-medium text-foreground/90",
              )}
            >
              {title}
            </span>
            <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
              <BoardTimestamp value={thread.lastActivityAt} />
            </span>
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {latestReply && (
              <span className="font-medium">
                <BoardAuthorLabel author={latestReply.author} />:{" "}
              </span>
            )}
            {preview || "\u00a0"}
          </span>
        </span>
      </button>
    </li>
  );
});

/** Mounted only while its category is open, so collapsed channels load nothing. */
function BoardCategoryThreads({
  channel,
  model,
}: {
  channel: BoardChannel;
  model: BoardsViewModel;
}) {
  const gt = useGT();
  const { environmentId } = model;
  const page = useAtomValue(
    environmentId === null
      ? emptyPage
      : messageBoardAtoms.threads(environmentId, channel.name, "activity"),
  );
  const selectThread = useStableCallback((thread: BoardThreadSummary) =>
    model.onSelectThread(thread.root.id, channel.name),
  );
  const listClass =
    "mt-1.5 divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card/30";

  if (channel.threadCount === 0)
    return (
      <p className="mt-1 px-7 text-xs text-muted-foreground">
        <T>No discussions yet</T>
      </p>
    );
  // Placeholders match the rows to come, so loading channels don't push the others around.
  if (page === null)
    return (
      <ul aria-hidden="true" className={listClass}>
        {Array.from(
          { length: Math.min(channel.threadCount, CATEGORY_THREAD_LIMIT) },
          (_, index) => (
            <li key={index} className={cn("flex items-center gap-3 px-4", CATEGORY_ROW_CLASS)}>
              <span className="size-7 shrink-0 rounded-full bg-muted" />
              <span className="flex-1 space-y-1.5">
                <span className="block h-2.5 w-1/2 rounded bg-muted" />
                <span className="block h-2 w-3/4 rounded bg-muted/60" />
              </span>
            </li>
          ),
        )}
      </ul>
    );
  return (
    <ul
      aria-label={gt("Discussions in {channel}", { channel: channel.name })}
      className={listClass}
    >
      {page.threads.slice(0, CATEGORY_THREAD_LIMIT).map((thread) => (
        <BoardCategoryThreadRow key={thread.root.id} thread={thread} onSelect={selectThread} />
      ))}
    </ul>
  );
}

function BoardChannelCategory({
  channel,
  model,
}: {
  channel: BoardChannel;
  model: BoardsViewModel;
}) {
  const gt = useGT();
  const collapsed = model.collapsedChannels.includes(channel.name);
  return (
    <section aria-label={channel.name}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => model.onToggleChannel(channel.name)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pr-2 pl-1 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={cn("size-4 shrink-0 text-muted-foreground", collapsed && "-rotate-90")}
          />
          <span className="shrink-0 text-sm font-semibold">{channel.name}</span>
          {channel.unreadCount > 0 && <BoardUnreadCount count={channel.unreadCount} />}
          {channel.description && (
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {channel.description}
            </span>
          )}
        </button>
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0"
          onClick={() => model.onSelectChannel(channel.name)}
        >
          {channel.threadCount > CATEGORY_THREAD_LIMIT
            ? gt("View all {count}", { count: channel.threadCount })
            : gt("View channel")}
        </Button>
      </div>
      {!collapsed && <BoardCategoryThreads channel={channel} model={model} />}
    </section>
  );
}

const ONBOARDING_ORBS = ["board-orb-a", "board-orb-b", "board-orb-c"];

function BoardOnboarding() {
  const gt = useGT();
  return (
    <div className="flex flex-col items-center px-6 pt-12 pb-6 text-center">
      <div aria-hidden="true" className="flex -space-x-2">
        {ONBOARDING_ORBS.map((seed) => (
          <BoardOrb key={seed} threadId={seed} size="lg" ring />
        ))}
      </div>
      <h1 className="mt-5 text-xl font-semibold tracking-tight">
        <T>Your agents' message board</T>
      </h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        <T>
          Agents open channels and threads here to share findings, split up work, and report
          results. You watch it come together.
        </T>
      </p>
      <ol className="mt-8 grid w-full max-w-lg gap-2 text-left text-sm @xl/boards:grid-cols-3">
        {[
          [
            "ask",
            gt("Ask your agents"),
            gt("Tell agents in any thread to coordinate on the board."),
          ],
          ["post", gt("Agents post"), gt("They open channels and discussions as they work.")],
          ["follow", gt("Follow along"), gt("New messages show up here live.")],
        ].map(([id, title, body], index) => (
          <li key={id} className="rounded-xl bg-muted/40 px-3.5 py-3">
            <span className="text-2xs font-medium text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <span className="mt-0.5 block font-medium">{title}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              {body}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function BoardChannelIndex({ model }: { model: BoardsViewModel }) {
  const gt = useGT();
  const { channels, isConnected } = model;
  if (channels === null)
    return isConnected ? (
      <BoardLoading label={gt("Loading channels")} />
    ) : (
      <BoardEmptyState title={gt("You're offline")}>
        <T>Channels load when the connection comes back.</T>
      </BoardEmptyState>
    );
  if (channels.length === 0) return <BoardOnboarding />;
  const messageCount = channels.reduce((total, channel) => total + channel.postCount, 0);

  return (
    <>
      <header className="px-1">
        <h1 className="text-xl font-semibold tracking-tight">
          <T>Boards</T>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground tabular-nums">
          {gt(
            "{channelCount, plural, one {{channelCount} channel} other {{channelCount} channels}} · {messageCount, plural, one {{messageCount} message} other {{messageCount} messages}} from your agents",
            {
              channelCount: channels.length,
              messageCount,
            },
          )}
        </p>
      </header>
      <div className="mt-6 space-y-5">
        {channels.map((channel) => (
          <BoardChannelCategory key={channel.name} channel={channel} model={model} />
        ))}
      </div>
    </>
  );
}
