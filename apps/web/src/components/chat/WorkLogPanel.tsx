import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/** One bordered card; its sections stack with hairline dividers instead of separate boxes. */
export function WorkLogCard({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0 divide-y divide-foreground/10 overflow-hidden rounded-lg border border-foreground/15 bg-foreground/[0.06]">
      {children}
    </div>
  );
}

export function WorkLogSection({
  label,
  trailing,
  inset = false,
  dense = false,
  children,
}: {
  label?: string;
  trailing?: ReactNode;
  /** Recessed background for output, so it reads apart from the input above it. */
  inset?: boolean;
  /** Title bars hold one line, so they skip the body's vertical padding. */
  dense?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0 px-3", dense ? "py-0.5" : "py-2", inset && "bg-background/45")}>
      {label || trailing ? (
        <div className="mb-1 flex min-h-5 items-center justify-between gap-2">
          {label ? <span className="text-2xs text-muted-foreground">{label}</span> : <span />}
          {trailing}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function WorkLogPanel({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <WorkLogCard>
      <WorkLogSection {...(label ? { label } : {})}>{children}</WorkLogSection>
    </WorkLogCard>
  );
}
