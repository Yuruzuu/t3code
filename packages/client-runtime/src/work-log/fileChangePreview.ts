import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

export interface FileChangePreviewLine {
  readonly kind: "addition" | "deletion" | "context" | "hunk";
  readonly text: string;
  /** Old-side number for deletions, new-side otherwise; known only under a patch hunk header. */
  readonly line?: number;
}

function numberLines(lines: ReadonlyArray<FileChangePreviewLine>): Array<number | undefined> {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  return lines.map((line) => {
    if (line.kind === "hunk") {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line.text);
      oldLine = header ? Number(header[1]) : undefined;
      newLine = header ? Number(header[2]) : undefined;
      return undefined;
    }
    if (oldLine === undefined || newLine === undefined) return undefined;
    if (line.kind === "deletion") return oldLine++;
    if (line.kind === "addition") return newLine++;
    oldLine++;
    return newLine++;
  });
}

export interface FileChangePreview {
  readonly lines: ReadonlyArray<FileChangePreviewLine>;
  readonly truncated: boolean;
}

const MAX_INPUT_LENGTH = 65_536;
const MAX_INPUT_LINES = 2_000;
const MAX_DIFF_CELLS = 250_000;
const MAX_PREVIEW_LINES = 40;
const MAX_LINE_LENGTH = 500;
const CONTEXT_LINES = 3;
const TRANSPORT_TRUNCATION_MARKER = "\n… output truncated for transport";

function sourceText(text: string): { text: string; truncated: boolean } {
  const truncated = text.endsWith(TRANSPORT_TRUNCATION_MARKER);
  return {
    text: truncated ? text.slice(0, -TRANSPORT_TRUNCATION_MARKER.length) : text,
    truncated,
  };
}

function compactPreview(
  lines: ReadonlyArray<FileChangePreviewLine>,
  truncated: boolean,
): FileChangePreview | null {
  const visible = new Set<number>();
  let hunkIndex: number | undefined;

  for (const [index, line] of lines.entries()) {
    if (line.kind === "hunk") hunkIndex = index;
    if (line.kind !== "addition" && line.kind !== "deletion") continue;
    if (hunkIndex !== undefined) visible.add(hunkIndex);
    visible.add(index);
    for (const direction of [-1, 1]) {
      for (let offset = 1; offset <= CONTEXT_LINES; offset++) {
        const neighbor = index + direction * offset;
        if (lines[neighbor]?.kind !== "context") break;
        visible.add(neighbor);
      }
    }
  }

  if (visible.size === 0) return null;

  const numbers = numberLines(lines);
  const preview: FileChangePreviewLine[] = [];
  let previousIndex = -1;
  for (const index of [...visible].sort((left, right) => left - right)) {
    const line = lines[index]!;
    if (
      index > previousIndex + 1 &&
      line.kind !== "hunk" &&
      previousIndex >= 0 &&
      preview.length < MAX_PREVIEW_LINES
    ) {
      preview.push({ kind: "hunk", text: "…" });
    }
    if (preview.length >= MAX_PREVIEW_LINES) {
      truncated = true;
      break;
    }
    if (line.text.length > MAX_LINE_LENGTH) truncated = true;
    const number = numbers[index];
    preview.push({
      kind: line.kind,
      text:
        line.text.length > MAX_LINE_LENGTH ? `${line.text.slice(0, MAX_LINE_LENGTH)}…` : line.text,
      ...(number === undefined ? {} : { line: number }),
    });
    previousIndex = index;
  }

  return { lines: preview, truncated: truncated || visible.size < lines.length };
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");
}

function headerPath(header: string): string | null {
  const path = header.split("\t", 1)[0]!;
  if (path === "/dev/null") return null;
  if (!path.startsWith('"')) return normalizePath(path);

  try {
    const decoded: unknown = JSON.parse(path);
    return typeof decoded === "string" ? normalizePath(decoded) : null;
  } catch {
    // Unsupported quoted paths cannot safely identify the file this preview belongs to.
    return null;
  }
}

