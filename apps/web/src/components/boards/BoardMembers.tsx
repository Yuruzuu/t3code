import type { BoardMember } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { BoardAuthorAvatar, boardAuthorName, boardAuthorRole } from "./BoardPrimitives";
import type { BoardsViewModel } from "./boardsViewModel";

export interface BoardMemberState {
  member: BoardMember;
  working: boolean;
}

/** Agent members with live status, working ones first (server order is kept within groups). */
export function agentMembers(
  members: readonly BoardMember[],
  isAgentThreadRunning: BoardsViewModel["isAgentThreadRunning"],
): BoardMemberState[] {
  return members
    .flatMap((member) =>
      member.author.kind === "agent"
        ? [{ member, working: isAgentThreadRunning(member.author.threadId) }]
        : [],
    )
    .sort((left, right) => Number(right.working) - Number(left.working));
}

const BoardMemberRow = memo(function BoardMemberRow({
  member,
  working,
  onOpenAgentThread,
}: BoardMemberState & { onOpenAgentThread: BoardsViewModel["onOpenAgentThread"] }) {
  const { author } = member;
  if (author.kind !== "agent") return null;
  const details = [
    member.postCount > 0
      ? `${member.postCount} ${member.postCount === 1 ? "message" : "messages"}`
      : null,
    member.subscribed ? "subscribed" : null,
  ].filter(Boolean);

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpenAgentThread(author)}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <BoardAuthorAvatar author={author} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm">
            <span className="font-medium">{boardAuthorName(author)}</span>
            <span className="truncate text-xs text-muted-foreground">
              ({boardAuthorRole(author)})
            </span>
            <span
              className={cn(
                "text-2xs",
                working ? "text-success-foreground" : "text-muted-foreground",
              )}
            >
              {working ? "Working" : "Idle"}
            </span>
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {author.title || "Untitled thread"}
          </span>
          <span className="block truncate text-2xs text-muted-foreground/70">
            {details.join(" · ")}
          </span>
        </span>
      </button>
    </li>
  );
});

/** A compact orb stack; the popover holds the per-agent details. */
export function BoardMembers({
  members,
  onOpenAgentThread,
}: {
  members: readonly BoardMemberState[];
  onOpenAgentThread: BoardsViewModel["onOpenAgentThread"];
}) {
  const workingCount = members.filter((member) => member.working).length;
  const label = `${members.length} ${members.length === 1 ? "agent" : "agents"}${
    workingCount > 0 ? `, ${workingCount} working` : ""
  }`;

  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Members: ${label}`}
        render={
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-0.5 text-xs text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        }
      >
        <span className="flex -space-x-1.5">
          {members.slice(0, 4).map(({ member }) => (
            <BoardAuthorAvatar
              key={member.author.kind === "agent" ? member.author.threadId : "user"}
              author={member.author}
              size="xs"
              ring
            />
          ))}
        </span>
        {workingCount > 0 && (
          <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
        )}
        {label}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-72">
        <ul aria-label="Members">
          {members.map((state) => (
            <BoardMemberRow
              key={state.member.author.kind === "agent" ? state.member.author.threadId : "user"}
              {...state}
              onOpenAgentThread={onOpenAgentThread}
            />
          ))}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}
