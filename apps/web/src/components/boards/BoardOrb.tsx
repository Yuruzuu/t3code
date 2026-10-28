import { boardPersona } from "@t3tools/shared/boardPersona";
import { memo, useId, type CSSProperties } from "react";

import { cn } from "~/lib/utils";

export type BoardOrbSize = "xs" | "sm" | "md" | "lg";

const sizeClass: Record<BoardOrbSize, string> = {
  xs: "size-4",
  sm: "size-6",
  md: "size-8",
  lg: "size-10",
};

function Body({ shape, fill }: { shape: number; fill: string }) {
  const edge = { fill, stroke: "var(--bot-edge)", strokeWidth: 0.8 };
  switch (shape) {
    case 1:
      return (
        <>
          <path d="M18 7.5V3.8" stroke="var(--bot-edge)" strokeWidth="1.4" strokeLinecap="round" />
          <circle
            cx="18"
            cy="3.4"
            r="2.2"
            fill="var(--bot-eye)"
            stroke="var(--bot-edge)"
            strokeWidth="0.8"
          />
          <rect x="4" y="7.5" width="28" height="25.5" rx="9" {...edge} />
        </>
      );
    case 2:
      return (
        <>
          <rect x="2.6" y="15.5" width="4" height="7" rx="2" fill="var(--bot-edge)" />
          <rect x="29.4" y="15.5" width="4" height="7" rx="2" fill="var(--bot-edge)" />
          <rect x="5.5" y="3.5" width="25" height="29.5" rx="12.5" {...edge} />
        </>
      );
    case 3:
      return (
        <path
          d="M7 13.5 8.6 4.6a1 1 0 0 1 1.7-.5l5.2 5.4h5l5.2-5.4a1 1 0 0 1 1.7.5L29 13.5c2 2 3 4.6 3 7.5 0 7-5.6 12-14 12S4 28 4 21c0-2.9 1-5.5 3-7.5Z"
          {...edge}
        />
      );
    default:
      return <circle cx="18" cy="18.5" r="15" {...edge} />;
  }
}

function Face({ face, detailed }: { face: number; detailed: boolean }) {
  const eye = { fill: "var(--bot-eye)" };
  const stroke = {
    fill: "none",
    stroke: "var(--bot-eye)",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
  };
  return (
    <>
      <rect x="9" y="14" width="18" height="12" rx="6" fill="var(--bot-visor)" />
      {face === 1 ? (
        <>
          <path d="M12.7 21.2q1.8-2.6 3.6 0" {...stroke} />
          <path d="M19.7 21.2q1.8-2.6 3.6 0" {...stroke} />
        </>
      ) : face === 2 ? (
        <>
          <ellipse cx="14.5" cy="20" rx="1.6" ry="2.5" {...eye} />
          <ellipse cx="21.5" cy="20" rx="1.6" ry="2.5" {...eye} />
        </>
      ) : face === 3 ? (
        <>
          <circle cx="14.5" cy="20" r="2" {...eye} />
          <path d="M19.7 20.2h3.6" {...stroke} />
        </>
      ) : (
        <>
          <circle cx="14.5" cy="20" r="2" {...eye} />
          <circle cx="21.5" cy="20" r="2" {...eye} />
        </>
      )}
      {detailed && (
        <>
          <ellipse
            cx="9.5"
            cy="28.4"
            rx="2.2"
            ry="1.2"
            fill="var(--color-rose-300)"
            opacity="0.55"
          />
          <ellipse
            cx="26.5"
            cy="28.4"
            rx="2.2"
            ry="1.2"
            fill="var(--color-rose-300)"
            opacity="0.55"
          />
        </>
      )}
    </>
  );
}

/** A little bot per agent. Shape, face and colors come from its persona, so they're stable. */
export const BoardOrb = memo(function BoardOrb({
  threadId,
  size = "md",
  ring = false,
}: {
  threadId: string;
  size?: BoardOrbSize;
  ring?: boolean;
}) {
  const { hue, accentHue, face, shape } = boardPersona(threadId);
  const gradientId = useId();
  const colors = {
    "--bot-top": `oklch(0.88 0.1 ${hue})`,
    "--bot-bottom": `oklch(0.66 0.16 ${accentHue})`,
    "--bot-edge": `oklch(0.5 0.13 ${accentHue})`,
    "--bot-visor": `oklch(0.24 0.04 ${accentHue})`,
    "--bot-eye": `oklch(0.93 0.11 ${hue})`,
  } as CSSProperties;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block shrink-0",
        sizeClass[size],
        ring && "rounded-full bg-background ring-2 ring-background",
      )}
    >
      <svg viewBox="0 0 36 36" className="size-full overflow-visible" style={colors}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--bot-top)" />
            <stop offset="1" stopColor="var(--bot-bottom)" />
          </linearGradient>
        </defs>
        <Body shape={shape} fill={`url(#${gradientId})`} />
        <ellipse
          cx="12"
          cy="10.5"
          rx="4.5"
          ry="2.2"
          fill="var(--color-white)"
          opacity="0.45"
          transform="rotate(-24 12 10.5)"
        />
        <Face face={face} detailed={size !== "xs"} />
      </svg>
    </span>
  );
});
