import type { BoardAuthor } from "@t3tools/contracts";
import { boardPersona } from "@t3tools/shared/boardPersona";
import { MessagesSquareIcon, UserRoundIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { useRelativeTimeState } from "~/hooks/useRelativeTimeState";
import { cn } from "~/lib/utils";
import { providerClients } from "../settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BoardOrb, type BoardOrbSize } from "./BoardOrb";

export function boardAuthorName(author: BoardAuthor) {
  return author.kind === "user" ? "You" : boardPersona(author.threadId).name;
}

export function boardProviderName(author: BoardAuthor) {
  return author.kind === "agent" && author.driver
    ? (providerClients.get(author.driver)?.label ?? "Agent")
    : "Agent";
}

export function boardPostTitle(text: string) {
  return (
    text
      .trim()
      .split("\n", 1)[0]
      ?.replace(/^\s*#{1,6}\s*/, "")
      .replace(/[*_`]/g, "")
      .trim() || "Untitled discussion"
  );
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
}: {
  author: BoardAuthor;
  size?: BoardOrbSize;
  ring?: boolean;
}) {
  if (author.kind === "agent")
    return <BoardOrb threadId={author.threadId} size={size} ring={ring} />;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
        size === "xs" ? "size-4" : size === "sm" ? "size-6" : size === "lg" ? "size-10" : "size-8",
        ring && "ring-2 ring-background",
      )}
    >
      <UserRoundIcon className={size === "xs" ? "size-2.5" : size === "sm" ? "size-3" : "size-4"} />
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
  if (author.kind === "user") return null;
  return author.role ?? boardProviderName(author);
}

/** "Working", not "typing": a running agent may be busy with anything, not this reply. */
function workingLabel(authors: readonly BoardAuthor[]) {
  const names = authors.map(boardAuthorName);
  if (names.length === 1) return `${names[0]} is working`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are working`;
  return "Several agents are working";
}

/** Discord-style presence line; static dots, since a looping animation repaints every frame. */
export function BoardWorkingIndicator({
  authors,
  className,
}: {
  authors: readonly BoardAuthor[];
  className?: string;
}) {
  if (authors.length === 0) return null;
  return (
    <span
      role="status"
      className={cn(
        "inline-flex min-w-0 items-center gap-2 text-xs text-muted-foreground",
        className,
      )}
    >
      <span className="flex shrink-0 -space-x-1.5">
        {authors.slice(0, 3).map((author) => (
          <BoardAuthorAvatar
            key={author.kind === "agent" ? author.threadId : "user"}
            author={author}
            size="xs"
            ring
          />
        ))}
      </span>
      <span className="truncate">
        <span className="font-medium text-foreground/80">{workingLabel(authors)}</span>
        <span aria-hidden="true" className="tracking-widest">
          …
        </span>
      </span>
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
