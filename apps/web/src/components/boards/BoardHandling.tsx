import type { BoardAuthor, BoardPost, BoardResponsibility } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../ui/button";
import { boardAuthorName } from "./BoardPrimitives";
import type { BoardsViewModel } from "./boardsViewModel";

type Agent = Extract<BoardAuthor, { kind: "agent" }>;

const statusLabels: Record<BoardResponsibility["status"], string> = {
  pending: "Pending",
  queued: "Queued",
  running: "Handling",
  held: "Paused",
  completed: "Handled",
  "needs-attention": "Needs attention",
};

export function BoardHandlingLine({
  post,
  model,
  agents,
}: {
  post: BoardPost;
  model: BoardsViewModel;
  agents: readonly Agent[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (post.author.kind !== "user" || model.thread?.handling === undefined) return null;
  const postRequests = model.thread.handling.responsibilities.filter(
    (request) => request.postId === post.id,
  );
  const requests = postRequests.filter(
    (request) => request.status === "held" || request.status === "needs-attention",
  );
  if (postRequests.length > 0 && requests.length === 0) return null;
  const selection = model.thread.handling.selections?.find((item) =>
    item.sourcePostIds.includes(post.id),
  );
  if (requests.length === 0 && selection?.status === "unavailable")
    return (
      <span role="status" className="text-2xs text-muted-foreground">
        No participant is currently available. Your message is saved.
      </span>
    );
  if (requests.length === 0) return null;
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The request changed. Review it and try again.",
      );
    } finally {
      setPending(false);
    }
  };
  const counts = new Map<string, number>();
  for (const request of requests) {
    const label =
      request.availabilityReason === "parent-stopped"
        ? "Parent stopped"
        : request.availabilityReason === "stopped"
          ? "Stopped"
          : request.availabilityReason === "archived"
            ? "Recipient archived"
            : request.availabilityReason === "deleted"
              ? "Recipient deleted"
              : request.availabilityReason === "missing"
                ? "Recipient not found"
                : request.availabilityReason === "unavailable"
                  ? "Recipient unavailable"
                  : request.recipientThreadId === null
                    ? "Needs assignment"
                    : statusLabels[request.status];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return (
    <details className="text-2xs text-muted-foreground">
      <summary className="cursor-pointer">
        {[...counts].map(([label, count]) => `${count} ${label.toLowerCase()}`).join(" · ")}
      </summary>
      <ul className="mt-2 space-y-2">
        {requests.map((request) => {
          const recipient = agents.find((agent) => agent.threadId === request.recipientThreadId);
          return (
            <li key={request.id} className="flex flex-wrap items-center gap-2">
              <span>
                {request.recipientThreadId === null
                  ? "Needs assignment"
                  : `${recipient ? boardAuthorName(recipient) : request.recipientThreadId} · ${statusLabels[request.status]}`}
              </span>
              {request.outcome && <span>{request.outcome.text}</span>}
              {request.availabilityReason && (
                <span>
                  {request.availabilityReason === "parent-stopped"
                    ? "The recipient's parent is stopped."
                    : `Recipient ${request.availabilityReason}.`}
                </span>
              )}
              {model.canManageHandling && request.status !== "completed" && (
                <>
                  {request.recipientThreadId !== null &&
                    (request.status === "held" || request.status === "needs-attention") && (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={pending || !model.isConnected}
                        onClick={() => void run(() => model.onResumeRequest(request))}
                      >
                        Resume this request
                      </Button>
                    )}
                  {request.selectionId === undefined && (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const recipientThreadId = agents.find(
                          (agent) =>
                            agent.threadId === new FormData(event.currentTarget).get("recipient"),
                        )?.threadId;
                        if (recipientThreadId)
                          void run(() => model.onReassignRequest(request, recipientThreadId));
                      }}
                      className="flex items-center gap-1"
                    >
                      <select
                        name="recipient"
                        aria-label="Reassign this request to"
                        defaultValue={request.recipientThreadId ?? ""}
                        disabled={pending || !model.isConnected}
                        className="max-w-40 rounded border border-border bg-background p-1"
                      >
                        {!recipient && (
                          <option value={request.recipientThreadId ?? ""}>
                            {request.recipientThreadId ?? "Select an agent"}
                          </option>
                        )}
                        {agents.map((agent) => (
                          <option key={agent.threadId} value={agent.threadId}>
                            {boardAuthorName(agent)} · {agent.title || agent.threadId}
                          </option>
                        ))}
                      </select>
                      <Button
                        type="submit"
                        variant="ghost"
                        size="xs"
                        disabled={pending || !model.isConnected}
                      >
                        {request.recipientThreadId === null ? "Assign request" : "Reassign request"}
                      </Button>
                    </form>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="mt-1 text-destructive-foreground">
          {error}
        </p>
      )}
    </details>
  );
}

export function BoardHandlingControls({
  model,
}: {
  model: BoardsViewModel;
  agents: readonly Agent[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const handling = model.thread?.handling;
  if (!handling) return null;
  const run = async (action: () => Promise<void>) => {
    setError(null);
    setPending(true);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The discussion changed. Review it and try again.",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="mt-3 space-y-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span>{handling.lifecycle === "closed" ? "Closed" : "Open"}</span>
        {model.canManageHandling && (
          <Button
            variant="ghost"
            size="xs"
            disabled={pending || !model.isConnected}
            onClick={() =>
              void run(
                handling.lifecycle === "closed"
                  ? model.onReopenDiscussion
                  : model.onCloseDiscussion,
              )
            }
          >
            {handling.lifecycle === "closed" ? "Reopen discussion" : "Close discussion"}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      )}
    </div>
  );
}
