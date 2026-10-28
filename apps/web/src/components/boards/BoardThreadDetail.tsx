import type { BoardAuthor, BoardPost } from "@t3tools/contracts";
import { ArrowLeftIcon, HashIcon } from "lucide-react";
import { memo } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import ChatMarkdown from "../ChatMarkdown";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ScrollArea } from "../ui/scroll-area";
import { BoardComposer } from "./BoardComposer";
import { BoardMembers, agentMembers } from "./BoardMembers";
import {
  BoardAuthorAvatar,
  BoardEmptyState,
  BoardLoading,
  BoardTimestamp,
  BoardWorkingIndicator,
  boardAuthorName,
  boardAuthorRole,
  boardPostTitle,
} from "./BoardPrimitives";
import type { BoardsViewModel } from "./boardsViewModel";

/** One reading stream: every message, yours included, is avatar, byline, then bubble. */
const BoardMessage = memo(function BoardMessage({
  post,
  text,
  onOpenAgentThread,
}: {
  post: BoardPost;
  text: string;
  onOpenAgentThread: (author: BoardAuthor) => void;
}) {
  const { author } = post;

  return (
    <li className="flex gap-3">
      <BoardAuthorAvatar author={author} />
      <article aria-label={`Message from ${boardAuthorName(author)}`} className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2 text-xs">
          {author.kind === "agent" ? (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => onOpenAgentThread(author)}
                      className="truncate text-sm font-semibold text-foreground outline-none hover:underline focus-visible:underline"
                    />
                  }
                >
                  {boardAuthorName(author)}
                </TooltipTrigger>
                <TooltipPopup>Open thread: {author.title || "Untitled thread"}</TooltipPopup>
              </Tooltip>
              <span className="truncate text-muted-foreground">({boardAuthorRole(author)})</span>
            </>
          ) : (
            <span className="text-sm font-semibold text-foreground">You</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground/70">
            {author.kind === "agent" && author.model && (
              <>
                {author.driver && (
                  <ProviderInstanceIcon
                    driverKind={author.driver}
                    displayName={author.model}
                    className="size-3 self-center opacity-80"
                    iconClassName="size-3"
                  />
                )}
                <span className="max-w-40 truncate">{author.model}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <BoardTimestamp value={post.createdAt} />
          </span>
        </div>
        <div className="mt-2 w-fit max-w-full min-w-0 rounded-2xl rounded-tl-md bg-message px-3.5 py-2.5 text-sm text-message-foreground wrap-anywhere">
          <ChatMarkdown text={text} cwd={undefined} />
        </div>
      </article>
    </li>
  );
});

export function BoardThreadDetail({ model }: { model: BoardsViewModel }) {
  const openAgentThread = useStableCallback(model.onOpenAgentThread);
  const { thread } = model;
  const channelName = thread?.summary.root.channelName ?? model.selectedChannelName;
  const root = thread?.summary.root;
  const openingBody = root?.text.trim().split("\n").slice(1).join("\n").trim() ?? "";
  const members = thread ? agentMembers(thread.members, model.isAgentThreadRunning) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <ScrollArea key={model.selectedRootId}>
          <div className="mx-auto w-full max-w-3xl px-5 pt-6 pb-8 @3xl/boards:px-8">
            <Button variant="ghost" size="xs" className="-ml-2" onClick={model.onCloseThread}>
              <ArrowLeftIcon aria-hidden="true" />
              <HashIcon aria-hidden="true" className="-mr-1 opacity-60" />
              {channelName ?? "Channel"}
            </Button>
            {thread && root ? (
              <>
                <h1 className="mt-3 line-clamp-3 text-xl font-semibold tracking-tight text-balance">
                  {boardPostTitle(root.text)}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
                  <span>
                    Started <BoardTimestamp value={root.createdAt} />
                    {" · "}
                    {thread.summary.replyCount}{" "}
                    {thread.summary.replyCount === 1 ? "reply" : "replies"}
                  </span>
                  {members.length > 0 && (
                    <BoardMembers members={members} onOpenAgentThread={openAgentThread} />
                  )}
                </div>

                <ol aria-label="Messages" className="mt-8 space-y-5">
                  {thread.posts.map((post) => (
                    <BoardMessage
                      key={post.id}
                      post={post}
                      text={post.id === root.id ? openingBody || root.text : post.text}
                      onOpenAgentThread={openAgentThread}
                    />
                  ))}
                </ol>
                <BoardWorkingIndicator
                  authors={members
                    .filter((member) => member.working)
                    .map((member) => member.member.author)}
                  className="mt-6"
                />
              </>
            ) : model.error ? (
              <BoardEmptyState title="This discussion couldn't load">{model.error}</BoardEmptyState>
            ) : (
              <BoardLoading label="Loading discussion" />
            )}
          </div>
        </ScrollArea>
      </div>

      {thread && root && (
        <div className="shrink-0 px-4 pb-4 @3xl/boards:px-8">
          <div className="mx-auto max-w-3xl">
            <BoardComposer
              key={root.id}
              disabled={!model.isConnected}
              onSubmit={(text) =>
                model.onPost({ destination: { kind: "reply", rootId: root.id }, text })
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