function patchPaths(oldHeader: string, newHeader: string): string[] {
  const oldPath = headerPath(oldHeader);
  const newPath = headerPath(newHeader);
  const prefixed =
    (oldPath === null || oldPath.startsWith("a/")) &&
    (newPath === null || newPath.startsWith("b/"));
  return [
    ...(oldPath === null ? [] : [prefixed ? oldPath.replace(/^a\//u, "") : oldPath]),
    ...(newPath === null ? [] : [prefixed ? newPath.replace(/^b\//u, "") : newPath]),
  ];
}

function patchPreview(
  patch: string,
  truncated: boolean,
  fileName: string,
): FileChangePreview | null {
  const bounded = patch.slice(0, MAX_INPUT_LENGTH);
  const inputLines = bounded.split("\n");
  const cutShort = patch.length > bounded.length;
  if (cutShort) inputLines.pop();

  const sections: Array<{ paths: string[]; lines: FileChangePreviewLine[] }> = [
    { paths: [], lines: [] },
  ];
  let section = sections[0]!;
  let hasFileHeaders = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  const scannedLines = inputLines.slice(0, MAX_INPUT_LINES);
  for (let index = 0; index < scannedLines.length; index++) {
    const rawLine = scannedLines[index]!;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("diff --git ")) {
      if (oldRemaining > 0 || newRemaining > 0) truncated = true;
      oldRemaining = 0;
      newRemaining = 0;
      hasFileHeaders = true;
      section = { paths: [], lines: [] };
      sections.push(section);
      continue;
    }
    const nextLine = scannedLines[index + 1]?.replace(/\r$/u, "");
    if (
      oldRemaining === 0 &&
      newRemaining === 0 &&
      line.startsWith("--- ") &&
      nextLine?.startsWith("+++ ")
    ) {
      hasFileHeaders = true;
      if (section.lines.length > 0 || section.paths.length > 0) {
        section = { paths: [], lines: [] };
        sections.push(section);
      }
      section.paths = patchPaths(line.slice(4), nextLine.slice(4));
      index++;
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      if (oldRemaining > 0 || newRemaining > 0) truncated = true;
      oldRemaining = Number(header[2] ?? 1);
      newRemaining = Number(header[4] ?? 1);
      section.lines.push({ kind: "hunk", text: line });
    } else if (line.startsWith("-") && oldRemaining > 0) {
      section.lines.push({ kind: "deletion", text: line.slice(1) });
      oldRemaining--;
    } else if (line.startsWith("+") && newRemaining > 0) {
      section.lines.push({ kind: "addition", text: line.slice(1) });
      newRemaining--;
    } else if (line.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) {
      section.lines.push({ kind: "context", text: line.slice(1) });
      oldRemaining--;
      newRemaining--;
    } else if (!line.startsWith("\\")) {
      if (oldRemaining > 0 || newRemaining > 0) truncated = true;
      oldRemaining = 0;
      newRemaining = 0;
    }
  }

  truncated ||=
    cutShort || inputLines.length > MAX_INPUT_LINES || oldRemaining > 0 || newRemaining > 0;
  if (!hasFileHeaders) return compactPreview(section.lines, truncated);

  const targetPath = normalizePath(fileName);
  const windowsTarget = /^(?:[a-z]:\/|\/\/)/iu.test(targetPath);
  const comparablePath = (path: string) => (windowsTarget ? path.toLowerCase() : path);
  const target = comparablePath(targetPath);
  const exact = sections.filter((candidate) =>
    candidate.paths.some((path) => comparablePath(path) === target),
  );
  // Providers can use absolute paths while a patch uses repository-relative paths.
  // Prefer exact matches; a suffix must identify exactly one section in the whole patch.
  const matches =
    exact.length > 0 || truncated
      ? exact
      : sections.filter((candidate) =>
          candidate.paths.some((candidatePath) => {
            const path = comparablePath(candidatePath);
            const absolute = /^(?:\/|[a-z]:\/)/iu;
            if (absolute.test(path) && absolute.test(target)) return false;
            return target.endsWith(`/${path}`) || path.endsWith(`/${target}`);
          }),
        );
  return matches.length === 1 ? compactPreview(matches[0]!.lines, truncated) : null;
}

function textLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function excerptPreview(oldText: string, newText: string): FileChangePreview | null {
  if (oldText.length + newText.length > MAX_INPUT_LENGTH) return null;

  const oldLines = textLines(oldText);
  const newLines = textLines(newText);
  if (oldLines.length + newLines.length > MAX_INPUT_LINES) return null;

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  if (prefix === oldEnd && prefix === newEnd) return null;

  const width = newEnd - prefix + 1;
  const height = oldEnd - prefix + 1;
  if (width * height > MAX_DIFF_CELLS) return null;

  // The installed viewer exports its diff generator through a syntax-rendering barrel.
  // Bound a line-only LCS here so shared previews never load that rendering machinery.
  const lengths = new Uint16Array(width * height);
  for (let oldIndex = height - 2; oldIndex >= 0; oldIndex--) {
    for (let newIndex = width - 2; newIndex >= 0; newIndex--) {
      lengths[oldIndex * width + newIndex] =
        oldLines[prefix + oldIndex] === newLines[prefix + newIndex]
          ? lengths[(oldIndex + 1) * width + newIndex + 1]! + 1
          : Math.max(
              lengths[(oldIndex + 1) * width + newIndex]!,
              lengths[oldIndex * width + newIndex + 1]!,
            );
    }
  }

  const lines: FileChangePreviewLine[] = [{ kind: "hunk", text: "Changed excerpt" }];
  for (const text of oldLines.slice(Math.max(0, prefix - CONTEXT_LINES), prefix)) {
    lines.push({ kind: "context", text });
  }
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < height - 1 || newIndex < width - 1) {
    if (
      oldIndex < height - 1 &&
      newIndex < width - 1 &&
      oldLines[prefix + oldIndex] === newLines[prefix + newIndex]
    ) {
      lines.push({ kind: "context", text: oldLines[prefix + oldIndex]! });
      oldIndex++;
      newIndex++;
    } else if (
      oldIndex < height - 1 &&
      (newIndex === width - 1 ||
        lengths[(oldIndex + 1) * width + newIndex]! >= lengths[oldIndex * width + newIndex + 1]!)
    ) {
      lines.push({ kind: "deletion", text: oldLines[prefix + oldIndex]! });
      oldIndex++;
    } else {
      lines.push({ kind: "addition", text: newLines[prefix + newIndex]! });
      newIndex++;
    }
  }
  for (const text of newLines.slice(newEnd, newEnd + CONTEXT_LINES)) {
    lines.push({ kind: "context", text });
  }

  return compactPreview(lines, false);
}

export function getFileChangePreview(item: FileChangeItem): FileChangePreview | null {
  if (item.status === "failed") return null;
  if (item.diffStr !== undefined) {
    const source = sourceText(item.diffStr);
    const patch = patchPreview(source.text, source.truncated, item.fileName);
    if (patch) return patch;
  }

  const operation = item.changes
    ?.find((change) => change.path === item.fileName)
    ?.operation.toLowerCase();
  // Only an explicit operation proves that a missing side was empty, rather than unknown.
  const created = operation === "create" || operation === "add";
  const oldText = item.oldStr ?? (created ? "" : undefined);
  // Codex reports a new file's whole content as its non-patch diff text.
  const newText =
    item.newStr ??
    (operation === "delete" || operation === "remove" ? "" : created ? item.diffStr : undefined);
  if (oldText === undefined || newText === undefined) return null;
  const oldSource = sourceText(oldText);
  const newSource = sourceText(newText);
  if (oldSource.text === "" && !oldSource.truncated) return newFilePreview(newSource);
  // Independently clipped tails can look like deletions after an insertion.
  if (oldSource.truncated || newSource.truncated) return null;

  return excerptPreview(oldSource.text, newSource.text);
}

/** A clipped new file is still a correct prefix, so it previews as numbered additions. */
function newFilePreview(source: { text: string; truncated: boolean }): FileChangePreview | null {
  const lines = textLines(source.text.slice(0, MAX_INPUT_LENGTH)).slice(0, MAX_INPUT_LINES);
  if (lines.length === 0) return null;
  return compactPreview(
    [
      { kind: "hunk", text: `@@ -0,0 +1,${lines.length} @@` },
      ...lines.map((text) => ({ kind: "addition" as const, text })),
    ],
    source.truncated || source.text.length > MAX_INPUT_LENGTH,
  );
}

const PATCH_FILE_HEADER = /^(?:diff --git |--- )/mu;

/**
 * One item per file of a multi-file patch, so each file reads as its own change. A file without
 * its own diff keeps the item's patch only when file headers let the preview find its section.
 */
export function fileChangeItemsByFile(item: FileChangeItem): FileChangeItem[] {
  const changes = item.changes ?? [];
  if (changes.length <= 1) return [item];
  const { diffStr, oldStr, newStr, additions: _additions, deletions: _deletions, ...rest } = item;
  const sharedPatch = diffStr !== undefined && PATCH_FILE_HEADER.test(diffStr);
  return changes.map((change) => {
    // The item's own bodies describe only the file it is named after.
    const named = change.path === item.fileName;
    const fileDiff = change.diff ?? (sharedPatch || named ? diffStr : undefined);
    return {
      ...rest,
      fileName: change.path,
      changes: [change],
      ...(fileDiff === undefined ? {} : { diffStr: fileDiff }),
      ...(named && oldStr !== undefined ? { oldStr } : {}),
      ...(named && newStr !== undefined ? { newStr } : {}),
      ...(change.additions === undefined ? {} : { additions: change.additions }),
      ...(change.deletions === undefined ? {} : { deletions: change.deletions }),
    };
  });
}
