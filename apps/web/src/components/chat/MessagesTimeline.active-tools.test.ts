import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveMessagesTimelineRows,
  liveWorkEntryLabel,
  workEntryDisplayLabel,
} from "./MessagesTimeline.logic";

describe("long active tool groups", () => {
  it.each([false, true])(
    "preserves chronological order and the latest activity, expanded=%s",
    (expanded) => {
      const runId = RunId.make("long-active-run");
      const createdAt = "2026-10-12T00:00:00Z";
      const timelineEntries = Array.from({ length: 1_000 }, (_, index) => ({
        id: `work-entry-${index}`,
        kind: "work" as const,
        createdAt,
        entry: {
          id: `work-${index}`,
          createdAt,
          runId,
          label: `Tool ${index}`,
          tone: index % 2 === 0 ? ("thinking" as const) : ("tool" as const),
          itemType: index % 2 === 0 ? ("reasoning" as const) : ("command_execution" as const),
          ...(index % 2 === 0 ? { detail: `Thought ${index}` } : {}),
          toolLifecycleStatus: index === 999 ? ("inProgress" as const) : ("completed" as const),
        },
      }));
      const rows = deriveMessagesTimelineRows({
        timelineEntries,
        isWorking: true,
        runningRunId: runId,
        activeTurnStartedAt: createdAt,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        expandedWorkGroupIds: new Set(expanded ? ["work-group:work-entry-0"] : []),
      });
      const live = rows.find((row) => row.kind === "work-live");
      expect(live).toBeDefined();
      expect(live?.entry.id).toBe("work-999");
      expect(live && liveWorkEntryLabel(live.entry, undefined, live.active)).toContain("999");
      expect(live?.thought?.id).toBe("work-998");
      expect(live?.groupedEntries.map(({ id }) => id)).toEqual(
        timelineEntries.map(({ entry }) => entry.id),
      );
      expect(live?.groupId).toBe("work-group:work-entry-0");
      const details = rows.filter((row) => row.kind === "work");
      expect(details).toHaveLength(expanded ? 1 : 0);
      if (expanded) {
        expect(details[0]?.groupedEntries).toEqual(live?.groupedEntries);
      }
    },
  );
});

describe("file action row labels", () => {
  it("puts the action and basename before provider detail", () => {
    const entry = {
      id: "edit-row",
      createdAt: "2026-10-24T00:00:00Z",
      label: "Edited files",
      detail: "A long provider description of the completed edit",
      tone: "tool" as const,
      itemType: "file_change" as const,
      toolLifecycleStatus: "completed" as const,
      changedFiles: ["C:\\project\\src\\SectionRail.luau"],
      toolData: {
        type: "file_change",
        changes: [{ operation: "edit", path: "C:\\project\\src\\SectionRail.luau" }],
      },
    };

    expect(workEntryDisplayLabel(entry, "C:\\project")).toBe("Edited SectionRail.luau");
  });

  it("keeps the active edit label truthful", () => {
    const entry = {
      id: "active-edit-row",
      createdAt: "2026-10-24T00:00:00Z",
      label: "Edited files",
      tone: "tool" as const,
      itemType: "file_change" as const,
      toolLifecycleStatus: "inProgress" as const,
      changedFiles: ["src/FileName.js"],
      toolData: {
        type: "file_change",
        changes: [{ operation: "edit", path: "src/FileName.js" }],
      },
    };

    expect(liveWorkEntryLabel(entry, "/project", true)).toBe("Editing FileName.js");
  });
});
