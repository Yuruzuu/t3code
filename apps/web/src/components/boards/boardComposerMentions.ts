import {
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
} from "../../composer-logic";
import { formatBoardMention } from "@t3tools/shared/boardMentions";

const MENTION_QUERY = /(?:^|\s)@([\w-]*)$/;

export function boardMentionQuery(value: string, cursor: number, suppressed = false) {
  if (suppressed) return undefined;
  const expandedCursor = expandCollapsedComposerCursor(value, cursor);
  return MENTION_QUERY.exec(value.slice(0, expandedCursor))?.[1]?.toLowerCase();
}

export function insertBoardMention(value: string, cursor: number, name: string, threadId: string) {
  const expandedCursor = expandCollapsedComposerCursor(value, cursor);
  const before = value.slice(0, expandedCursor).replace(/@[\w-]*$/, "");
  const inserted = `${before}${formatBoardMention(name, threadId)} `;
  const nextValue = inserted + value.slice(expandedCursor);
  return {
    value: nextValue,
    cursor: collapseExpandedComposerCursor(nextValue, inserted.length),
    suppressMentionQuery: false,
  };
}
