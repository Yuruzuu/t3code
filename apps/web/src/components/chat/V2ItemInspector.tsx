import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  toolCallLines,
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
  turnItemOutputImages,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { fileChangeItemsByFile } from "@t3tools/client-runtime/work-log/file-change-preview";
import { readToolFile, type ReadToolFile } from "@t3tools/client-runtime/work-log/read-tool-output";
import { workEntryFileAction } from "@t3tools/client-runtime/work-log/file-action";
import { isJavaScriptReplTool } from "@t3tools/shared/toolActivity";
import { fileBasename } from "@t3tools/shared/path";
import { getFiletypeFromFileName } from "@pierre/diffs";
import * as DateTime from "effect/DateTime";
import { ExternalLinkIcon, GitBranchIcon, RotateCcwIcon } from "lucide-react";
import { memo, type ReactNode, Suspense, use } from "react";

import { useRenderedAppearance } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { useTurnItemDetail } from "../../state/queries";
import { useV2ItemSupport } from "../../state/v2ItemSupport";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { Button } from "../ui/button";
import ChatMarkdown, { ChatMarkdownAssetImage } from "../ChatMarkdown";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { CommandOutputPanel, useCommandOutputStreaming } from "./CommandOutputPanel";
import { resolveExternalWebLinkHref } from "./externalLinkContextMenu";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { ShellCommandBlock } from "./ShellCommandBlock";
import { InlineFileDiff } from "./InlineFileDiff";
import { WorkLogFileLinks, WorkLogFilePathHeader } from "./WorkLogFileLinks";
import { WorkLogCard, WorkLogSection } from "./WorkLogPanel";

