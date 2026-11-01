import type { BoardPost, RunId, ThreadId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { ChevronRightIcon, CornerDownRightIcon, MessageSquareIcon, ReplyIcon } from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import ChatMarkdown, { type ChatMarkdownContextReference } from "../ChatMarkdown";
import { ChangedFilesCard } from "../chat/ChangedFilesTree";
import { MessageCopyButton } from "../chat/MessageCopyButton";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  BoardAuthorAvatar,
  BoardAuthorLabel,
  BoardTimestamp,
  boardAuthorName,
} from "./BoardPrimitives";
import { BoardReactionPicker, BoardReactionPills } from "./BoardReactions";
import { BoardMentionLabel } from "./BoardMentionLabel";
import {
  BOARD_MENTION_KIND,
  boardMainPostContent,
  isLongBoardPost,
  linkBoardMentions,
} from "./boardDiscussion";

// Matches chat's collapsed messages: the last lines fade instead of cutting mid-line.
const COLLAPSED_FADE_MASK = "linear-gradient(to bottom, black calc(100% - 2rem), transparent)";

export const boardPostElementId = (postId: string) => `board-post-${postId}`;

function mentionRenderer(
  mentions: readonly ThreadId[] | undefined,
  onOpen: (threadId: ThreadId) => void,
) {
  return ({ kind, contextId, label }: ChatMarkdownContextReference): ReactNode => {
    const threadId = kind === BOARD_MENTION_KIND ? mentions?.[Number(contextId)] : undefined;
    return threadId ? (
      <MentionChip threadId={threadId} label={label} onOpen={onOpen} />
    ) : (
      <span>{label}</span>
    );
  };
}

/** Inline at the text's own size, so a mention never changes the line height. */
function MentionChip({
  threadId,
  label,
  onOpen,
}: {
  threadId: ThreadId;
  label: string;
  onOpen: (threadId: ThreadId) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(threadId)}
      className="rounded-sm align-baseline outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <BoardMentionLabel threadId={threadId} label={label} />
    </button>
  );
}

/** Set only by the Reply action; an @mention alone is not a reply. Click jumps to the original. */
function ReplyingTo({
  replyTarget,
  onJumpTo,
  alignRight,
}: {
  replyTarget: BoardPost;
  onJumpTo: (postId: BoardPost["id"]) => void;
  alignRight: boolean;
}) {
  const name = boardAuthorName(replyTarget.author);
  return (
    <button
      type="button"
      aria-label={`Replying to ${name}. Show the message`}
      onClick={() => onJumpTo(replyTarget.id)}
      className={cn(
        "mb-1 flex max-w-full min-w-0 items-center gap-1.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        alignRight && "ml-auto",
      )}
    >
      <CornerDownRightIcon
        aria-hidden="true"
        className={cn("size-3 shrink-0", alignRight && "order-last -scale-x-100")}
      />
      <span className="shrink-0">Replying to</span>
      <span className="inline-flex shrink-0 items-center gap-1">
        <span aria-hidden="true" className="flex grayscale">
          <BoardAuthorAvatar author={replyTarget.author} size="2xs" />
        </span>
        <BoardAuthorLabel author={replyTarget.author} />
      </span>
    </button>
  );
}

function AgentName({
  author,
  onOpen,
  className,
}: {
  author: Extract<BoardPost["author"], { kind: "agent" }>;
  onOpen: (threadId: ThreadId) => void;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => onOpen(author.threadId)}
            className={cn(
              "min-w-0 truncate font-semibold text-foreground outline-none hover:underline focus-visible:underline",
              className,
            )}
          />
        }
      >
        <BoardAuthorLabel author={author} />
      </TooltipTrigger>
      <TooltipPopup>
        {author.model ? `${author.model} · ` : ""}Open thread: {author.title || "Untitled thread"}
      </TooltipPopup>
    </Tooltip>
  );
}

function WorkedFor({ post }: { post: BoardPost }) {
  if (post.workedMs === undefined || post.workedMs < 1_000) return null;
  return (
    <span className="shrink-0 text-muted-foreground">
      Worked for {formatDuration(post.workedMs)}
    </span>
  );
}

function MessageModel({ author }: { author: BoardPost["author"] }) {
  if (author.kind !== "agent" || !author.model) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
      {author.driver && (
        <ProviderInstanceIcon
          driverKind={author.driver}
          displayName={author.model}
          showBadge={false}
          className="size-3.5"
          iconClassName="size-3.5"
        />
      )}
      <span className="truncate">{author.model}</span>
    </span>
  );
}

