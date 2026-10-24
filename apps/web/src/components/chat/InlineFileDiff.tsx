import { getFiletypeFromFileName } from "@pierre/diffs";
import {
  getFileChangePreview,
  type FileChangePreview,
  type FileChangePreviewLine,
} from "@t3tools/client-runtime/work-log/file-change-preview";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { Suspense, use, type ReactNode } from "react";

import { useRenderedAppearance } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { cn } from "../../lib/utils";
import { RenderErrorBoundary } from "../RenderErrorBoundary";

type Emphasis = { readonly start: number; readonly end: number };
type LineToken = {
  readonly content: string;
  readonly offset: number;
  readonly color?: string | undefined;
};
type Piece = LineToken & { readonly marked: boolean };

/**
 * Pairs each deletion run with the addition run after it, line by line, and marks the span
 * between their common prefix and suffix, so a one-word edit doesn't read as a rewrite.
 */
function emphasisByIndex(lines: ReadonlyArray<FileChangePreviewLine>): Map<number, Emphasis> {
  const emphasis = new Map<number, Emphasis>();
  let index = 0;
  while (index < lines.length) {
    if (lines[index]!.kind !== "deletion") {
      index++;
      continue;
    }
    const deletionStart = index;
    while (lines[index]?.kind === "deletion") index++;
    const additionStart = index;
    while (lines[index]?.kind === "addition") index++;
    const pairs = Math.min(additionStart - deletionStart, index - additionStart);
    for (let offset = 0; offset < pairs; offset++) {
      const before = lines[deletionStart + offset]!.text;
      const after = lines[additionStart + offset]!.text;
      let prefix = 0;
      while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
        prefix++;
      }
      let suffix = 0;
      while (
        suffix < before.length - prefix &&
        suffix < after.length - prefix &&
        before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
      ) {
        suffix++;
      }
      // Lines with nothing in common are a rewrite; highlighting all of it adds no signal.
      if (prefix + suffix === 0) continue;
      emphasis.set(deletionStart + offset, { start: prefix, end: before.length - suffix });
      emphasis.set(additionStart + offset, { start: prefix, end: after.length - suffix });
    }
  }
  return emphasis;
}

function LineText({
  text,
  tokens,
  emphasis,
  kind,
}: {
  text: string;
  tokens: ReadonlyArray<LineToken> | undefined;
  emphasis: Emphasis | undefined;
  kind: FileChangePreviewLine["kind"];
}): ReactNode {
  if (!text) return " ";
  const pieces = (tokens ?? [{ content: text, offset: 0 }]).flatMap((token): Piece[] => {
    const end = token.offset + token.content.length;
    if (!emphasis || emphasis.start >= emphasis.end) return [{ ...token, marked: false }];
    // Split each token at the emphasis edges so colors survive inside the mark.
    const cuts = [token.offset, emphasis.start, emphasis.end, end]
      .filter((cut) => cut >= token.offset && cut <= end)
      .toSorted((left, right) => left - right);
    return cuts.slice(1).flatMap((cut, index) => {
      const start = cuts[index]!;
      if (cut === start) return [];
      return [
        {
          content: text.slice(start, cut),
          offset: start,
          color: token.color,
          marked: start >= emphasis.start && cut <= emphasis.end,
        },
      ];
    });
  });
  return pieces.map((piece) => {
    const style = piece.color ? { color: piece.color } : undefined;
    return piece.marked ? (
      <mark
        key={piece.offset}
        style={style}
        className={cn(
          "rounded-xs text-inherit",
          kind === "addition" ? "bg-diff-addition/20" : "bg-diff-deletion/20",
        )}
      >
        {piece.content}
      </mark>
    ) : (
      <span key={piece.offset} style={style}>
        {piece.content}
      </span>
    );
  });
}