interface V2ItemInspectorProps {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly panelThreadId?: ThreadId | undefined;
  readonly cwd?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
  readonly onRollbackCheckpoint?: (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => void;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}

// Memoized so a parent re-render doesn't re-tokenize a whole file.
const SyntaxTokens = memo(function SyntaxTokens({
  text,
  language,
}: {
  readonly text: string;
  readonly language: string;
}) {
  const resolvedTheme = useRenderedAppearance();
  const highlighter = use(getSyntaxHighlighterPromise(language));
  const { tokens } = highlighter.codeToTokens(text, {
    lang: language,
    theme: resolveDiffThemeName(resolvedTheme),
  });
  return tokens.flatMap((line, lineIndex) => [
    lineIndex > 0 ? "\n" : "",
    ...line.map((token) => (
      <span key={token.offset} style={{ color: token.color }}>
        {token.content}
      </span>
    )),
  ]);
});

const monoClassName =
  "font-mono text-(length:--font-size-code,var(--text-2xs)) leading-relaxed whitespace-pre-wrap break-words select-text";

function isJsonText(text: string): boolean {
  if (!text) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function StructuredValue({
  value,
  highlightJson = false,
  language,
}: {
  readonly value: unknown;
  readonly highlightJson?: boolean;
  readonly language?: "typescript";
}) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const isJson = highlightJson && isJsonText(text);
  if (!text) return null;
  return (
    <pre className={cn("max-h-80 overflow-auto text-muted-foreground", monoClassName)}>
      {language || isJson ? (
        <RenderErrorBoundary fallback={text}>
          <Suspense fallback={text}>
            <SyntaxTokens text={text} language={language ?? "json"} />
          </Suspense>
        </RenderErrorBoundary>
      ) : (
        text
      )}
    </pre>
  );
}

type TurnItem = OrchestrationV2ProjectedTurnItem["item"];

/** A row for one file of a multi-file patch fetches the whole patch; keep only that file. */
function narrowToRowFile(fetched: TurnItem | null | undefined, wireItem: TurnItem) {
  if (fetched?.type !== "file_change" || wireItem.type !== "file_change") return fetched;
  if (wireItem.changes?.length !== 1 || (fetched.changes?.length ?? 0) <= 1) return fetched;
  return fileChangeItemsByFile(fetched).find((file) => file.fileName === wireItem.fileName);
}

function useFetchedTurnItem(
  projectedItem: OrchestrationV2ProjectedTurnItem,
  environmentId: EnvironmentId,
  skip = false,
) {
  const wireItem = projectedItem.item;
  const fetches = !skip && turnItemNeedsDetailFetch(wireItem);
  const detail = useTurnItemDetail(
    fetches
      ? {
          environmentId,
          threadId: projectedItem.sourceThreadId,
          itemId: projectedItem.sourceItemId,
          revision: turnItemDetailRevision(wireItem),
        }
      : null,
  );
  const fetchedItem = narrowToRowFile(detail.data?.item, wireItem);
  const item = fetchedItem?.type === wireItem.type ? fetchedItem : wireItem;
  return {
    item,
    output: {
      output: turnItemOutputText(item),
      images: turnItemOutputImages(item),
      environmentId,
      pending: item === wireItem && detail.isPending,
      error:
        item !== wireItem
          ? null
          : detail.data?.item === null
            ? "Output is no longer available."
            : detail.error,
      empty: fetches && item !== wireItem,
    },
  };
}

interface ToolOutputState {
  readonly output: string | null;
  readonly images: ReturnType<typeof turnItemOutputImages>;
  readonly environmentId: EnvironmentId;
  readonly pending: boolean;
  readonly error: string | null;
  readonly empty: boolean;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}

function ToolOutput(props: ToolOutputState) {
  const images = props.images.map((resource) => (
    <ChatMarkdownAssetImage
      key={resource.index}
      environmentId={props.environmentId}
      resource={resource}
      alt="Tool output image"
      maxHeightRem={16}
      onImageExpand={props.onImageExpand}
    />
  ));
  const text = props.output ? (
    <div className="max-h-80 overflow-auto text-muted-foreground">{props.output}</div>
  ) : props.pending ? (
    <div className="text-muted-foreground italic">Loading output…</div>
  ) : props.error ? (
    <div className="text-destructive">Couldn&apos;t load output: {props.error}</div>
  ) : props.empty && images.length === 0 ? (
    <div className="text-muted-foreground italic">No output.</div>
  ) : null;
  return (
    <>
      {images}
      {text}
    </>
  );
}

export function FetchedToolOutput(props: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const { output } = useFetchedTurnItem(props.projectedItem, props.environmentId);
  return (
    <div className={cn("mt-1.5 space-y-1.5", monoClassName)}>
      <ToolOutput {...output} onImageExpand={props.onImageExpand} />
    </div>
  );
}

// Tokenizing runs on the main thread; past this the file stays plain rather than drop frames.
const READ_HIGHLIGHT_MAX_LINES = 1_000;

/**
 * Plain text paints on the first frame; colors swap in once the shared highlighter has the
 * grammar, which stays loaded for the session.
 */
function ReadFileSource({ path, file }: { path: string; file: ReadToolFile }) {
  const lineCount = file.content.split("\n").length;
  const lineNumbers = Array.from({ length: lineCount }, (_, index) => file.startLine + index);
  return (
    <div
      role="region"
      aria-label={`Contents of ${fileBasename(path)}`}
      tabIndex={0}
      className="flex max-h-80 overflow-auto bg-background/45 py-1.5 font-mono text-2xs leading-5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <pre
        aria-hidden="true"
        className="h-max shrink-0 ps-2 pe-3 text-right text-muted-foreground/50 tabular-nums select-none"
      >
        {lineNumbers.join("\n")}
      </pre>
      <pre className="h-max min-w-0 grow pe-4 text-foreground/85 select-text">
        {lineCount > READ_HIGHLIGHT_MAX_LINES ? (
          file.content
        ) : (
          <RenderErrorBoundary fallback={file.content}>
            <Suspense fallback={file.content}>
              <SyntaxTokens text={file.content} language={getFiletypeFromFileName(path)} />
            </Suspense>
          </RenderErrorBoundary>
        )}
      </pre>
    </div>
  );
}

/** A read row's body: the file as highlighted source when the output carries its content. */
export function FetchedReadOutput(props: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly path: string;
  readonly header: ReactNode;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const { item, output } = useFetchedTurnItem(props.projectedItem, props.environmentId);
  const file = item.type === "dynamic_tool" ? readToolFile(item.output) : null;
  return (
    <WorkLogCard>
      <WorkLogSection dense>
        <div className="flex min-h-6 min-w-0 items-center">{props.header}</div>
      </WorkLogSection>
      {file ? (
        <ReadFileSource path={props.path} file={file} />
      ) : (
        <WorkLogSection inset>
          <div className={cn("space-y-1.5", monoClassName)}>
            <ToolOutput {...output} onImageExpand={props.onImageExpand} />
          </div>
        </WorkLogSection>
      )}
    </WorkLogCard>
  );
}

const filePathArgumentKeys = new Set([
  "file_path",
  "filePath",
  "path",
  "filename",
  "fileName",
  "notebook_path",
  "paths",
  "source",
  "destination",
]);

function argumentFilePaths(args: unknown, key: string, paths: ReadonlyArray<string>): string[] {
  if (!filePathArgumentKeys.has(key)) return [];
  if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
  const value = (args as Record<string, unknown>)[key];
  if (typeof value === "string") return paths.includes(value) ? [value] : [];
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry): entry is string => typeof entry === "string" && paths.includes(entry))
  ) {
    return value;
  }
  return [];
}

