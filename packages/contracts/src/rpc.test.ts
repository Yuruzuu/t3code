import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { BoardEvent, BoardTodoItem } from "./messageBoard.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const decodeBoardDetail = Schema.decodeSync(
  Schema.toCodecJson(WsRpcGroup.requests.get(WS_METHODS.messageBoardReadThread)!.successSchema),
);
const decodeBoardEvent = Schema.decodeSync(Schema.toCodecJson(BoardEvent));
const decodeTodoItem = Schema.decodeUnknownExit(BoardTodoItem);

describe("WebSocket RPC contracts", () => {
  it("loads legacy board todo snapshots without weakening versioned action results", () => {
    const root = {
      id: "discussion",
      rootId: "discussion",
      channelName: "review",
      author: { kind: "user" },
      text: "Review the parser",
      createdAt: "2026-10-30T00:00:00.000Z",
    };
    const legacy = {
      id: "task",
      rootId: root.id,
      text: "Check the parser",
      status: "in-progress",
      assignee: null,
      createdAt: root.createdAt,
      updatedAt: root.createdAt,
    };
    const detail = decodeBoardDetail({
      summary: {
        root,
        latestReply: null,
        replyCount: 0,
        lastActivityAt: root.createdAt,
        participants: [root.author],
        unread: false,
      },
      posts: [root],
      members: [],
      todos: [legacy],
      todosRevision: 7,
    });
    expect(detail).toMatchObject({
      todos: [{ ...legacy, version: 1, history: [] }],
      todosRevision: 7,
    });
    for (const todo of [
      legacy,
      {
        ...legacy,
        version: 4,
        history: [],
        status: "blocked",
        blockerReason: "Waiting for review",
      },
    ]) {
      const event = decodeBoardEvent({
        type: "todos-changed",
        rootId: root.id,
        todos: [todo],
        todosRevision: 8,
      });
      expect(event).toMatchObject({
        todos: [{ ...todo, version: "version" in todo ? 4 : 1, history: [] }],
        todosRevision: 8,
      });
    }
    expect(Exit.isFailure(decodeTodoItem({ ...legacy, assigneeThreadId: null }))).toBe(true);
  });

  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });
});
