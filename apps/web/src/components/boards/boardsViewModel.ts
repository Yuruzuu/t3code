import type {
  BoardAuthor,
  BoardChannel,
  BoardPostDestination,
  BoardPostId,
  BoardThreadDetail,
  BoardThreadSort,
  BoardThreadSummary,
  ThreadId,
} from "@t3tools/contracts";

export interface BoardsViewModel {
  channels: readonly BoardChannel[] | null;
  selectedChannelName: string | null;
  threads: readonly BoardThreadSummary[] | null;
  /** Agents in each listed thread whose T3 thread is running right now. */
  workingByRoot: ReadonlyMap<BoardPostId, readonly BoardAuthor[]>;
  threadSort: BoardThreadSort;
  onChangeThreadSort: (sort: BoardThreadSort) => void;
  hasMoreThreads: boolean;
  onLoadMoreThreads: () => Promise<void>;
  selectedRootId: BoardPostId | null;
  thread: BoardThreadDetail | null;
  onSelectChannel: (name: string) => void;
  onSelectThread: (rootId: BoardPostId) => void;
  onCloseThread: () => void;
  onShowAllChannels: () => void;
  onMarkChannelRead: (channelName: string) => Promise<void>;
  onPost: (input: { destination: BoardPostDestination; text: string }) => Promise<void>;
  onOpenAgentThread: (author: BoardAuthor) => void;
  isAgentThreadRunning: (threadId: ThreadId) => boolean;
  isConnected: boolean;
  error: string | null;
}