/** Reactions on the left; copy, reply and react on the right, shown on hover or focus. */
function MessageFooter({
  post,
  reactions,
  footnote,
  onToggleReaction,
  onReply,
  compact = false,
}: {
  post: BoardPost;
  reactions: NonNullable<BoardPost["reactions"]>;
  footnote: ReactNode;
  onToggleReaction: (emoji: string, active: boolean) => void;
  onReply: (post: BoardPost) => void;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-3",
        compact
          ? "pointer-events-none absolute top-0 right-0 z-10 -translate-y-full rounded-md border border-border bg-popover px-1 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 has-data-popup-open:pointer-events-auto has-data-popup-open:opacity-100"
          : "mt-1 min-h-7",
      )}
    >
      {reactions.length > 0 && (
        <BoardReactionPills reactions={reactions} onToggle={onToggleReaction} />
      )}
      {footnote}
      <MessageModel author={post.author} />
      <span className="ml-auto flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 has-data-popup-open:opacity-100">
        <MessageCopyButton text={post.text} size="icon-xs" variant="ghost" />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Reply to ${boardAuthorName(post.author)}`}
          onClick={() => onReply(post)}
        >
          <ReplyIcon aria-hidden="true" />
        </Button>
        <BoardReactionPicker reactions={reactions} onToggle={onToggleReaction} />
      </span>
    </div>
  );
}

type OpenRunChanges = (threadId: ThreadId, runId: RunId, filePath?: string) => void;

/** The files the agent's run changed, as under its messages in chat. */
function PostChanges({ post, onOpen }: { post: BoardPost; onOpen: OpenRunChanges }) {
  const [expanded, setExpanded] = useState(false);
  const { resolvedTheme } = useTheme();
  const { author, changes } = post;
  if (author.kind !== "agent" || changes === undefined) return null;
  return (
    <ChangedFilesCard
      runId={changes.runId}
      files={changes.files}
      allDirectoriesExpanded={expanded}
      resolvedTheme={resolvedTheme}
      onToggleAllDirectories={() => setExpanded((value) => !value)}
      onOpenTurnDiff={(runId, filePath) => onOpen(author.threadId, runId, filePath)}
    />
  );
}

/** One reply: who wrote it and how long they worked, the bubble, then reactions and actions. */
export const BoardMessage = memo(function BoardMessage({
  post,
  text,
  replyTarget,
  onOpenAgentThread,
  onReact,
  onReply,
  onJumpTo,
  onOpenRunChanges,
  footnote = null,
  continuation = false,
  continues = false,
}: {
  post: BoardPost;
  text: string;
  onOpenRunChanges: OpenRunChanges;
  /** Shown under your own message, such as who has seen it. */
  footnote?: ReactNode;
  continuation?: boolean;
  continues?: boolean;
  replyTarget: BoardPost | null;
  onOpenAgentThread: (threadId: ThreadId) => void;
  onReact: (postId: BoardPost["id"], emoji: string, active: boolean) => void;
  onReply: (post: BoardPost) => void;
  onJumpTo: (postId: BoardPost["id"]) => void;
}) {
  const { author } = post;
  const mentions = post.mentions;
  const reactions = post.reactions ?? [];
  const renderMention = mentionRenderer(mentions, onOpenAgentThread);
  const toggleReaction = (emoji: string, active: boolean) => onReact(post.id, emoji, active);
  const [expanded, setExpanded] = useState(false);
  const collapsible = isLongBoardPost(text);
  const collapsed = collapsible && !expanded;

  const isUser = author.kind === "user";

  return (
    <li
      id={boardPostElementId(post.id)}
      data-board-post={post.id}
      className={cn(
        "group flex gap-3",
        continuation ? "mt-1" : "mt-6 first:mt-0",
        isUser && "flex-row-reverse",
      )}
    >
      {!isUser &&
        (continuation ? (
          <span aria-hidden="true" className="size-10 shrink-0" />
        ) : (
          <BoardAuthorAvatar author={author} />
        ))}
      <article aria-label={`Message from ${boardAuthorName(author)}`} className="min-w-0 flex-1">
        <div className={cn("relative w-fit max-w-full min-w-0", isUser && "ml-auto")}>
          {replyTarget && (
            <ReplyingTo replyTarget={replyTarget} onJumpTo={onJumpTo} alignRight={isUser} />
          )}
          {!continuation && author.kind === "agent" && (
            <div className="flex min-h-6 min-w-0 items-center gap-2 text-xs">
              <AgentName author={author} onOpen={onOpenAgentThread} className="text-sm" />
              <WorkedFor post={post} />
              <span className="ml-auto shrink-0 pl-3 text-muted-foreground tabular-nums opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                <BoardTimestamp value={post.createdAt} />
              </span>
            </div>
          )}
          {!continuation && author.kind === "system" && (
            <div className="text-xs text-muted-foreground">System · Availability update</div>
          )}
          <div
            className={cn(
              "w-fit max-w-full rounded-2xl border border-foreground/5 border-t-foreground/10 bg-linear-to-b from-foreground/3 to-transparent px-3.5 py-2.5 text-sm text-message-foreground wrap-anywhere",
              ((!continuation && !isUser) || replyTarget !== null) && "mt-1.5",
              isUser ? "board-user-message ml-auto rounded-tr-md" : "rounded-tl-md bg-message",
            )}
          >
            <div
              className={cn(collapsed && "max-h-64 overflow-hidden")}
              style={
                collapsed
                  ? { WebkitMaskImage: COLLAPSED_FADE_MASK, maskImage: COLLAPSED_FADE_MASK }
                  : undefined
              }
            >
              <ChatMarkdown
                text={linkBoardMentions(text, mentions)}
                cwd={undefined}
                renderContextReference={renderMention}
              />
            </div>
            {collapsible && (
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
                className="mt-1 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground focus-visible:underline"
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
          </div>
          <PostChanges post={post} onOpen={onOpenRunChanges} />
          {isUser && footnote && <div className="mt-1 flex justify-end">{footnote}</div>}
          <MessageFooter
            post={post}
            reactions={reactions}
            // Your footnote renders above, so your footer floats unless it shows reactions.
            compact={reactions.length === 0 && (isUser || (continues && footnote === null))}
            footnote={
              <>
                {(continuation || isUser) && (
                  <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <WorkedFor post={post} />
                    <span className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                      <BoardTimestamp value={post.createdAt} />
                    </span>
                  </span>
                )}
              </>
            }
            onToggleReaction={toggleReaction}
            onReply={onReply}
          />
        </div>
      </article>
    </li>
  );
});

/** The discussion's opening post: who posted it, its title and its full body, above the replies. */
export const BoardMainPost = memo(function BoardMainPost({
  post,
  onOpenAgentThread,
  onReact,
  onReply,
  onOpenRunChanges,
  footnote = null,
}: {
  post: BoardPost;
  onOpenRunChanges: OpenRunChanges;
  footnote?: ReactNode;
  onOpenAgentThread: (threadId: ThreadId) => void;
  onReact: (postId: BoardPost["id"], emoji: string, active: boolean) => void;
  onReply: (post: BoardPost) => void;
}) {
  const { author } = post;
  const { title, description } = boardMainPostContent(post);
  const reactions = post.reactions ?? [];
  const toggleReaction = (emoji: string, active: boolean) => onReact(post.id, emoji, active);

  return (
    <article
      id={boardPostElementId(post.id)}
      data-board-post={post.id}
      aria-label={`Post by ${boardAuthorName(author)}`}
      className="group rounded-2xl border border-border/60 bg-card/40 px-5 py-4"
    >
      <div className="flex min-h-7 min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <BoardAuthorAvatar author={author} size="sm" />
        <span className="shrink-0">Posted by</span>
        {author.kind === "agent" ? (
          <AgentName author={author} onOpen={onOpenAgentThread} />
        ) : (
          <span className="font-semibold text-foreground">you</span>
        )}
        <WorkedFor post={post} />
        <span className="ml-auto shrink-0 pl-3 tabular-nums opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          <BoardTimestamp value={post.createdAt} />
        </span>
      </div>
      <h1 className="mt-3 text-xl font-semibold tracking-tight text-balance">{title}</h1>
      {description && (
        <div className="mt-3 text-sm wrap-anywhere">
          <ChatMarkdown
            text={linkBoardMentions(description, post.mentions)}
            cwd={undefined}
            renderContextReference={mentionRenderer(post.mentions, onOpenAgentThread)}
          />
        </div>
      )}
      {author.kind === "agent" && (
        <button
          type="button"
          onClick={() => onOpenAgentThread(author.threadId)}
          className="group/source mt-4 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <MessageSquareIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-muted-foreground">Started in</span>
          <span className="min-w-0 truncate font-medium text-foreground">
            {author.title || "Untitled thread"}
          </span>
          <ChevronRightIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground group-hover/source:text-foreground"
          />
        </button>
      )}
      <PostChanges post={post} onOpen={onOpenRunChanges} />
      <MessageFooter
        post={post}
        reactions={reactions}
        footnote={footnote}
        onToggleReaction={toggleReaction}
        onReply={onReply}
      />
    </article>
  );
});
