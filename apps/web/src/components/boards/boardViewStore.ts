import { arrayMove } from "@dnd-kit/sortable";
import type { BoardAuthor, BoardPostId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

/** An open discussion. Keeps what its tab shows, since closed-over discussions aren't loaded. */
export interface BoardTab {
  rootId: BoardPostId;
  channelName: string;
  title: string;
  author: BoardAuthor;
}

export function upsertBoardTab(tabs: readonly BoardTab[], tab: BoardTab): readonly BoardTab[] {
  const index = tabs.findIndex((item) => item.rootId === tab.rootId);
  if (index === -1) return [...tabs, tab];
  const current = tabs[index]!;
  if (current.title === tab.title && current.channelName === tab.channelName) return tabs;
  return tabs.with(index, tab);
}

export function moveBoardTab(
  tabs: readonly BoardTab[],
  rootId: BoardPostId,
  toIndex: number,
): readonly BoardTab[] {
  const index = tabs.findIndex((item) => item.rootId === rootId);
  return index === -1 || index === toIndex ? tabs : arrayMove([...tabs], index, toIndex);
}

/** The tab to show once `rootId` closes: the one that slides into its place, else the one before. */
export function boardTabAfterClosing(tabs: readonly BoardTab[], rootId: BoardPostId) {
  const index = tabs.findIndex((item) => item.rootId === rootId);
  return index === -1 ? null : (tabs[index + 1] ?? tabs[index - 1] ?? null);
}

interface BoardViewStoreState {
  tabsByBoard: Record<string, readonly BoardTab[]>;
  collapsedChannelsByBoard: Record<string, readonly string[]>;
  openTab: (boardKey: string, tab: BoardTab) => void;
  closeTab: (boardKey: string, rootId: BoardPostId) => void;
  moveTab: (boardKey: string, rootId: BoardPostId, toIndex: number) => void;
  toggleChannel: (boardKey: string, channelName: string) => void;
}

const noTabs: readonly BoardTab[] = [];
const noChannels: readonly string[] = [];

export const selectBoardTabs = (boardKey: string | null) => (state: BoardViewStoreState) =>
  boardKey === null ? noTabs : (state.tabsByBoard[boardKey] ?? noTabs);

export const selectCollapsedChannels = (boardKey: string | null) => (state: BoardViewStoreState) =>
  boardKey === null ? noChannels : (state.collapsedChannelsByBoard[boardKey] ?? noChannels);

export const useBoardViewStore = create<BoardViewStoreState>()(
  persist(
    (set) => {
      const updateTabs = (
        boardKey: string,
        update: (tabs: readonly BoardTab[]) => readonly BoardTab[],
      ) =>
        set((state) => {
          const tabs = state.tabsByBoard[boardKey] ?? noTabs;
          const next = update(tabs);
          return next === tabs
            ? state
            : { tabsByBoard: { ...state.tabsByBoard, [boardKey]: next } };
        });
      return {
        tabsByBoard: {},
        collapsedChannelsByBoard: {},
        openTab: (boardKey, tab) => updateTabs(boardKey, (tabs) => upsertBoardTab(tabs, tab)),
        closeTab: (boardKey, rootId) =>
          updateTabs(boardKey, (tabs) => tabs.filter((tab) => tab.rootId !== rootId)),
        moveTab: (boardKey, rootId, toIndex) =>
          updateTabs(boardKey, (tabs) => moveBoardTab(tabs, rootId, toIndex)),
        toggleChannel: (boardKey, channelName) =>
          set((state) => {
            const collapsed = state.collapsedChannelsByBoard[boardKey] ?? noChannels;
            return {
              collapsedChannelsByBoard: {
                ...state.collapsedChannelsByBoard,
                [boardKey]: collapsed.includes(channelName)
                  ? collapsed.filter((name) => name !== channelName)
                  : [...collapsed, channelName],
              },
            };
          }),
      };
    },
    {
      name: "t3code:board-view:v2",
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);
