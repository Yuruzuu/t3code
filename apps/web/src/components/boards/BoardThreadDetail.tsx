import type { BoardAuthor, BoardPost, ThreadId } from "@t3tools/contracts";
import { ArrowLeftIcon, HashIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { observeIntersection } from "~/lib/observeIntersection";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { BoardHandlingControls, BoardHandlingLine } from "./BoardHandling";
import { BoardComposer } from "./BoardComposer";
import { BoardDiscussionPanel } from "./BoardDiscussionPanel";
import { BoardTodos } from "./BoardTodos";
import { agentMembers } from "./BoardMembers";
import { BoardMainPost, BoardMessage, boardPostElementId } from "./BoardMessage";
import { TimelineMinimap } from "../chat/TimelineMinimap";
import {
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHitStripWidth,
} from "../chat/MessagesTimeline.logic";
import { forwardWheelToTimeline } from "../chat/timelineMinimapWheel";
import {
  BoardAuthorAvatar,
  BoardAuthorLabel,
  BoardEmptyState,
  BoardLoading,
  BoardAgentTrails,
  BoardWorkingIndicator,
  boardAuthorName,
  boardPostExcerpt,
} from "./BoardPrimitives";
import {
  agentJoinPostIds,
  firstNewPostIndex,
  isBoardMessageContinuation,
  seenYourLatest,
} from "./boardDiscussion";
import type { BoardWorker, BoardsViewModel } from "./boardsViewModel";
import { boardThreadScrollAction } from "./boardThreadScroll";

/** How close to the end still counts as "at the bottom" for following new posts. */
const STICK_THRESHOLD_PX = 48;

function scrollToEnd(scroller: HTMLElement | null) {
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select") !== null)
  );
}

