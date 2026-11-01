import type { BoardReaction } from "@t3tools/contracts";
import { boardPersona } from "@t3tools/shared/boardPersona";
import { SmilePlusIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const QUICK_REACTIONS = ["👍", "✅", "👀", "🎉", "❤️", "😄"] as const;

function reactorNames(reaction: BoardReaction) {
  return reaction.by
    .map((viewer) => (viewer.kind === "user" ? "You" : boardPersona(viewer.threadId).name))
    .join(", ");
}

const reactedByYou = (reaction: BoardReaction) =>
  reaction.by.some((viewer) => viewer.kind === "user");

/** Existing reactions as toggles; yours are highlighted and clicking takes them back. */
export const BoardReactionPills = memo(function BoardReactionPills({
  reactions,
  onToggle,
}: {
  reactions: readonly BoardReaction[];
  onToggle: (emoji: string, active: boolean) => void;
}) {
  return (
    <ul aria-label="Reactions" className="flex flex-wrap gap-1">
      {reactions.map((reaction) => {
        const mine = reactedByYou(reaction);
        return (
          <li key={reaction.emoji}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-pressed={mine}
                    aria-label={`${reaction.emoji} ${reaction.by.length}, from ${reactorNames(reaction)}`}
                    onClick={() => onToggle(reaction.emoji, !mine)}
                    className={cn(
                      "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      mine
                        ? "border-info/40 bg-info/10 text-foreground"
                        : "border-border bg-transparent text-muted-foreground hover:border-foreground/20 hover:text-foreground",
                    )}
                  />
                }
              >
                <span aria-hidden="true">{reaction.emoji}</span>
                <span aria-hidden="true">{reaction.by.length}</span>
              </TooltipTrigger>
              <TooltipPopup>{reactorNames(reaction)}</TooltipPopup>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
});

export function BoardReactionPicker({
  reactions,
  onToggle,
}: {
  reactions: readonly BoardReaction[];
  onToggle: (emoji: string, active: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Add reaction" />}>
        <SmilePlusIcon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-auto">
        <ul aria-label="Pick a reaction" className="flex gap-0.5">
          {QUICK_REACTIONS.map((emoji) => {
            const mine = reactions.some(
              (reaction) => reaction.emoji === emoji && reactedByYou(reaction),
            );
            return (
              <li key={emoji}>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`React with ${emoji}`}
                  aria-pressed={mine}
                  onClick={() => {
                    onToggle(emoji, !mine);
                    setOpen(false);
                  }}
                >
                  <span aria-hidden="true" className="text-base">
                    {emoji}
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}
