export interface ReadToolFile {
  readonly content: string;
  /** First line of `content` in the file; reads of a range start past line 1. */
  readonly startLine: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Claude Code's text form prefixes every line with its number and an arrow or tab.
const NUMBERED_LINE = /^\s*(\d+)(?:→|\t)(.*)$/u;

function numberedText(text: string): ReadToolFile | null {
  const lines = text.replaceAll("\r\n", "\n").replace(/\n$/u, "").split("\n");
  const matches = lines.map((line) => NUMBERED_LINE.exec(line));
  if (matches.length === 0 || matches.some((match) => match === null)) return null;
  return {
    content: matches.map((match) => match![2]).join("\n"),
    startLine: Number(matches[0]![1]),
  };
}

/** File contents from a read tool's output, or null when it is not a recognizable read result. */
export function readToolFile(output: unknown): ReadToolFile | null {
  const value = typeof output === "string" ? (parseJson(output) ?? output) : output;
  if (typeof value === "string") return numberedText(value);
  const file = isRecord(value) && isRecord(value.file) ? value.file : undefined;
  if (typeof file?.content !== "string") return null;
  const startLine = file.startLine;
  return {
    content: file.content,
    startLine:
      typeof startLine === "number" && Number.isSafeInteger(startLine) && startLine > 0
        ? startLine
        : 1,
  };
}
