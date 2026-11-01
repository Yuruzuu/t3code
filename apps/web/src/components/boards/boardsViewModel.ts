import type {
  BoardAuthor,
  BoardResponsibility,
  BoardHandlingContext,
  BoardChannel,
  MessageBoardPostInput,
  BoardPostId,
  BoardThreadDetail,
  BoardThreadSort,
  BoardThreadSummary,
  EnvironmentId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

import type { BoardTab } from "./boardViewStore";

/** An agent with a running turn, and what it is doing right now. */
export interface BoardWorker {
  author: Extract<BoardAuthor, { kind: "agent" }>;
  activity: string;
}

export interface BoardsViewModel {
  environmentId: EnvironmentId | null;
  channels: readonly BoardChannel[] | null;
  selectedChannelName: string | null;
  threads: readonly BoardThreadSummary[] | null;
  threadSort: BoardThreadSort;
  onChangeThreadSort: (sort: BoardThreadSort) => void;
  hasMoreThreads: boolean;
  onLoadMoreThreads: () => Promise<void>;
  selectedRootId: BoardPostId | null;
  /** The open discussion; while it loads, a preview built from the list row. */
  thread: BoardThreadDetail | null;
  threadPending: boolean;
  threadError: string | null;
  hasOlderPosts: boolean;
  loadingOlderPosts: boolean;
  onLoadOlderPosts: () => void;
  onSelectChannel: (name: string) => void;
  /** Opens a discussion; `channelName` is for callers outside the selected channel. */
  onSelectThread: (rootId: BoardPostId, channelName?: string) => void;
  onCloseThread: () => void;
  tabs: readonly BoardTab[];
  onSelectTab: (tab: BoardTab) => void;
  onCloseTab: (rootId: BoardPostId) => void;
  onMoveTab: (rootId: BoardPostId, toIndex: number) => void;
  collapsedChannels: readonly string[];
  onToggleChannel: (channelName: string) => void;
  onShowAllChannels: () => void;
  onMarkChannelRead: (channelName: string) => Promise<void>;
  onPost: (input: typeof MessageBoardPostInput.Type) => Promise<void>;
  handlingAgents: readonly Extract<BoardAuthor, { kind: "agent" }>[];
  canManageHandling: boolean;
  onAssignLead: (threadId: ThreadId | null) => Promise<void>;
  onUpdateContext: (context: typeof BoardHandlingContext.Type) => Promise<void>;
  onReassignRequest: (request: BoardResponsibility, recipientThreadId: ThreadId) => Promise<void>;
  onResumeRequest: (request: BoardResponsibility) => Promise<void>;
  onCloseDiscussion: () => Promise<void>;
  onReopenDiscussion: () => Promise<void>;
  onReact: (postId: BoardPostId, emoji: string, active: boolean) => void;
  onOpenAgentThread: (author: BoardAuthor) => void;
  /** Opens the agent's thread with the diff of one of its runs. */
  onOpenRunChanges: (threadId: ThreadId, runId: RunId, filePath?: string) => void;
  /** Re-reads the open discussion, such as when an agent's run ends and its changes land. */
  onRefreshThread: () => void;
  isAgentThreadRunning: (threadId: ThreadId) => boolean;
  /** What a working agent is doing, or null when it is idle. */
  agentActivity: (threadId: ThreadId) => string | null;
  isConnected: boolean;
  error: string | null;
}
