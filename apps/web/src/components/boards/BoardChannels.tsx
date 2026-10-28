import type { BoardChannel } from "@t3tools/contracts";
import { HashIcon, LayoutGridIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { BoardOrb } from "./BoardOrb";
import {
  BoardAuthorAvatar,
  BoardLoading,
  BoardTimestamp,
  boardAuthorName,
  boardPostExcerpt,
} from "./BoardPrimitives";
import type { BoardsViewModel } from "./boardsViewModel";

function UnreadBadge({ count }: { count: number }) {
  return (
    <Badge size="sm" variant="info" aria-label={`${count} unread posts`}>
      {count > 99 ? "99+" : count}
    </Badge>
  );
}

function ChannelTab({
  selected,
  unread,
  onClick,
  children,
}: {
  selected: boolean;
  unread: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <li className="shrink-0">
      <button
        type="button"
        onClick={onClick}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          selected
            ? "bg-accent font-medium text-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        )}
      >
        {children}
        {unread && <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-info" />}
      </button>
    </li>
  );
}

export function BoardChannelTabs({
  channels,
  selectedChannelName,
  onSelect,
  onShowAll,
  isConnected,
}: Pick<BoardsViewModel, "channels" | "selectedChannelName" | "isConnected"> & {
  onSelect: (name: string) => void;
  onShowAll: () => void;
}) {
  return (
    <div className="mx-auto flex h-14 w-full max-w-3xl shrink-0 items-end gap-2 px-3 @3xl/boards:px-6">
      <ul className="flex shrink-0 items-center">
        <ChannelTab selected={selectedChannelName === null} unread={false} onClick={onShowAll}>
          <LayoutGridIcon aria-hidden="true" className="size-3.5 opacity-70" />
          All channels
        </ChannelTab>
      </ul>
      <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />
      <nav aria-label="Channels" className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
        <ul className="flex items-center gap-0.5">
          {channels?.map((channel) => (
            <ChannelTab
              key={channel.name}
              selected={selectedChannelName === channel.name}
              unread={channel.unreadCount > 0}
              onClick={() => onSelect(channel.name)}
            >
              <HashIcon aria-hidden="true" className="size-3.5 opacity-60" />
              {channel.name}
            </ChannelTab>
          ))}
        </ul>
      </nav>
      {!isConnected && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-2xs text-warning-foreground">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
          Offline
        </span>
      )}
    </div>
  );
}

const BoardChannelRow = memo(function BoardChannelRow({
  channel,
  onSelect,
}: {
  channel: BoardChannel;
  onSelect: (name: string) => void;
}) {
  const unread = channel.unreadCount > 0;
  const latest = channel.latestPost;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(channel.name)}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 px-5 py-4 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @2xl/boards:grid-cols-[minmax(0,1fr)_5rem_4rem_14rem]"
      >
        <span className="flex min-w-0 items-center gap-3.5">
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-xl",
              unread ? "bg-info/12 text-info-foreground" : "bg-muted/70 text-muted-foreground",
            )}
          >
            <HashIcon aria-hidden="true" className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className={cn("truncate text-sm", unread ? "font-semibold" : "font-medium")}>
                {channel.name}
              </span>
              {unread && <UnreadBadge count={channel.unreadCount} />}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {channel.description ?? "No description"}
            </span>
          </span>
        </span>
        <Stat value={channel.threadCount} label="discussions" />
        <Stat value={channel.postCount} label="messages" />
        <span className="hidden min-w-0 items-center gap-2.5 @2xl/boards:flex">
          {latest ? (
            <>
              <BoardAuthorAvatar author={latest.author} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5 text-xs">
                  <span className="truncate font-medium text-foreground/90">
                    {boardAuthorName(latest.author)}
                  </span>
                  <span className="shrink-0 text-muted-foreground/70">
                    <BoardTimestamp value={latest.createdAt} />
                  </span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {boardPostExcerpt(latest.text, { includeFirstLine: true })}
                </span>
              </span>
            </>
          ) : (
            <span className="text-xs text-muted-foreground/70">No messages yet</span>
          )}
        </span>
        <span className="col-span-full mt-2 flex items-center gap-2 pl-12.5 text-xs text-muted-foreground @2xl/boards:hidden">
          {channel.threadCount} {channel.threadCount === 1 ? "discussion" : "discussions"}
          {latest && (
            <>
              {" · "}
              <BoardTimestamp value={latest.createdAt} />
            </>
          )}
        </span>
      </button>
    </li>
  );
});

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <span className="hidden text-center @2xl/boards:block">
      <span className="block text-sm font-medium tabular-nums">{value}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

const ONBOARDING_ORBS = ["board-orb-a", "board-orb-b", "board-orb-c"];

function BoardOnboarding() {
  return (
    <div className="flex flex-col items-center px-6 pt-12 pb-6 text-center">
      <div aria-hidden="true" className="flex -space-x-2">
        {ONBOARDING_ORBS.map((seed) => (
          <BoardOrb key={seed} threadId={seed} size="lg" ring />
        ))}
      </div>
      <h1 className="mt-5 text-xl font-semibold tracking-tight">Your agents' message board</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        Agents open channels and threads here to share findings, split up work, and report results.
        You watch it come together.
      </p>
      <ol className="mt-8 grid w-full max-w-lg gap-2 text-left text-sm @xl/boards:grid-cols-3">
        {[
          ["Send a task", "Use the composer below to start an agent."],
          ["Agents post", "They open channels and discussions as they work."],
          ["Follow along", "New messages show up here live."],
        ].map(([title, body], index) => (
          <li key={title} className="rounded-xl bg-muted/40 px-3.5 py-3">
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

export function BoardChannelIndex({
  channels,
  onSelect,
}: {
  channels: BoardsViewModel["channels"];
  onSelect: (name: string) => void;
}) {
  if (channels === null) return <BoardLoading label="Loading channels" />;
  if (channels.length === 0) return <BoardOnboarding />;
  const messageCount = channels.reduce((total, channel) => total + channel.postCount, 0);

  return (
    <>
      <header className="px-1">
        <h1 className="text-xl font-semibold tracking-tight">Boards</h1>
        <p className="mt-1 text-sm text-muted-foreground tabular-nums">
          {channels.length} {channels.length === 1 ? "channel" : "channels"} · {messageCount}{" "}
          {messageCount === 1 ? "message" : "messages"} from your agents
        </p>
      </header>
      <div className="mt-6 overflow-hidden rounded-xl border border-border/60 bg-card/30">
        <div
          aria-hidden="true"
          className="hidden grid-cols-[minmax(0,1fr)_5rem_4rem_14rem] gap-x-6 border-b border-border/60 px-5 py-2 text-2xs font-medium text-muted-foreground @2xl/boards:grid"
        >
          <span>Channel</span>
          <span className="text-center">Discussions</span>
          <span className="text-center">Messages</span>
          <span>Latest</span>
        </div>
        <ul aria-label="Channels" className="divide-y divide-border/60">
          {channels.map((channel) => (
            <BoardChannelRow key={channel.name} channel={channel} onSelect={onSelect} />
          ))}
        </ul>
      </div>
    </>
  );
}
