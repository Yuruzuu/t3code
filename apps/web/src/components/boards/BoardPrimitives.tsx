import type { BoardAuthor } from "@t3tools/contracts";
import { boardPersona } from "@t3tools/shared/boardPersona";
import { CornerDownRightIcon, MessagesSquareIcon, UserRoundIcon } from "lucide-react";
import { memo, type ReactNode, type Ref } from "react";

import { useRelativeTimeState } from "~/hooks/useRelativeTimeState";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { ActivityShimmerOverlay } from "../chat/TimelineRowParts";
import { providerClients } from "../settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  BoardOrb,
  BoardWaitingOrb,
  boardAvatarColor,
  boardAvatarSizeClass,
  type BoardOrbSize,
} from "./BoardOrb";
import type { BoardWorker } from "./boardsViewModel";

export function boardAuthorName(author: BoardAuthor) {
  return author.kind === "agent"
    ? boardPersona(author.threadId).name
    : author.kind === "system"
      ? "System"
      : "You";
}

export function BoardAuthorLabel({
  author,
  children,
}: {
  author: BoardAuthor;
  children?: ReactNode;
}) {
  return (
    <span
      style={author.kind === "agent" ? { color: boardAvatarColor(author.threadId) } : undefined}
    >
      {children ?? boardAuthorName(author)}
    </span>
  );
}

export function boardProviderName(author: BoardAuthor) {
  return author.kind === "agent" && author.driver
    ? (providerClients.get(author.driver)?.label ?? "Agent")
    : "Agent";
}

/** Plain-text preview: markdown markers stripped, whitespace collapsed. */
export function boardPostExcerpt(text: string, { includeFirstLine = false } = {}) {
  const lines = text.trim().split("\n");
  return (includeFirstLine ? lines : lines.slice(1))
    .map((line) =>
      line
        .replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s*)?/, "")
        .replace(/^\s*(?:#{1,6}|>)\s*/, ""),
    )
    .join(" ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const BoardAuthorAvatar = memo(function BoardAuthorAvatar({
  author,
  size = "md",
  ring = false,
  working = false,
}: {
  author: BoardAuthor;
  size?: BoardOrbSize;
  ring?: boolean;
  working?: boolean;
}) {
  if (author.kind === "agent")
    return <BoardOrb threadId={author.threadId} size={size} ring={ring} working={working} />;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center text-muted-foreground",
        boardAvatarSizeClass[size],
        ring && "rounded-full bg-background ring-2 ring-background",
      )}
    >
      <span className="inline-flex size-3/4 items-center justify-center rounded-full bg-muted">
        {author.kind === "system" ? (
          <MessagesSquareIcon className="size-4" />
        ) : (
          <UserRoundIcon
            className={
              size === "2xs"
                ? "size-2.5"
                : size === "xs"
                  ? "size-3"
                  : size === "sm"
                    ? "size-4"
                    : "size-4"
            }
          />
        )}
      </span>
    </span>
  );
});

export function BoardTimestamp({ value }: { value: string }) {
  const relative = useRelativeTimeState(value);
  const label =
    relative.status === "relative"
      ? [relative.value, relative.suffix].filter(Boolean).join(" ")
      : value;

  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={value} />}>{label}</TooltipTrigger>
      <TooltipPopup>{new Date(value).toLocaleString()}</TooltipPopup>
    </Tooltip>
  );
}

/** The agent's chosen role, falling back to its provider so every agent has a byline. */
export function boardAuthorRole(author: BoardAuthor) {
  if (author.kind !== "agent") return null;
  return author.role ?? boardProviderName(author);
}

/** "Pip · Reviewer": the agent's chosen role, falling back to its provider. */
export function boardAuthorByline(author: BoardAuthor) {
  const role = boardAuthorRole(author);
  return role === null ? boardAuthorName(author) : `${boardAuthorName(author)} · ${role}`;
}

const MAX_WORKER_CHIPS = 3;

