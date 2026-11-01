/* oxlint-disable shadcn/no-raw-colors -- SVG luminance masks require white and black regardless of theme. */
import { boardPersona } from "@t3tools/shared/boardPersona";
import { memo, useId } from "react";

import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";

import { boardAvatarColors, boardAvatarShapes } from "./boardAvatarArtwork";

export type BoardOrbSize = "2xs" | "xs" | "sm" | "md" | "lg";

export const boardAvatarSizeClass: Record<BoardOrbSize, string> = {
  /** Inline with small text. */
  "2xs": "size-3.5",
  xs: "size-5",
  sm: "size-7",
  md: "size-10",
  lg: "size-12",
};

export function boardAvatarColor(threadId: string) {
  const { hue } = boardPersona(threadId);
  const color = boardAvatarColors[hue % boardAvatarColors.length]!;
  return `light-dark(${color.light}, ${color.dark})`;
}

/** Grok Bot artwork, selected consistently from the agent's persona. */
export const BoardOrb = memo(function BoardOrb({
  threadId,
  size = "md",
  ring = false,
  working = false,
}: {
  threadId: string;
  size?: BoardOrbSize;
  ring?: boolean;
  working?: boolean;
}) {
  const { face, shape } = boardPersona(threadId);
  const maskId = useId();
  const artwork = boardAvatarShapes[(shape + (face % 2) * 4) % boardAvatarShapes.length]!;

  return (
    <span
      aria-hidden="true"
      ref={working ? observeVisibleAnimation : undefined}
      data-working={working || undefined}
      className={cn(
        "board-orb inline-block shrink-0",
        boardAvatarSizeClass[size],
        ring && "rounded-full bg-background ring-2 ring-background",
      )}
    >
      <svg viewBox="0 0 144 144" className="size-full overflow-visible">
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="144" height="144">
            <rect width="144" height="144" fill="white" />
            {artwork.eyes.map((path) => (
              <path key={path} d={path} fill="black" />
            ))}
          </mask>
        </defs>
        <g className="board-orb-artwork" fill={boardAvatarColor(threadId)} mask={`url(#${maskId})`}>
          {artwork.body.map((path) => (
            <path key={path} d={path} />
          ))}
        </g>
        <BoardOrbDots fill={boardAvatarColor(threadId)} />
      </svg>
    </span>
  );
});

function BoardOrbDots({ fill }: { fill: string }) {
  return (
    <g className="board-orb-dots" fill={fill}>
      {[33, 72, 111].map((position) => (
        <g key={position} className="board-orb-dot">
          <circle cx={position} cy="72" r="14" />
        </g>
      ))}
    </g>
  );
}

/** The working dots with no agent behind them, for when nobody has picked up a message yet. */
export function BoardWaitingOrb({ size = "md" }: { size?: BoardOrbSize }) {
  return (
    <span
      aria-hidden="true"
      ref={observeVisibleAnimation}
      data-working
      className={cn("board-orb inline-block shrink-0 text-foreground", boardAvatarSizeClass[size])}
    >
      <svg viewBox="0 0 144 144" className="size-full overflow-visible">
        <BoardOrbDots fill="currentColor" />
      </svg>
    </span>
  );
}
