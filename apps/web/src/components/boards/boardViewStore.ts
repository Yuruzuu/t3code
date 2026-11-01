import { arrayMove } from "@dnd-kit/sortable";
import type { BoardAuthor, BoardPostId, EnvironmentId } from "@t3tools/contracts";
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
  tabsByEnvironment: Record<string, readonly BoardTab[]>;
  collapsedChannelsByEnvironment: Record<string, readonly string[]>;
  openTab: (environmentId: EnvironmentId, tab: BoardTab) => void;
  closeTab: (environmentId: EnvironmentId, rootId: BoardPostId) => void;
  moveTab: (environmentId: EnvironmentId, rootId: BoardPostId, toIndex: number) => void;
  toggleChannel: (environmentId: EnvironmentId, channelName: string) => void;
}

const noTabs: readonly BoardTab[] = [];
const noChannels: readonly string[] = [];

export const selectBoardTabs =
  (environmentId: EnvironmentId | null) => (state: BoardViewStoreState) =>
    environmentId === null ? noTabs : (state.tabsByEnvironment[environmentId] ?? noTabs);

export const selectCollapsedChannels =
  (environmentId: EnvironmentId | null) => (state: BoardViewStoreState) =>
    environmentId === null
      ? noChannels
      : (state.collapsedChannelsByEnvironment[environmentId] ?? noChannels);

export const useBoardViewStore = create<BoardViewStoreState>()(
  persist(
    (set) => {
      const updateTabs = (
        environmentId: EnvironmentId,
        update: (tabs: readonly BoardTab[]) => readonly BoardTab[],
      ) =>
        set((state) => {
          const tabs = state.tabsByEnvironment[environmentId] ?? noTabs;
          const next = update(tabs);
          return next === tabs
            ? state
            : { tabsByEnvironment: { ...state.tabsByEnvironment, [environmentId]: next } };
        });
      return {
        tabsByEnvironment: {},
        collapsedChannelsByEnvironment: {},
        openTab: (environmentId, tab) =>
          updateTabs(environmentId, (tabs) => upsertBoardTab(tabs, tab)),
        closeTab: (environmentId, rootId) =>
          updateTabs(environmentId, (tabs) => tabs.filter((tab) => tab.rootId !== rootId)),
        moveTab: (environmentId, rootId, toIndex) =>
          updateTabs(environmentId, (tabs) => moveBoardTab(tabs, rootId, toIndex)),
        toggleChannel: (environmentId, channelName) =>
          set((state) => {
            const collapsed = state.collapsedChannelsByEnvironment[environmentId] ?? noChannels;
            return {
              collapsedChannelsByEnvironment: {
                ...state.collapsedChannelsByEnvironment,
                [environmentId]: collapsed.includes(channelName)
                  ? collapsed.filter((name) => name !== channelName)
                  : [...collapsed, channelName],
              },
            };
          }),
      };
    },
    {
      name: "t3code:board-view:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);
