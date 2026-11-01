import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { boardAgentActivity } from "./boardActivity";

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 28, 0, minute));
const shell = (overrides: Partial<Parameters<typeof boardAgentActivity>[0]> = {}) => ({
  status: "running" as const,
  pendingRuntimeRequest: null,
  blockedOnThreadWait: false,
  latestVisibleMessage: null,
  activityRunStartedAt: at(1),
  activeRunId: null,
  ...overrides,
});
const said = (text: string, minute: number) => ({
  id: "message" as never,
  role: "assistant" as const,
  text,
  updatedAt: at(minute),
});

describe("boardAgentActivity", () => {
  it("is null for idle agents and names start-up and blocked states", () => {
    expect(boardAgentActivity(shell({ status: "idle" }))).toBeNull();
    expect(boardAgentActivity(shell({ status: "queued" }))).toBe("Starting up");
    expect(boardAgentActivity(shell({ blockedOnThreadWait: true }))).toBe(
      "Waiting on another agent",
    );
  });

  it("uses the first line the agent said this run, cleaned and bounded", () => {
    expect(
      boardAgentActivity(
        shell({ latestVisibleMessage: said("## Searching for updates…\nmore", 2) }),
      ),
    ).toBe("Searching for updates");
    expect(
      boardAgentActivity(shell({ latestVisibleMessage: said("x".repeat(80), 2) })),
    ).toHaveLength(60);
  });

  it("ignores a message from an earlier run", () => {
    expect(boardAgentActivity(shell({ latestVisibleMessage: said("Old news", 0) }))).toBe(
      "Working",
    );
  });

  it("prefers the latest nonempty thinking trace from the active run", () => {
    const reasoning = (text: string, runId = "current") =>
      ({ item: { type: "reasoning", text, runId } }) as never;
    const current = shell({
      activeRunId: "current" as never,
      latestVisibleMessage: said("Commentary", 2),
    });
    const items = [
      reasoning("Earlier thought"),
      reasoning("## Checking the layout…\nDetails"),
      reasoning(""),
      reasoning("Stale thought", "previous"),
    ];
    expect(boardAgentActivity(current, items)).toBe("Checking the layout");
    expect(boardAgentActivity(current, [reasoning("Old", "previous")])).toBe("Commentary");
    expect(boardAgentActivity(shell({ ...current, blockedOnThreadWait: true }), items)).toBe(
      "Waiting on another agent",
    );
  });
});