/** The header already names a single edited file; repeating it as "update <file>" is noise. */
function fileChangeListIsInformative(
  item: Extract<OrchestrationV2ProjectedTurnItem["item"], { type: "file_change" }>,
) {
  const changes = item.changes ?? [];
  return (
    changes.length > 1 ||
    changes.some(
      (change) =>
        change.oldPath || change.path !== item.fileName || change.fileType || change.mimeType,
    )
  );
}

function ToolCallBody(
  props: ToolOutputState & {
    readonly command?: string;
    readonly args?: unknown;
    readonly toolName?: string | null;
    readonly exitCode?: number | undefined;
    readonly fileLinks?:
      | {
          readonly paths: ReadonlyArray<string>;
          readonly environmentId: EnvironmentId;
          readonly threadId: ThreadId;
          readonly sourceThreadId: ThreadId;
          readonly workspaceRoot: string | undefined;
        }
      | undefined;
    /** Replaces the fetched output, e.g. with a command's live output. */
    readonly outputSlot?: ReactNode;
  },
) {
  const call = toolCallLines({ command: props.command, args: props.args });
  const paths = props.fileLinks?.paths ?? [];
  const argumentPaths = new Set(
    call.args?.flatMap(([key]) => argumentFilePaths(props.args, key, paths)),
  );
  const extraPaths = paths.filter((path) => !argumentPaths.has(path));
  const hasInput = call.command || call.args || call.argsText || extraPaths.length > 0;
  const hasOutput =
    props.outputSlot !== undefined ||
    props.output ||
    props.images.length > 0 ||
    props.pending ||
    props.error ||
    props.empty ||
    (props.exitCode !== undefined && props.exitCode !== 0);
  if (!hasInput && !hasOutput) return null;
  return (
    <div className={monoClassName}>
      <WorkLogCard>
        {hasInput ? (
          <WorkLogSection {...(call.command ? {} : { label: "Input" })}>
            <div className="max-h-80 space-y-1.5 overflow-auto text-foreground/85">
              {props.fileLinks && extraPaths.length > 0 ? (
                <WorkLogFileLinks {...props.fileLinks} paths={extraPaths} />
              ) : null}
              {call.command ? (
                <div className="flex min-w-0 gap-2">
                  <span aria-hidden className="shrink-0 text-muted-foreground select-none">
                    $
                  </span>
                  <div className="min-w-0 flex-1">
                    <ShellCommandBlock command={call.command} />
                  </div>
                </div>
              ) : null}
              {call.args?.map(([key, value]) => {
                const linkedPaths = argumentFilePaths(props.args, key, paths);
                return (
                  <div key={key}>
                    <span className="text-muted-foreground">{key} </span>
                    {props.fileLinks && linkedPaths.length > 0 ? (
                      <WorkLogFileLinks {...props.fileLinks} paths={linkedPaths} />
                    ) : key === "code" && isJavaScriptReplTool(props.toolName) ? (
                      <StructuredValue value={value} language="typescript" />
                    ) : (
                      value
                    )}
                  </div>
                );
              })}
              {call.argsText ? <StructuredValue value={call.argsText} highlightJson /> : null}
            </div>
          </WorkLogSection>
        ) : null}
        {hasOutput ? (
          <WorkLogSection
            inset
            {...(call.command ? {} : { label: "Output" })}
            trailing={
              props.exitCode !== undefined && props.exitCode !== 0 ? (
                <span className="text-2xs text-destructive">Exit code {props.exitCode}</span>
              ) : undefined
            }
          >
            <div className="space-y-1.5">{props.outputSlot ?? <ToolOutput {...props} />}</div>
          </WorkLogSection>
        ) : null}
      </WorkLogCard>
    </div>
  );
}

