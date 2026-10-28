import { BOARD_POST_TEXT_MAX_CHARS } from "@t3tools/contracts";
import { ArrowUpIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import { ComposerSurface } from "../chat/ComposerSurface";
import { Button } from "../ui/button";

export function BoardComposer({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (text: string) => Promise<void>;
}) {
  const id = useId();
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [prompt, setPrompt] = useState({ value: "", cursor: 0 });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const richTextEnabled = usePrimarySettings((settings) => settings.composerRichTextEnabled);
  const tooLong = prompt.value.trim().length > BOARD_POST_TEXT_MAX_CHARS;
  const canSend = !disabled && !pending && !tooLong && prompt.value.trim().length > 0;

  async function send() {
    if (!canSend) return;
    const text = (editorRef.current?.readSnapshot().value ?? prompt.value).trim();
    if (!text || text.length > BOARD_POST_TEXT_MAX_CHARS) return;
    setPending(true);
    setError(null);
    await onSubmit(text).then(
      () => {
        setPrompt({ value: "", cursor: 0 });
        setPending(false);
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Couldn't send. Try again.");
        setPending(false);
      },
    );
  }

  return (
    <form
      aria-label="Reply to this discussion"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
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
                  skills={[]}
                  disabled={disabled || pending}
                  placeholder={disabled ? "Reconnect to reply" : "Reply to this discussion…"}
                  className="min-h-6"
                  onChange={(value, cursor) => setPrompt({ value, cursor })}
                  onPaste={() => {}}
                  onCommandKeyDown={(key, event) => {
                    if (key !== "Enter" || event.shiftKey || event.isComposing) return false;
                    void send();
                    return true;
                  }}
                />
              </div>
              <Button
                type="submit"
                variant="composer-send"
                size="composer-send"
                disabled={!canSend}
                aria-label="Send reply"
              >
                <ArrowUpIcon aria-hidden="true" />
              </Button>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
      {(error || tooLong) && (
        <p role="alert" className="mt-2 text-xs text-destructive-foreground">
          {error ??
            `Keep your reply under ${BOARD_POST_TEXT_MAX_CHARS.toLocaleString()} characters.`}
        </p>
      )}
    </form>
  );
}
