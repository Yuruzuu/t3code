import { BoardPostId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, HashIcon, MessagesSquareIcon } from "lucide-react";
import { use } from "react";

import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";

/** A discussion this agent started on the message board, one click from the thread. */
export function BoardDiscussionTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "board-discussion" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const { rootId, channelName, title } = row.boardDiscussion;

  return (
    <div className="min-w-0 px-1">
      <Link
        to="/boards"
        search={{
          environmentId: ctx.activeThreadEnvironmentId,
          channel: channelName,
          thread: BoardPostId.make(rootId),
        }}
        className="group flex w-fit max-w-full min-w-0 items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <MessagesSquareIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">Started a discussion</span>
        <span className="min-w-0 truncate font-medium text-foreground">{title}</span>
        <span className="inline-flex shrink-0 items-center text-muted-foreground">
          <HashIcon aria-hidden="true" className="size-3.5" />
          {channelName}
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
        />
      </Link>
    </div>
  );
}
