import { BOARD_POST_TEXT_MAX_CHARS, type BoardAuthor, type BoardPost } from "@t3tools/contracts";
import { ArrowUpIcon, CornerUpLeftIcon, XIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { collectBoardMentions } from "@t3tools/shared/boardMentions";

import { usePrimarySettings } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import { ComposerSurface } from "../chat/ComposerSurface";
import { Button } from "../ui/button";
import {
  BoardAuthorAvatar,
  BoardAuthorLabel,
  boardAuthorName,
  boardPostExcerpt,
} from "./BoardPrimitives";
import { BoardMentionLabel } from "./BoardMentionLabel";
import { boardMentionQuery, insertBoardMention } from "./boardComposerMentions";

type AgentAuthor = Extract<BoardAuthor, { kind: "agent" }>;

const MAX_SUGGESTIONS = 5;

export function BoardComposer({
  disabled,
  closed = false,
  agents,
  replyTo,
  onCancelReply,
  onSubmit,
}: {
  disabled: boolean;
  closed?: boolean;
  /** Agents offered when you type `@`. */
  agents: readonly AgentAuthor[];
  replyTo: BoardPost | null;
  onCancelReply: () => void;
  onSubmit: (
    text: string,
    requestKey: string,
    mode: "request" | "note" | "reopen-and-send",
  ) => Promise<void>;
}) {
  const id = useId();
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const pendingRequest = useRef<{
    text: string;
    replyToId: string | undefined;
    key: string;
    mode: string;
  } | null>(null);
  const [prompt, setPrompt] = useState({ value: "", cursor: 0, suppressMentionQuery: false });
  const [error, setError] = useState<string | null>(null);
  const richTextEnabled = usePrimarySettings((settings) => settings.composerRichTextEnabled);
  const tooLong = prompt.value.trim().length > BOARD_POST_TEXT_MAX_CHARS;
  const canSend = !disabled && !tooLong && prompt.value.trim().length > 0;
  const query = boardMentionQuery(prompt.value, prompt.cursor, prompt.suppressMentionQuery);
  const renderMention = (path: string) => {
    const mention = collectBoardMentions(`@${path}`)[0];
    const matches = agents.filter((candidate) =>
      mention?.threadId === undefined
        ? boardAuthorName(candidate).toLowerCase() === path.toLowerCase()
        : candidate.threadId === mention.threadId,
    );
    const agent = matches.length === 1 ? matches[0] : undefined;
    return agent ? (
      <BoardMentionLabel threadId={agent.threadId} label={`@${boardAuthorName(agent)}`} />
    ) : null;
  };
  const suggestions =
    query === undefined
      ? []
      : agents
          .filter((agent) => boardAuthorName(agent).toLowerCase().startsWith(query))
          .slice(0, MAX_SUGGESTIONS);

  function insertMention(agent: AgentAuthor) {
    const next = insertBoardMention(
      prompt.value,
      prompt.cursor,
      boardAuthorName(agent),
      agent.threadId,
    );
    setPrompt(next);
    requestAnimationFrame(() => editorRef.current?.focusAt(next.cursor));
  }

  function send(
    mode: "request" | "note" | "reopen-and-send" = closed ? "reopen-and-send" : "request",
  ) {
    if (!canSend) return;
    const text = (editorRef.current?.readSnapshot().value ?? prompt.value).trim();
    if (!text || text.length > BOARD_POST_TEXT_MAX_CHARS) return;
    setError(null);
    if (
      pendingRequest.current?.text !== text ||
      pendingRequest.current.replyToId !== replyTo?.id ||
      pendingRequest.current.mode !== mode
    ) {
      pendingRequest.current = { text, replyToId: replyTo?.id, key: randomUUID(), mode };
    }
    const request = pendingRequest.current;
    // The request stays open while the server picks a responder, which can take seconds.
    setPrompt({ value: "", cursor: 0, suppressMentionQuery: false });
    void onSubmit(text, request.key, mode).then(
      () => {
        if (pendingRequest.current === request) pendingRequest.current = null;
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Couldn't send. Try again.");
        setPrompt((current) => {
          const value = current.value.trim() ? `${text}\n\n${current.value}` : text;
          return { value, cursor: value.length, suppressMentionQuery: false };
        });
      },
    );
  }

  return (
    <form
      aria-label="Reply to this discussion"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      {suggestions.length > 0 && (
        <ul
          aria-label="Mention an agent"
          className="mb-2 w-full min-w-0 rounded-lg border border-border bg-popover p-1 shadow-md"
        >
          {suggestions.map((agent) => (
            <li key={agent.threadId}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMention(agent)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
              >
                <BoardAuthorAvatar author={agent} size="xs" />
                <span className="shrink-0 font-medium">
                  <BoardAuthorLabel author={agent} />
                </span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {agent.title}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            {replyTo && (
              <div className="flex min-w-0 items-center gap-1.5 border-b border-border/60 py-1.5 pr-1.5 pl-4 text-xs text-muted-foreground">
                <CornerUpLeftIcon aria-hidden="true" className="size-3 shrink-0" />
                <span className="shrink-0">Replying to</span>
                <span className="shrink-0 font-medium text-foreground/90">
                  <BoardAuthorLabel author={replyTo.author} />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {boardPostExcerpt(replyTo.text, { includeFirstLine: true })}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Cancel reply"
                  onClick={onCancelReply}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </div>
            )}
            <div className="flex items-center gap-2 py-2 pr-2 pl-4">
              <div className="min-w-0 flex-1">
                <ComposerPromptEditor
                  draftKey={id}
                  editorRef={editorRef}
                  ariaLabel="Reply"
                  value={prompt.value}
                  cursor={prompt.cursor}
                  richTextEnabled={richTextEnabled}
                  contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
                  renderMention={renderMention}
                  isPathQueryActive={() => suggestions.length > 0}
                  skills={[]}
                  disabled={disabled}
                  placeholder={
                    disabled ? "Reconnect to reply" : "Reply to this discussion… @ to mention"
                  }
                  className="min-h-6"
                  onChange={(value, cursor, _expandedCursor, suppressMentionQuery) =>
                    setPrompt({ value, cursor, suppressMentionQuery })
                  }
                  onPaste={() => {}}
                  onCommandKeyDown={(key, event) => {
                    if (key !== "Enter" || event.shiftKey || event.isComposing) return false;
                    if (suggestions[0]) {
                      insertMention(suggestions[0]);
                      return true;
                    }
                    send();
                    return true;
                  }}
                />
              </div>
              {!closed && (
                <Button
                  type="submit"
                  variant="composer-send"
                  size="composer-send"
                  disabled={!canSend}
                  aria-label="Send reply"
                >
                  <ArrowUpIcon aria-hidden="true" />
                </Button>
              )}
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
      {closed && (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Button type="submit" variant="outline" size="xs" disabled={!canSend}>
            Reopen and send
          </Button>
          <Button variant="ghost" size="xs" disabled={!canSend} onClick={() => send("note")}>
            Add note
          </Button>
        </div>
      )}
      {(error || tooLong) && (
        <p role="alert" className="mt-2 text-xs text-destructive-foreground">
          {error ??
            `Keep your reply under ${BOARD_POST_TEXT_MAX_CHARS.toLocaleString()} characters.`}
        </p>
      )}
    </form>
  );
}