function DiffLines({
  preview,
  emphasis,
  tokens,
}: {
  preview: FileChangePreview;
  emphasis: Map<number, Emphasis>;
  tokens?: ReadonlyMap<number, ReadonlyArray<LineToken>>;
}) {
  return preview.lines.map((line, index) => {
    if (line.kind === "hunk") {
      // Headers only locate the change, which the line numbers already do.
      if (index === 0) return null;
      return (
        <div
          // Source lines repeat, so position is the only stable key in this immutable preview.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          aria-hidden="true"
          className="my-1 border-t border-dashed border-foreground/10"
        />
      );
    }
    const changed = line.kind === "addition" || line.kind === "deletion";
    return (
      <div
        // Source lines repeat, so position is the only stable key in this immutable preview.
        // oxlint-disable-next-line react/no-array-index-key
        key={index}
        className={cn(
          "flex whitespace-pre",
          line.kind === "addition" && "bg-diff-addition/8",
          line.kind === "deletion" && "bg-diff-deletion/8",
        )}
      >
        <span
          aria-hidden="true"
          className="w-9 shrink-0 pe-1 text-right text-muted-foreground/50 tabular-nums select-none"
        >
          {line.line ?? ""}
        </span>
        {changed ? (
          <span className="sr-only">{line.kind === "addition" ? "Added: " : "Removed: "}</span>
        ) : null}
        <span
          aria-hidden="true"
          className={cn(
            "w-5 shrink-0 text-center opacity-80 select-none",
            line.kind === "addition" && "text-diff-addition",
            line.kind === "deletion" && "text-diff-deletion",
          )}
        >
          {line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : ""}
        </span>
        <span
          className={cn(
            "pe-4",
            changed ? "text-foreground/90" : "text-muted-foreground",
            // Colored context would compete with the change itself.
            tokens && !changed && "opacity-70",
          )}
        >
          <LineText
            text={line.text}
            tokens={tokens?.get(index)}
            emphasis={emphasis.get(index)}
            kind={line.kind}
          />
        </span>
      </div>
    );
  });
}

/** Colors swap in once the shared highlighter has the grammar; until then the lines are plain. */
function HighlightedDiffLines(props: {
  preview: FileChangePreview;
  emphasis: Map<number, Emphasis>;
  language: string;
}) {
  const resolvedTheme = useRenderedAppearance();
  const highlighter = use(getSyntaxHighlighterPromise(props.language));
  // Old and new lines tokenize as one text; the excerpt is short, so mixed state rarely shows.
  const indexes = props.preview.lines.flatMap((line, index) =>
    line.kind === "hunk" ? [] : [index],
  );
  const text = indexes.map((index) => props.preview.lines[index]!.text).join("\n");
  const lines = highlighter.codeToTokens(text, {
    lang: props.language,
    theme: resolveDiffThemeName(resolvedTheme),
  }).tokens;
  const tokens = new Map(indexes.map((lineIndex, position) => [lineIndex, lines[position] ?? []]));
  return <DiffLines preview={props.preview} emphasis={props.emphasis} tokens={tokens} />;
}

export function InlineFileDiff({
  item,
}: {
  readonly item: Extract<OrchestrationV2TurnItem, { type: "file_change" }>;
}) {
  const preview = getFileChangePreview(item);
  if (!preview) return null;
  const emphasis = emphasisByIndex(preview.lines);
  const plain = <DiffLines preview={preview} emphasis={emphasis} />;

  return (
    <div className="min-w-0 bg-background/45">
      {(item.changes?.length ?? 0) > 1 ? (
        <p className="border-b border-foreground/10 px-3 py-1 text-2xs text-muted-foreground">
          Preview: {item.fileName}
        </p>
      ) : null}
      <div
        role="region"
        aria-label={`File change preview for ${item.fileName}`}
        tabIndex={0}
        className="max-h-72 overflow-auto font-mono text-2xs leading-5 select-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="w-max min-w-full py-1.5">
          <RenderErrorBoundary fallback={plain}>
            <Suspense fallback={plain}>
              <HighlightedDiffLines
                preview={preview}
                emphasis={emphasis}
                language={getFiletypeFromFileName(item.fileName)}
              />
            </Suspense>
          </RenderErrorBoundary>
        </div>
      </div>
      {preview.truncated ? (
        <p className="border-t border-foreground/10 px-3 py-1 text-2xs text-muted-foreground">
          Preview shortened. Open diff for the full change.
        </p>
      ) : null}
    </div>
  );
}