export const V2ItemInspector = memo(function V2ItemInspector(props: V2ItemInspectorProps) {
  // Command rows stream their output, including the final output, from the server.
  const streamsOutput =
    useCommandOutputStreaming(props.environmentId) &&
    props.projectedItem.item.type === "command_execution";
  const fetched = useFetchedTurnItem(props.projectedItem, props.environmentId, streamsOutput);
  const item = fetched.item;
  const outputState = fetched.output;
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: props.projectedItem.sourceThreadId,
    sourceItemId: props.projectedItem.sourceItemId,
  });
  const fileAction = workEntryFileAction({
    id: item.id,
    createdAt: DateTime.formatIso(item.updatedAt),
    label: item.type === "dynamic_tool" ? (item.toolName ?? "") : "",
    tone: "tool",
    structuredPayload: item,
  });
  const fileLinks = {
    environmentId: props.environmentId,
    threadId: props.panelThreadId ?? props.projectedItem.sourceThreadId,
    sourceThreadId: props.projectedItem.sourceThreadId,
    workspaceRoot: props.workspaceRoot,
  };
  return (
    <div className="space-y-2 text-xs" data-v2-item-inspector={item.type}>
      {item.type === "reasoning" && item.text ? (
        <div className="rounded-md border border-border/45 bg-muted/15 p-2 italic text-muted-foreground">
          <ChatMarkdown
            text={item.text}
            cwd={props.cwd}
            threadRef={{
              environmentId: props.environmentId,
              threadId: props.projectedItem.sourceThreadId,
            }}
            lineBreaks
          />
        </div>
      ) : null}

      {item.type === "command_execution" ? (
        <ToolCallBody
          command={item.input}
          exitCode={item.exitCode}
          {...outputState}
          onImageExpand={props.onImageExpand}
          outputSlot={
            streamsOutput ? (
              <CommandOutputPanel
                environmentId={props.environmentId}
                threadId={props.projectedItem.sourceThreadId}
                itemId={props.projectedItem.sourceItemId}
              />
            ) : undefined
          }
        />
      ) : null}

      {item.type === "file_change" ? (
        <WorkLogCard>
          <WorkLogSection dense>
            <div className="flex min-h-6 min-w-0 items-center gap-2">
              <WorkLogFilePathHeader
                {...fileLinks}
                path={item.fileName}
                displayPath={formatWorkspaceRelativePath(item.fileName, props.workspaceRoot)}
              />
              {item.additions !== undefined || item.deletions !== undefined ? (
                <span className="shrink-0 font-mono text-2xs tabular-nums">
                  <span className="text-diff-addition">
                    +{formatDiffCount(item.additions ?? 0)}
                  </span>{" "}
                  <span className="text-diff-deletion">
                    -{formatDiffCount(item.deletions ?? 0)}
                  </span>
                </span>
              ) : null}
              {item.runId !== null ? (
                <button
                  type="button"
                  className="ms-auto inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-sm text-2xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onOpenTurnDiff(item.runId!, item.fileName);
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  Open diff
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </button>
              ) : null}
            </div>
            {fileChangeListIsInformative(item) ? (
              <ul className="mt-1.5 space-y-1 font-mono text-muted-foreground">
                {item.changes!.map((change) => (
                  <li key={JSON.stringify([change.operation, change.oldPath, change.path])}>
                    {change.operation}{" "}
                    {change.oldPath ? (
                      <>
                        <WorkLogFileLinks {...fileLinks} paths={[change.oldPath]} /> →{" "}
                      </>
                    ) : null}
                    <WorkLogFileLinks {...fileLinks} paths={[change.path]} />
                    {change.fileType || change.mimeType
                      ? ` (${[change.fileType, change.mimeType].filter(Boolean).join(", ")})`
                      : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </WorkLogSection>
          {item.status === "failed" && item.diffStr?.trim() ? (
            <WorkLogSection inset>
              <StructuredValue value={item.diffStr} />
            </WorkLogSection>
          ) : null}
          <InlineFileDiff item={item} />
        </WorkLogCard>
      ) : null}

      {item.type === "file_search" && item.pattern?.trim() ? (
        <div className={cn("text-foreground/85", monoClassName)}>{item.pattern}</div>
      ) : null}

      {item.type === "web_search" && item.patterns?.length ? (
        <div className={cn("text-foreground/85", monoClassName)}>{item.patterns.join("\n")}</div>
      ) : null}

      {item.type === "file_search" && item.results?.length ? (
        <ul className="space-y-1">
          {item.results.map((result) => (
            <li key={JSON.stringify(result)}>
              <span className="font-mono text-foreground/80">
                {formatWorkspaceRelativePath(result.fileName, props.workspaceRoot)}
                {result.line === undefined ? "" : `:${result.line}`}
                {result.column === undefined ? "" : `:${result.column}`}
              </span>
              {result.preview ? (
                <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{result.preview}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {item.type === "web_search" && item.results?.length ? (
        <ul className="space-y-1.5">
          {item.results.map((result) => {
            const safeHref = resolveExternalWebLinkHref(result.url);
            return (
              <li key={JSON.stringify(result)}>
                {safeHref ? (
                  <a
                    href={safeHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
                  >
                    {result.title ?? result.url}
                    <ExternalLinkIcon className="size-3" />
                  </a>
                ) : (
                  <p className="font-medium text-foreground">
                    {result.title ?? result.url ?? "Search result"}
                  </p>
                )}
                {result.snippet ? <p className="text-muted-foreground">{result.snippet}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {item.type === "dynamic_tool" ? (
        <ToolCallBody
          toolName={item.toolName}
          args={item.input}
          fileLinks={fileAction ? { ...fileLinks, paths: fileAction.paths } : undefined}
          {...outputState}
          onImageExpand={props.onImageExpand}
        />
      ) : null}

      {item.type === "approval_request" ? <StructuredValue value={item.prompt} /> : null}
      {item.type === "user_input_request" ? (
        <StructuredValue value={item.questions.map((question) => question.question).join("\n\n")} />
      ) : null}
      {item.type === "notification" ? <StructuredValue value={item.detail} /> : null}
      {item.type === "system_notice" ? <StructuredValue value={item.message} /> : null}
      {item.type === "error" ? <StructuredValue value={item.failure.message} /> : null}
      {item.type === "proposed_plan" ? <StructuredValue value={item.markdown} /> : null}
      {item.type === "todo_list" ? (
        <StructuredValue
          value={item.steps
            .map((step) => `${step.status === "completed" ? "✓" : "○"} ${step.text}`)
            .join("\n")}
        />
      ) : null}

      {item.type === "checkpoint" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">
            {support.checkpoint?.status ?? item.status} · {item.files.length} files
          </span>
          {props.onRollbackCheckpoint && support.checkpoint?.status === "ready" ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                props.onRollbackCheckpoint?.({
                  checkpointId: item.checkpointId,
                  scopeId: item.scopeId,
                })
              }
            >
              <RotateCcwIcon className="size-3" />
              Roll back
            </Button>
          ) : null}
        </div>
      ) : null}

      {item.type === "fork" ? (
        <Button size="xs" variant="outline" onClick={() => props.onOpenThread(item.targetThreadId)}>
          <GitBranchIcon className="size-3" />
          Open fork
        </Button>
      ) : null}

      {item.type === "subagent" && item.childThreadId !== null ? (
        <Button size="xs" variant="outline" onClick={() => props.onOpenThread(item.childThreadId!)}>
          Open subagent thread
        </Button>
      ) : null}

      {item.type === "handoff" ? (
        <div className="space-y-1 text-muted-foreground">
          <p>
            {item.fromProviderInstanceIds.join(", ")} → {item.toProviderInstanceId}
          </p>
          <p>
            {item.strategy.replaceAll("_", " ")} · {support.contextHandoff?.status ?? item.status}
          </p>
          {support.contextTransfer ? (
            <p>
              Transfer {support.contextTransfer.type.replaceAll("_", " ")} ·{" "}
              {support.contextTransfer.status}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
