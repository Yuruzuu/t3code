import type { BoardMember, BoardPost, ThreadId } from "@t3tools/contracts";
import { boardPersona } from "@t3tools/shared/boardPersona";
import { collectBoardMentions } from "@t3tools/shared/boardMentions";

export const BOARD_MENTION_KIND = "board-agent";
const MENTION_HREF_PREFIX = `t3-context://v1/${BOARD_MENTION_KIND}/`;
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

export function boardMainPostContent(post: BoardPost) {
  const text = post.text.trim();
  const [firstLine = "", ...remainingLines] = text.split("\n");
  const title = firstLine
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/[*_`]/g, "")
    .trim();
  const description = remainingLines.join("\n").trim();
  const hasHeading =
    /^#{1,6}\s+/.test(firstLine) || (title.length <= 120 && description.length > 0);
  if (title && hasHeading) return { title, description };
  return {
    title: (post.author.kind === "agent" ? post.author.title.trim() : "") || "Discussion",
    description: text,
  };
}

export function isBoardMessageContinuation(
  post: BoardPost,
  previous: BoardPost | undefined,
  interrupted = false,
) {
  if (!previous || interrupted || previous.author.kind !== post.author.kind) return false;
  return (
    post.author.kind === "user" ||
    (post.author.kind === "agent" &&
      previous.author.kind === "agent" &&
      previous.author.threadId === post.author.threadId)
  );
}

/**
 * Turns each resolved `@Name` into a context link, so markdown renders it as a mention chip.
 * The link id is the mention's index; code spans are left alone.
 */
export function linkBoardMentions(text: string, mentions: readonly ThreadId[] | undefined) {
  if (!mentions || mentions.length === 0) return text;
  const byIdentity = new Map<string, number>(mentions.map((threadId, index) => [threadId, index]));
  const byName = new Map<string, number[]>();
  for (const [index, threadId] of mentions.entries()) {
    const name = boardPersona(threadId).name.toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), index]);
  }
  return text
    .split(CODE)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : collectBoardMentions(part)
            .toReversed()
            .reduce((result, mention) => {
              const candidates = byName.get(mention.name.toLowerCase()) ?? [];
              const selectedIndex =
                mention.threadId === undefined
                  ? candidates.length === 1
                    ? candidates[0]
                    : undefined
                  : byIdentity.get(mention.threadId);
              return selectedIndex === undefined
                ? result
                : result.slice(0, mention.start) +
                    `[@${mention.name}](${MENTION_HREF_PREFIX}${selectedIndex})` +
                    result.slice(mention.end);
            }, part),
    )
    .join("");
}

/** Your latest message and the agents that have read the discussion since you posted it. */
export function seenYourLatest(posts: readonly BoardPost[], members: readonly BoardMember[]) {
  const latest = posts.findLast((post) => post.author.kind === "user");
  if (!latest) return null;
  const agents = members.flatMap(({ author, readAt }) =>
    author.kind === "agent" && readAt !== undefined && readAt >= latest.createdAt ? [author] : [],
  );
  return { postId: latest.id, agents };
}

/** Index of the first post someone else wrote after `readAt`, or -1 on a first visit. */
export function firstNewPostIndex(posts: readonly BoardPost[], readAt: string | null) {
  if (readAt === null) return -1;
  return posts.findIndex((post) => post.author.kind === "agent" && post.createdAt > readAt);
}

/**
 * Ids of replies that are an agent's first post here, where it joins the conversation. The agent
 * that started the discussion was always in it.
 */
export function agentJoinPostIds(posts: readonly BoardPost[]): ReadonlySet<BoardPost["id"]> {
  const root = posts[0];
  const seen = new Set<ThreadId>(root?.author.kind === "agent" ? [root.author.threadId] : []);
  const joins = new Set<BoardPost["id"]>();
  for (const post of posts.slice(1)) {
    if (post.author.kind !== "agent" || seen.has(post.author.threadId)) continue;
    seen.add(post.author.threadId);
    joins.add(post.id);
  }
  return joins;
}

const LONG_POST_CHARS = 900;
const LONG_POST_LINES = 10;

/** About ten lines of text; longer posts start collapsed behind "Show more". */
export function isLongBoardPost(text: string) {
  return text.length > LONG_POST_CHARS || text.trim().split("\n").length > LONG_POST_LINES;
}
