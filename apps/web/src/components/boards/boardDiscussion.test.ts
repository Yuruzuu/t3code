import { BoardPostId, ThreadId, type BoardMember, type BoardPost } from "@t3tools/contracts";
import { boardPersona } from "@t3tools/shared/boardPersona";
import { describe, expect, it } from "vite-plus/test";

import {
  agentJoinPostIds,
  boardMainPostContent,
  isBoardMessageContinuation,
  firstNewPostIndex,
  isLongBoardPost,
  linkBoardMentions,
  seenYourLatest,
} from "./boardDiscussion";

const agent = (id: string) => ({
  kind: "agent" as const,
  threadId: ThreadId.make(id),
  projectId: null,
  title: id,
  driver: null,
});
const post = (id: string, minute: number, author: BoardPost["author"]): BoardPost => ({
  id: BoardPostId.make(id),
  rootId: BoardPostId.make("a"),
  channelName: "general",
  author,
  text: id,
  createdAt: `2026-10-28T00:0${minute}:00.000Z`,
});
const member = (id: string, readMinute?: number): BoardMember => ({
  author: agent(id),
  subscribed: true,
  postCount: 0,
  lastPostedAt: null,
  ...(readMinute === undefined ? {} : { readAt: `2026-10-28T00:0${readMinute}:30.000Z` }),
});

describe("board discussion helpers", () => {
  it("keeps a long opening paragraph in the description and uses the source thread title", () => {
    const opening = {
      ...post("root", 0, agent("Performance review")),
      text: "Review the rendering and navigation costs. ".repeat(8),
    };
    expect(boardMainPostContent(opening)).toEqual({
      title: "Performance review",
      description: opening.text.trim(),
    });
  });

  it("separates an authored heading from its description", () => {
    for (const heading of ["Performance review", "# Performance review"]) {
      expect(
        boardMainPostContent({
          ...post("root", 0, agent("Source thread")),
          text: `${heading}\n\nReview the rendering costs.`,
        }),
      ).toEqual({ title: "Performance review", description: "Review the rendering costs." });
    }
    expect(
      boardMainPostContent({ ...post("root", 0, { kind: "user" }), text: "Please review this." }),
    ).toEqual({ title: "Discussion", description: "Please review this." });
  });
  it("stacks only consecutive messages by the same author without a divider", () => {
    const user = post("u", 1, { kind: "user" });
    const first = post("a", 2, agent("a"));
    const second = post("b", 3, agent("b"));
    expect(isBoardMessageContinuation(user, undefined)).toBe(false);
    expect(isBoardMessageContinuation(user, user)).toBe(true);
    expect(isBoardMessageContinuation(first, first)).toBe(true);
    expect(isBoardMessageContinuation(first, second)).toBe(false);
    expect(isBoardMessageContinuation(first, user)).toBe(false);
    expect(isBoardMessageContinuation(user, first)).toBe(false);
    expect(isBoardMessageContinuation(first, first, true)).toBe(false);
  });
  it("links resolved mentions outside code and leaves unknown names as text", () => {
    const pip = ThreadId.make("thread-pip");
    const name = boardPersona(pip).name;
    expect(linkBoardMentions(`hey @${name}, not @Nobody, \`@${name}\``, [pip])).toBe(
      `hey [@${name}](t3-context://v1/board-agent/0), not @Nobody, \`@${name}\``,
    );
    const first = ThreadId.make("collision-2");
    const second = ThreadId.make("collision-5");
    const sharedName = boardPersona(first).name;
    expect(boardPersona(second).name).toBe(sharedName);
    expect(
      linkBoardMentions(`@${sharedName}[${first}] and @${sharedName}[${second}]`, [first, second]),
    ).toBe(
      `[@${sharedName}](t3-context://v1/board-agent/0) and [@${sharedName}](t3-context://v1/board-agent/1)`,
    );
  });

  it("marks your latest message seen by agents who read after it", () => {
    const posts = [
      post("a", 1, { kind: "user" }),
      post("b", 2, { kind: "user" }),
      post("c", 3, agent("x")),
    ];
    const seen = seenYourLatest(posts, [member("r", 3), member("q", 1), member("n")]);
    expect(seen?.postId).toBe("b");
    expect(seen?.agents.map((author) => author.threadId)).toEqual(["r"]);
    expect(seenYourLatest([post("c", 3, agent("x"))], [member("r", 3)])).toBeNull();
  });

  it("finds the first post from someone else after the read marker", () => {
    const posts = [
      post("a", 1, { kind: "user" }),
      post("b", 2, { kind: "user" }),
      post("c", 3, agent("r")),
    ];
    expect(firstNewPostIndex(posts, null)).toBe(-1);
    expect(firstNewPostIndex(posts, "2026-10-28T00:01:30.000Z")).toBe(2);
  });

  it("marks each agent's first reply as where it joined, except the discussion's author", () => {
    const posts = [
      post("root", 0, agent("author")),
      post("a", 1, agent("author")),
      post("b", 2, agent("reviewer")),
      post("c", 3, { kind: "user" }),
      post("d", 4, agent("reviewer")),
      post("e", 5, agent("other")),
    ];
    expect([...agentJoinPostIds(posts)]).toEqual(["b", "e"]);
  });

  it("collapses posts past about ten lines", () => {
    expect(isLongBoardPost("Short and sweet.")).toBe(false);
    expect(isLongBoardPost("A sentence that goes on. ".repeat(45))).toBe(true);
    expect(isLongBoardPost("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11")).toBe(true);
  });
});
