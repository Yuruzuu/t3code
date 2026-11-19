import type { BoardAuthor, BoardPost, BoardResponsibility } from "@t3tools/contracts";
import { msg, T, useGT, useLocale, useMessages } from "gt-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { boardAuthorName } from "./BoardPrimitives";
import type { BoardsViewModel } from "./boardsViewModel";

type Agent = Extract<BoardAuthor, { kind: "agent" }>;

const statusLabels = {
  pending: msg("Pending"),
  queued: msg("Queued"),
  running: msg("Handling"),
  held: msg("Paused"),
  completed: msg("Handled"),
  "needs-attention": msg("Needs attention"),
} satisfies Record<BoardResponsibility["status"], ReturnType<typeof msg>>;

const availabilityLabels = {
  "parent-stopped": msg("Parent stopped"),
  stopped: msg("Stopped"),
  archived: msg("Recipient archived"),
  deleted: msg("Recipient deleted"),
  missing: msg("Recipient not found"),
  unavailable: msg("Recipient unavailable"),
};

const availabilityDescriptions = {
  "parent-stopped": msg("The recipient's parent is stopped."),
  stopped: msg("Recipient stopped."),
  archived: msg("Recipient archived."),
  deleted: msg("Recipient deleted."),
  missing: msg("Recipient missing."),
  unavailable: msg("Recipient unavailable."),
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
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
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
        <T>No participant is currently available. Your message is saved.</T>
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
        cause instanceof Error
          ? cause.message
          : gt("The request changed. Review it and try again."),
      );
    }
    setPending(false);
  };
  const counts = new Map<string, number>();
  for (const request of requests) {
    const label =
      request.availabilityReason !== undefined
        ? m(availabilityLabels[request.availabilityReason])
        : request.recipientThreadId === null
          ? gt("Needs assignment")
          : m(statusLabels[request.status]);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return (
    <details className="text-2xs text-muted-foreground">
      <summary className="cursor-pointer">
        {[...counts]
          .map(([label, count]) =>
            gt("{count} {status}", {
              count,
              status: label.toLocaleLowerCase(locale),
            }),
          )
          .join(" · ")}
      </summary>
      <ul className="mt-2 space-y-2">
        {requests.map((request) => {
          const recipient = agents.find((agent) => agent.threadId === request.recipientThreadId);
          return (
            <li key={request.id} className="flex flex-wrap items-center gap-2">
              <span>
                {request.recipientThreadId === null
                  ? gt("Needs assignment")
                  : gt("{recipient} · {status}", {
                      recipient: recipient
                        ? boardAuthorName(recipient, m)
                        : request.recipientThreadId,
                      status: m(statusLabels[request.status]),
                    })}
              </span>
              {request.outcome && <span>{request.outcome.text}</span>}
              {request.availabilityReason && (
                <span>{m(availabilityDescriptions[request.availabilityReason])}</span>
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
                        <T>Resume this request</T>
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
                        aria-label={gt("Reassign this request to")}
                        defaultValue={request.recipientThreadId ?? ""}
                        disabled={pending || !model.isConnected}
                        className="max-w-40 rounded border border-border bg-background p-1"
                      >
                        {!recipient && (
                          <option value={request.recipientThreadId ?? ""}>
                            {request.recipientThreadId ?? gt("Select an agent")}
                          </option>
                        )}
                        {agents.map((agent) => (
                          <option key={agent.threadId} value={agent.threadId}>
                            {boardAuthorName(agent, m)} · {agent.title || agent.threadId}
                          </option>
                        ))}
                      </select>
                      <Button
                        type="submit"
                        variant="ghost"
                        size="xs"
                        disabled={pending || !model.isConnected}
                      >
                        {request.recipientThreadId === null
                          ? gt("Assign request")
                          : gt("Reassign request")}
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
  const gt = useGT();
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
        cause instanceof Error
          ? cause.message
          : gt("The discussion changed. Review it and try again."),
      );
    }
    setPending(false);
  };
  return (
    <div className="mt-3 space-y-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {handling.lifecycle === "closed"
            ? gt("Closed", { $context: "Discussion state" })
            : gt("Open", { $context: "Discussion state" })}
        </span>
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
            {handling.lifecycle === "closed" ? gt("Reopen discussion") : gt("Close discussion")}
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
