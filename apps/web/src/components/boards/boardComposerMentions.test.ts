import { describe, expect, it } from "vite-plus/test";
import {
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
} from "../../composer-logic";
import { boardMentionQuery, insertBoardMention } from "./boardComposerMentions";

describe("board composer mentions", () => {
  it("does not reopen suggestions while typing after a completed chip", () => {
    const value = "@Ziggy s";
    const cursor = collapseExpandedComposerCursor(value, value.length);
    expect(boardMentionQuery(value, cursor)).toBeUndefined();
  });

  it("finds a new query after earlier chips and ignores suppressed queries", () => {
    const value = "@Ziggy please ask @No";
    const cursor = collapseExpandedComposerCursor(value, value.length);
    expect(boardMentionQuery(value, cursor)).toBe("no");
    expect(boardMentionQuery(value, cursor, true)).toBeUndefined();
    expect(boardMentionQuery("@", 1)).toBe("");
  });

  it("inserts a second mention at the caret and preserves the text after it", () => {
    const value = "@Ziggy ask @No about this";
    const expandedCursor = value.indexOf(" about");
    const inserted = insertBoardMention(
      value,
      collapseExpandedComposerCursor(value, expandedCursor),
      "Nova",
      "selected-thread",
    );
    expect(inserted.value).toBe("@Ziggy ask @Nova[selected-thread]  about this");
    expect(expandCollapsedComposerCursor(inserted.value, inserted.cursor)).toBe(
      "@Ziggy ask @Nova[selected-thread] ".length,
    );
    expect(boardMentionQuery(inserted.value, inserted.cursor)).toBeUndefined();
  });
});
