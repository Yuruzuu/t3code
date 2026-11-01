import type { BoardAuthor, BoardPostId, BoardTodo } from "@t3tools/contracts";
import { ArrowLeftIcon, ChevronDownIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { BoardMemberState } from "./BoardMembers";
import {
  BoardAuthorAvatar,
  BoardAuthorLabel,
  boardAuthorName,
  boardAuthorRole,
} from "./BoardPrimitives";
import { BoardTodoGroups } from "./BoardTodos";

/** The discussion's side panel: the team and its todos. */
export function BoardDiscussionPanel({
  lead,
  members,
  todos,
  onOpenAgentThread,
  onJumpTo,
}: {
  /** The agent that started the discussion; its thread is where "Return to thread" goes. */
  lead: Extract<BoardAuthor, { kind: "agent" }> | null;
  members: readonly BoardMemberState[];
  todos: readonly BoardTodo[];
  onOpenAgentThread: (author: BoardAuthor) => void;
  onJumpTo: (postId: BoardPostId) => void;
}) {
  const workingCount = members.filter((member) => member.activity !== null).length;

  return (
    <aside
      aria-label="Discussion details"
      className="pointer-events-none absolute inset-y-0 end-4 z-10 hidden w-80 flex-col py-3 @5xl/boards:flex"
    >
      {/* Each section scrolls on its own past its cap and shrinks when the window is short. */}
      <div className="dropdown-glass pointer-events-auto isolate flex max-h-full flex-col gap-3 overflow-hidden rounded-2xl p-2.5">
        {lead && (
          <Button
            variant="ghost"
            size="xs"
            className="self-start"
            onClick={() => onOpenAgentThread(lead)}
          >
            <ArrowLeftIcon aria-hidden="true" />
            Return to thread
          </Button>
        )}
        <PanelSection
          title="Team"
          meta={
            <>
              {members.length}
              {workingCount > 0 && (
                <span className="text-success-foreground"> · {workingCount} working</span>
              )}
            </>
          }
          fill
        >
          <ScrollArea scrollFade className="max-h-44 min-h-0 flex-auto">
            <ul>
              {members.map(({ member, activity: memberActivity }) =>
                member.author.kind === "agent" ? (
                  <li key={member.author.threadId}>
                    <TeamMemberRow
                      author={member.author}
                      activity={memberActivity}
                      onOpen={onOpenAgentThread}
                    />
                  </li>
                ) : null,
              )}
            </ul>
          </ScrollArea>
        </PanelSection>
        {todos.length > 0 && (
          <PanelSection title="Todos" meta={todos.length} fill>
            <ScrollArea scrollFade className="max-h-64 min-h-0 flex-auto">
              <BoardTodoGroups todos={todos} onJumpTo={onJumpTo} />
            </ScrollArea>
          </PanelSection>
        )}
      </div>
    </aside>
  );
}

function PanelSection({
  title,
  meta,
  fill = false,
  children,
}: {
  title: string;
  meta: ReactNode;
  /** Takes the card's remaining height so its content can scroll. */
  fill?: boolean;
  children: ReactNode;
}) {
  const contentId = useId();
  const [expanded, setExpanded] = useState(true);
  return (
    <section
      aria-label={title}
      className={cn("flex flex-col gap-1", fill ? "min-h-0 flex-auto" : "shrink-0")}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded(!expanded)}
        className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="text-sm font-medium">{title}</span>
        <span className="flex-1 text-xs text-muted-foreground tabular-nums">{meta}</span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn("size-4 text-muted-foreground", !expanded && "-rotate-90")}
        />
      </button>
      <div id={contentId} hidden={!expanded} className="flex min-h-0 flex-auto flex-col">
        {children}
      </div>
    </section>
  );
}

function TeamMemberRow({
  author,
  activity,
  onOpen,
}: {
  author: Extract<BoardAuthor, { kind: "agent" }>;
  activity: string | null;
  onOpen: (author: BoardAuthor) => void;
}) {
  const working = activity !== null;
  const row = (
    <button
      type="button"
      onClick={() => onOpen(author)}
      aria-label={`${boardAuthorName(author)}, ${activity ?? "Idle"}`}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <BoardAuthorAvatar author={author} size="sm" working={working} />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-sm font-medium">
          <BoardAuthorLabel author={author} />
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {boardAuthorRole(author)}
        </span>
      </span>
      {working && (
        <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-success-foreground">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
          Working
        </span>
      )}
    </button>
  );
  if (!working) return row;
  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="left">{activity}</TooltipPopup>
    </Tooltip>
  );
}
