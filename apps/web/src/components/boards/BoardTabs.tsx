import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { BoardPostId } from "@t3tools/contracts";
import { LayoutGridIcon } from "lucide-react";
import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { PanelTabCloseButton } from "../ui/panel-tab-close-button";
import { BoardAuthorAvatar, BoardUnreadCount } from "./BoardPrimitives";
import { useBoardDiscussionUnreadCount } from "./boardState";
import type { BoardTab } from "./boardViewStore";
import type { BoardsViewModel } from "./boardsViewModel";

const TAB_DRAG_MODIFIERS = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];

// Chromium on Linux only suppresses primary-selection paste when mouseup is cancelled.
function preventMiddleButtonDefault(event: MouseEvent) {
  if (event.button === 1) event.preventDefault();
}

function BoardDiscussionTab({
  tab,
  active,
  environmentId,
  onSelect,
  onClose,
}: {
  tab: BoardTab;
  active: boolean;
  environmentId: BoardsViewModel["environmentId"];
  onSelect: BoardsViewModel["onSelectTab"];
  onClose: BoardsViewModel["onCloseTab"];
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.rootId,
  });
  const unread = useBoardDiscussionUnreadCount(environmentId, tab.rootId);

  return (
    <li
      ref={setNodeRef}
      {...listeners}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onMouseDown={preventMiddleButtonDefault}
      onMouseUp={preventMiddleButtonDefault}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        onClose(tab.rootId);
      }}
      className={cn(
        "group/tab flex h-7 max-w-56 shrink-0 cursor-pointer items-center gap-1 rounded-md pr-2 pl-1.5 text-sm [-webkit-app-region:no-drag]",
        active
          ? "bg-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        isDragging && "relative z-10 bg-accent",
      )}
    >
      <PanelTabCloseButton label={`Close ${tab.title}`} onClick={() => onClose(tab.rootId)}>
        <BoardAuthorAvatar author={tab.author} size="2xs" />
      </PanelTabCloseButton>
      <button
        type="button"
        onClick={() => onSelect(tab)}
        aria-current={active ? "page" : undefined}
        className="flex min-w-0 cursor-pointer items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="truncate">{tab.title}</span>
      </button>
      {!active && unread > 0 && <BoardUnreadCount count={unread} />}
    </li>
  );
}

/** The boards header: home, then every discussion you have open. */
export function BoardTabs({
  model,
  trailing,
}: {
  model: BoardsViewModel;
  /** Controls for the open discussion, kept in the header so they never scroll away. */
  trailing?: ReactNode;
}) {
  const { tabs, selectedRootId, onMoveTab } = model;
  const navRef = useRef<HTMLElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const toIndex = tabs.findIndex((tab) => tab.rootId === over.id);
    if (toIndex >= 0) onMoveTab(active.id as BoardPostId, toIndex);
  };

  const activeIndex = tabs.findIndex((tab) => tab.rootId === selectedRootId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Scrolls the active tab's DOM node into view when another discussion opens.
  useEffect(() => {
    navRef.current
      ?.querySelector("ul")
      ?.children[activeIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeIndex]);

  return (
    <WorkspacePageHeader electron={isElectron} className="gap-2">
      <button
        type="button"
        onClick={model.onShowAllChannels}
        aria-current={selectedRootId === null ? "page" : undefined}
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          selectedRootId === null
            ? "bg-accent font-medium text-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        )}
      >
        <LayoutGridIcon aria-hidden="true" className="size-3.5 opacity-70" />
        All channels
      </button>
      {tabs.length > 0 && <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />}
      <nav
        ref={navRef}
        aria-label="Open discussions"
        className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]"
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={TAB_DRAG_MODIFIERS}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={tabs.map((tab) => tab.rootId)}
            strategy={horizontalListSortingStrategy}
          >
            <ul className="flex w-max items-center gap-0.5">
              {tabs.map((tab) => (
                <BoardDiscussionTab
                  key={tab.rootId}
                  tab={tab}
                  active={tab.rootId === selectedRootId}
                  environmentId={model.environmentId}
                  onSelect={model.onSelectTab}
                  onClose={model.onCloseTab}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </nav>
      {!model.isConnected && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-2xs text-warning-foreground">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
          Offline
        </span>
      )}
      {trailing}
    </WorkspacePageHeader>
  );
}
