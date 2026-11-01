import type { BoardThreadSummary, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";

import { useRelativeTimeState } from "~/hooks/useRelativeTimeState";
import { useEnvironmentQuery } from "../../state/query";
import { boardMainPostContent } from "../boards/boardDiscussion";
import { messageBoardAtoms } from "../boards/boardState";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const VISIBLE_DISCUSSIONS = 5;

export function ThreadBoardsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const query = useEnvironmentQuery(
    messageBoardAtoms.agentThreads(props.environmentId, props.threadId),
  );
  const discussions = query.data ?? [];

  if (query.error === null && discussions.length === 0) return null;

  const open = (summary: BoardThreadSummary | null) =>
    void navigate({
      to: "/boards",
      search: {
        environmentId: props.environmentId,
        ...(summary ? { channel: summary.root.channelName, thread: summary.root.id } : {}),
      },
    });

  return (
    <ThreadDetailsSection
      headingId="thread-details-boards-heading"
      title="Boards"
      data-thread-boards-panel
      actions={
        discussions.length > VISIBLE_DISCUSSIONS ? (
          <ThreadDetailsControl part="meta" onClick={() => open(null)}>
            View all
          </ThreadDetailsControl>
        ) : null
      }
    >
      {query.error !== null ? (
        <p className="px-2.5 py-1.5 text-2xs text-destructive">
          Could not load board discussions: {query.error}
        </p>
      ) : null}

      <div className="flex flex-col">
        {discussions.slice(0, VISIBLE_DISCUSSIONS).map((summary) => (
          <ThreadDetailsControl
            key={summary.root.id}
            multiline
            onClick={() => open(summary)}
            aria-label={`Open discussion ${boardMainPostContent(summary.root).title}`}
          >
            <MessagesSquareIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{boardMainPostContent(summary.root).title}</span>
              <DiscussionMeta summary={summary} />
            </span>
            {summary.unread ? (
              <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />
            ) : null}
          </ThreadDetailsControl>
        ))}
      </div>
    </ThreadDetailsSection>
  );
}

function DiscussionMeta({ summary }: { summary: BoardThreadSummary }) {
  const relative = useRelativeTimeState(summary.lastActivityAt);
  const replies =
    summary.replyCount === 1 ? "1 reply" : `${summary.replyCount.toLocaleString()} replies`;
  const when =
    relative.status === "relative"
      ? [relative.value, relative.suffix].filter(Boolean).join(" ")
      : null;
  return (
    <span className="block truncate text-2xs font-normal text-muted-foreground">
      #{summary.root.channelName} · {replies}
      {when ? ` · ${when}` : ""}
    </span>
  );
}