/** Who is working, above the composer; what each is doing shows under the latest message. */
export function BoardWorkingIndicator({
  workers,
  waiting,
  className,
}: {
  workers: readonly BoardWorker[];
  waiting: boolean;
  className?: string;
}) {
  if (workers.length === 0) {
    if (!waiting) return null;
    return (
      <div role="status" className={cn("flex min-w-0 items-center gap-2", className)}>
        <BoardWaitingOrb size="xs" />
        <span className="text-xs text-muted-foreground">Waiting…</span>
      </div>
    );
  }
  const shown = workers.slice(0, MAX_WORKER_CHIPS);
  const label =
    workers.length === 1
      ? `${boardAuthorName(workers[0]!.author)} is working`
      : `${workers.length} agents working`;
  return (
    <div role="status" className={cn("flex min-w-0 items-center gap-2", className)}>
      <span aria-hidden="true" className="flex shrink-0 -space-x-1">
        {shown.map((worker) => (
          <BoardAuthorAvatar
            key={worker.author.threadId}
            author={worker.author}
            size="xs"
            ring
            working
          />
        ))}
      </span>
      <span
        ref={observeVisibleAnimation}
        className="relative min-w-0 overflow-hidden text-xs text-muted-foreground"
      >
        <span className="block truncate">{label}</span>
        <ActivityShimmerOverlay>
          <span className="block truncate">{label}</span>
        </ActivityShimmerOverlay>
      </span>
    </div>
  );
}

/** Each working agent and the latest thing it said, under the latest message. */
export function BoardAgentTrails({
  workers,
  waiting,
  listRef,
}: {
  workers: readonly BoardWorker[];
  /** A responder is still being chosen for your message. */
  waiting: boolean;
  listRef?: Ref<HTMLUListElement>;
}) {
  if (workers.length === 0 && !waiting) return null;
  return (
    <ul ref={listRef} aria-label="Working now" className="mt-4 space-y-3">
      {workers.map((worker) => (
        <li key={worker.author.threadId} className="flex gap-3">
          <BoardAuthorAvatar author={worker.author} working />
          <div className="min-w-0 flex-1">
            <p className="flex min-h-6 items-center truncate text-sm font-semibold text-foreground">
              <BoardAuthorLabel author={worker.author} />
            </p>
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/70">
              <CornerDownRightIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
              <span ref={observeVisibleAnimation} className="relative min-w-0 overflow-hidden">
                <span className="block truncate">{worker.activity}</span>
                <ActivityShimmerOverlay>
                  <span className="block truncate">{worker.activity}</span>
                </ActivityShimmerOverlay>
              </span>
            </p>
          </div>
        </li>
      ))}
      {waiting && (
        <li role="status" className="flex items-center gap-3">
          <BoardWaitingOrb />
          <p className="text-sm font-semibold text-foreground">Waiting…</p>
        </li>
      )}
    </ul>
  );
}

/** How many new messages something has: a blue circle that stretches for longer numbers. */
export function BoardUnreadCount({ count }: { count: number }) {
  return (
    <span
      aria-label={`${count} new ${count === 1 ? "message" : "messages"}`}
      className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-info px-1 text-3xs font-semibold text-white tabular-nums"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function BoardEmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <div className="mb-4 flex size-11 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground">
        <MessagesSquareIcon aria-hidden="true" className="size-5" />
      </div>
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <div className="mt-1.5 max-w-80 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </div>
  );
}

export function BoardLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-6 p-4">
      {["first", "second", "third"].map((key) => (
        <div key={key} aria-hidden="true" className="flex gap-3.5">
          <div className="size-8 shrink-0 rounded-full bg-muted" />
          <div className="flex-1 space-y-2 py-1">
            <div className="h-3 w-2/3 rounded bg-muted" />
            <div className="h-2.5 w-full rounded bg-muted/60" />
            <div className="h-2.5 w-1/3 rounded bg-muted/60" />
          </div>
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}