export function BoardThreadDetail({ model }: { model: BoardsViewModel }) {
  const openAgentThread = useStableCallback((threadId: ThreadId) =>
    model.onOpenAgentThread({ kind: "agent", threadId, projectId: null, title: "", driver: null }),
  );
  const react = useStableCallback(model.onReact);
  const openRunChanges = useStableCallback(model.onOpenRunChanges);
  const closeThread = useStableCallback(model.onCloseThread);
  const { thread } = model;
  const channelName = thread?.summary.root.channelName ?? model.selectedChannelName;
  const root = thread?.summary.root;
  const posts = thread?.posts ?? [];
  const members = thread?.members ?? [];
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const previousPostIds = useRef<readonly string[] | null>(null);
  const prependAnchor = useRef<{ postId: string; offset: number } | null>(null);
  const loadingOlder = useRef(false);
  const olderPostsRef = useRef<HTMLDivElement>(null);
  const [replyTo, setReplyTo] = useState<BoardPost | null>(null);
  // The bar above the composer only repeats the working rows, so it steps aside while they show.
  const [workersInView, setWorkersInView] = useState(false);
  const observeWorkers = useStableCallback((list: HTMLUListElement | null) => {
    if (!list) return;
    const stop = observeIntersection(list, (entry) => setWorkersInView(entry.isIntersecting), {
      threshold: 0.5,
    });
    return () => {
      stop();
      setWorkersInView(false);
    };
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [stripMap] = useState(() => new Map<string, HTMLSpanElement>());
  const [gutter, setGutter] = useState({ persistent: false, hitWidth: 0 });

  // Your read marker from before this visit, kept so the "New" divider stays put once the
  // discussion is marked read.
  const [visit, setVisit] = useState<{ readAt: string | null } | null>(null);
  if (visit === null && thread && !model.threadPending)
    setVisit({ readAt: thread.summary.readAt ?? null });
  const newIndex = visit === null ? -1 : firstNewPostIndex(posts, visit.readAt);

  const postsById = new Map(posts.map((post) => [post.id, post]));
  const seen = model.threadPending ? null : seenYourLatest(posts, members);
  const seenNote = (postId: BoardPost["id"]) =>
    seen && seen.postId === postId && seen.agents.length > 0 ? (
      <BoardSeenBy agents={seen.agents} />
    ) : null;
  const states = agentMembers(members, model.agentActivity);
  const agents = states.flatMap(({ member }) =>
    member.author.kind === "agent" ? [member.author] : [],
  );
  const handlingAgents = [
    ...agents,
    ...model.handlingAgents.filter(
      (candidate) => !agents.some((agent) => agent.threadId === candidate.threadId),
    ),
  ];
  const workers: BoardWorker[] = states.flatMap(({ member, activity }) =>
    member.author.kind === "agent" && activity !== null
      ? [{ author: member.author, activity }]
      : [],
  );
  const waiting =
    thread?.handling?.selections?.some((selection) => selection.status === "selecting") ?? false;

  // An agent's changed files are captured when its run ends, so re-read the discussion then.
  const workingKey = workers.map((worker) => worker.author.threadId).join(",");
  const previousWorking = useRef(workingKey);
  const refreshThread = useStableCallback(model.onRefreshThread);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refetches from the server when a working agent in this discussion finishes.
  useEffect(() => {
    const before = previousWorking.current;
    previousWorking.current = workingKey;
    const now = new Set(workingKey.split(","));
    if (before.split(",").some((id) => id !== "" && !now.has(id))) refreshThread();
  }, [workingKey, refreshThread, previousWorking]);

  const jumpTo = useStableCallback((postId: string) => {
    document.getElementById(boardPostElementId(postId))?.scrollIntoView({ block: "start" });
  });
  const reply = useStableCallback((post: BoardPost) => setReplyTo(post));
  const capturePrependAnchor = useStableCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top;
    const element = [...scroller.querySelectorAll<HTMLElement>("[data-board-post]")].find(
      (item) => item.dataset.boardPost !== root?.id && item.getBoundingClientRect().bottom > top,
    );
    prependAnchor.current = element
      ? { postId: element.dataset.boardPost!, offset: element.getBoundingClientRect().top - top }
      : null;
  });
  const loadOlderPosts = useStableCallback(() => {
    if (!model.hasOlderPosts || model.loadingOlderPosts || loadingOlder.current) return;
    capturePrependAnchor();
    loadingOlder.current = true;
    model.onLoadOlderPosts();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restores the viewport anchor after server pagination and follows new posts only at the end.
  useLayoutEffect(() => {
    if (model.threadPending) return;
    const postIds = posts.map((post) => post.id);
    const action = boardThreadScrollAction(previousPostIds.current, postIds, stickToBottom.current);
    previousPostIds.current = postIds;
    const scroller = scrollerRef.current;
    if (action === "bottom") scrollToEnd(scroller);
    if (action === "preserve-anchor" && scroller && prependAnchor.current) {
      const element = document.getElementById(boardPostElementId(prependAnchor.current.postId));
      if (element)
        scroller.scrollTop +=
          element.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          prependAnchor.current.offset;
    }
    if (!model.loadingOlderPosts) {
      loadingOlder.current = false;
      prependAnchor.current = null;
    }
  }, [posts, model.threadPending, model.loadingOlderPosts]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps the live edge visible when rendered markdown or images change the content height.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    return observeResize(content, () => {
      if (stickToBottom.current && !loadingOlder.current) scrollToEnd(scrollerRef.current);
    });
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Loads earlier server pages when their sentinel enters the discussion's scroll viewport.
  useEffect(() => {
    const sentinel = olderPostsRef.current;
    const scroller = scrollerRef.current;
    if (!model.hasOlderPosts || !sentinel || !scroller) return;
    return observeIntersection(
      sentinel,
      (entry) => {
        if (entry.isIntersecting && previousPostIds.current !== null) loadOlderPosts();
      },
      { root: scroller, rootMargin: "120px 0px 0px 0px" },
    );
  }, [model.hasOlderPosts, loadOlderPosts]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Marks the on-screen messages on the chat minimap as the reader scrolls.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || posts.length === 0 || typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.boardPost;
          if (!id) continue;
          if (entry.isIntersecting) visible.set(id, entry.boundingClientRect.top);
          else visible.delete(id);
          const strip = stripMap.get(id);
          if (strip) strip.dataset.inView = entry.isIntersecting ? "true" : "false";
        }
        const top = [...visible].sort((left, right) => left[1] - right[1])[0];
        if (top) setActiveId(top[0]);
      },
      { root: scroller },
    );
    for (const element of scroller.querySelectorAll("[data-board-post]")) observer.observe(element);
    return () => observer.disconnect();
  }, [posts.length, stripMap]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The minimap only stays visible and clickable when the side gutter is wide enough, as in chat.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const measure = () => {
      const viewportWidth = scroller.getBoundingClientRect().width;
      const contentWidth = content.getBoundingClientRect().width;
      setGutter({
        persistent: resolveTimelineMinimapHasPersistentGutter(viewportWidth, contentWidth),
        hitWidth: resolveTimelineMinimapHitStripWidth(viewportWidth, contentWidth),
      });
    };
    measure();
    return observeResize(scroller, measure);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Esc closes the discussion from anywhere outside a text field or open popup.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isEditableTarget(event.target))
        return;
      if (document.querySelector("[data-popup-open]")) return;
      closeThread();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeThread]);

  const minimapItems = posts.map((post, index) => ({
    id: post.id,
    rowIndex: index,
    userText: `${boardAuthorName(post.author)}: ${boardPostExcerpt(post.text, { includeFirstLine: true })}`,
    assistantText: null,
  }));
  const joinPostIds = agentJoinPostIds(posts);
  const replies = posts.slice(1).map((post, index) => (
    <BoardPostRow
      key={post.id}
      post={post}
      isNew={index + 1 === newIndex}
      joined={joinPostIds.has(post.id)}
      continuation={isBoardMessageContinuation(
        post,
        index === 0 ? undefined : posts[index],
        index + 1 === newIndex,
      )}
      continues={
        posts[index + 2] !== undefined &&
        isBoardMessageContinuation(posts[index + 2]!, post, index + 2 === newIndex)
      }
      text={post.text}
      replyTarget={post.replyToId === undefined ? null : (postsById.get(post.replyToId) ?? null)}
      onOpenAgentThread={openAgentThread}
      onReact={react}
      onReply={reply}
      onJumpTo={jumpTo}
      onOpenRunChanges={openRunChanges}
      footnote={
        post.author.kind === "user" ? (
          <div className="flex flex-col items-end gap-1">
            <BoardHandlingLine post={post} model={model} agents={handlingAgents} />
            {seenNote(post.id)}
          </div>
        ) : (
          seenNote(post.id)
        )
      }
    />
  ));
  const activeIndex = posts.findIndex((post) => post.id === activeId);

  // Reserves the panel's width in the lane, as chat does, so the scrollbar stays at the edge.
  return (
    <div className="relative flex min-h-0 flex-1 @5xl/boards:[--chat-lane-inset-end:22rem]">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollerRef}
            onScroll={(event) => {
              const scroller = event.currentTarget;
              stickToBottom.current =
                scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
                STICK_THRESHOLD_PX;
              if (loadingOlder.current) capturePrependAnchor();
            }}
            style={{ overflowAnchor: "none" }}
            className={cn(
              "h-full overflow-y-auto pe-(--chat-lane-inset-end) scrollbar-gutter-both",
              // Messages fade into the working row and composer instead of cutting off.
              getVirtualizedScrollFadeClassName({ top: false, bottom: true }),
            )}
          >
            <div
              ref={contentRef}
              className="mx-auto w-full max-w-(--chat-content-max-width) px-5 pt-6 pb-8 @3xl/boards:px-8"
            >
              <Button variant="ghost" size="xs" className="-ml-2" onClick={model.onCloseThread}>
                <ArrowLeftIcon aria-hidden="true" />
                <HashIcon aria-hidden="true" className="-mr-1 opacity-60" />
                {channelName ?? "Channel"}
              </Button>
              {thread && root && !model.threadPending ? (
                <>
                  <div className="mt-4">
                    <BoardMainPost
                      post={root}
                      onOpenAgentThread={openAgentThread}
                      onReact={react}
                      onReply={reply}
                      onOpenRunChanges={openRunChanges}
                      footnote={
                        root.author.kind === "user" ? (
                          <div className="flex flex-col items-end gap-1">
                            <BoardHandlingLine post={root} model={model} agents={handlingAgents} />
                            {seenNote(root.id)}
                          </div>
                        ) : (
                          seenNote(root.id)
                        )
                      }
                    />
                  </div>

                  <BoardHandlingControls model={model} agents={handlingAgents} />
                  {model.hasOlderPosts && (
                    <div ref={olderPostsRef} className="mt-6 flex justify-center">
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={model.loadingOlderPosts || !model.isConnected}
                        onClick={loadOlderPosts}
                      >
                        {model.loadingOlderPosts ? "Loading older replies…" : "Load older replies"}
                      </Button>
                    </div>
                  )}
                  <ol aria-label="Replies" className="mt-8">
                    {replies}
                  </ol>
                  {model.threadError ? (
                    <BoardEmptyState title="This discussion couldn't load">
                      {model.threadError}
                    </BoardEmptyState>
                  ) : model.threadPending ? (
                    <BoardLoading label="Loading replies" />
                  ) : null}
                  <BoardAgentTrails workers={workers} waiting={waiting} listRef={observeWorkers} />
                </>
              ) : model.threadError ? (
                <BoardEmptyState title="This discussion couldn't load">
                  {model.threadError}
                </BoardEmptyState>
              ) : !model.isConnected ? (
                <BoardEmptyState title="You're offline">
                  This discussion loads when the connection comes back.
                </BoardEmptyState>
              ) : (
                <BoardLoading label="Loading discussion" />
              )}
            </div>
          </div>
          {!model.threadPending && (
            <TimelineMinimap
              items={minimapItems}
              hasPersistentGutter={gutter.persistent}
              hitStripWidth={gutter.hitWidth}
              currentIndex={activeIndex === -1 ? null : activeIndex}
              stripMap={stripMap}
              onWheel={(event) => {
                if (scrollerRef.current) forwardWheelToTimeline(event, scrollerRef.current);
              }}
              onSelect={(item) => jumpTo(item.id)}
            />
          )}
        </div>

        {thread && root && (
          <div className="shrink-0 pe-(--chat-lane-inset-end)">
            <div className="mx-auto max-w-(--chat-content-max-width) px-4 pb-4 @3xl/boards:px-8">
              {!workersInView && (
                <BoardWorkingIndicator workers={workers} waiting={waiting} className="mb-2 px-1" />
              )}
              {/* The discussion panel shows the todos once there is room for it. */}
              <div className="@5xl/boards:hidden">
                <BoardTodos key={`todos:${root.id}`} todos={thread.todos ?? []} onJumpTo={jumpTo} />
              </div>
              <BoardComposer
                key={root.id}
                disabled={!model.isConnected}
                closed={thread.handling?.lifecycle === "closed"}
                agents={agents}
                replyTo={replyTo}
                onCancelReply={() => setReplyTo(null)}
                onSubmit={async (text, requestKey, mode) => {
                  setReplyTo(null);
                  stickToBottom.current = true;
                  try {
                    await model.onPost({
                      destination: { kind: "reply", rootId: root.id },
                      text,
                      requestKey,
                      mode,
                      ...(thread.handling === undefined
                        ? {}
                        : { expectedRevision: thread.handling.revision }),
                      ...(replyTo ? { replyToId: replyTo.id } : {}),
                    });
                  } catch (cause) {
                    setReplyTo((current) => current ?? replyTo);
                    throw cause;
                  }
                }}
              />
            </div>
          </div>
        )}
      </div>
      {thread && root && (
        <BoardDiscussionPanel
          lead={
            thread.handling === undefined
              ? root.author.kind === "agent"
                ? root.author
                : null
              : (handlingAgents.find((agent) => agent.threadId === thread.handling?.leadThreadId) ??
                null)
          }
          members={states}
          todos={thread.todos ?? []}
          onOpenAgentThread={model.onOpenAgentThread}
          onJumpTo={jumpTo}
        />
      )}
    </div>
  );
}

