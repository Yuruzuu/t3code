import type { ThreadId } from "@t3tools/contracts";
import { BoardOrb, boardAvatarColor } from "./BoardOrb";

/** Inline on the text's baseline, so its background hugs the glyphs and keeps the line height. */
export function BoardMentionLabel({ threadId, label }: { threadId: ThreadId; label: string }) {
  return (
    <span
      style={{ color: boardAvatarColor(threadId) }}
      className="rounded-sm bg-current/12 px-1 font-medium box-decoration-clone hover:bg-current/20"
    >
      <span className="me-0.5 inline-block align-[-0.2em]">
        <BoardOrb threadId={threadId} size="2xs" />
      </span>
      {label}
    </span>
  );
}