function BoardSeenBy({ agents }: { agents: readonly Extract<BoardAuthor, { kind: "agent" }>[] }) {
  const names = agents.map(boardAuthorName).join(", ");
  return (
    <span
      aria-label={`Seen by ${names}`}
      className="inline-flex items-center gap-1 text-2xs text-muted-foreground"
    >
      Seen by
      <span aria-hidden="true" className="flex -space-x-1">
        {agents.slice(0, 3).map((author) => (
          <BoardAuthorAvatar key={author.threadId} author={author} size="2xs" ring />
        ))}
      </span>
      {agents.length > 3 && <span aria-hidden="true">+{agents.length - 3}</span>}
    </span>
  );
}

function BoardPostRow({
  isNew,
  joined,
  ...props
}: Parameters<typeof BoardMessage>[0] & { isNew: boolean; joined: boolean }) {
  return (
    <>
      {isNew && (
        <li role="separator" aria-label="New messages" className="mt-6 flex items-center gap-3">
          <span className="h-px flex-1 bg-info/40" />
          <span className="text-2xs font-medium text-info-foreground">New</span>
          <span className="h-px flex-1 bg-info/40" />
        </li>
      )}
      {joined && (
        <li role="separator" className="mt-6 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border/60" />
          <span className="inline-flex items-center gap-1.5">
            <BoardAuthorAvatar author={props.post.author} size="2xs" />
            <BoardAuthorLabel author={props.post.author} /> has joined the discussion
          </span>
          <span className="h-px flex-1 bg-border/60" />
        </li>
      )}
      <BoardMessage {...props} />
    </>
  );
}
