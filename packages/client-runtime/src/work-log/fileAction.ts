import type { WorkLogPresentationEntry } from "./presentation.js";

type FileOperation = "read" | "edit" | "create" | "delete" | "rename" | "write" | "change";

interface FileTarget {
  readonly operation: FileOperation;
  readonly path: string;
  readonly oldPath?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function filePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/u.test(value)) return undefined;
  return /[/\\]$/u.test(value) || value === "." || value === ".." ? undefined : value;
}

function inputPath(input: Record<string, unknown> | undefined): string | undefined {
  for (const key of ["file_path", "filePath", "path", "filename", "fileName", "notebook_path"]) {
    const path = filePath(input?.[key]);
    if (path) return path;
  }
  return undefined;
}

function changeOperation(value: unknown): FileOperation {
  switch (typeof value === "string" ? value.toLowerCase() : value) {
    case "add":
    case "create":
      return "create";
    case "edit":
    case "modify":
    case "update":
      return "edit";
    case "write":
      return "write";
    case "delete":
    case "remove":
      return "delete";
    case "move":
    case "rename":
      return "rename";
    default:
      return "change";
  }
}

function toolOperation(value: unknown): FileOperation | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.toLowerCase().replaceAll("_", "").replaceAll("-", "")) {
    case "read":
    case "readfile":
    case "readmultiplefiles":
      return "read";
    case "edit":
    case "editfile":
    case "multiedit":
    case "notebookedit":
      return "edit";
    case "write":
    case "writefile":
      // Write tools can overwrite existing files; creation needs an explicit operation.
      return "write";
    case "createfile":
      return "create";
    case "deletefile":
      return "delete";
    case "movefile":
    case "renamefile":
      return "rename";
    default:
      return undefined;
  }
}

function fileTargets(entry: WorkLogPresentationEntry): FileTarget[] {
  const item = entry.structuredPayload;
  const data = asRecord(entry.toolData);
  const payload = asRecord(item) ?? data;
  if (payload?.type === "file_change" || entry.itemType === "file_change") {
    const changes = payload?.changes;
    if (Array.isArray(changes) && changes.length > 0) {
      return changes.flatMap((value: unknown) => {
        const change = asRecord(value);
        const path = filePath(change?.path);
        if (!path) return [];
        const oldPath = filePath(change?.oldPath);
        return [
          { operation: changeOperation(change?.operation), path, ...(oldPath ? { oldPath } : {}) },
        ];
      });
    }
    const paths = entry.changedFiles?.length ? entry.changedFiles : [payload?.fileName];
    return paths.flatMap((value) => {
      const path = filePath(value);
      return path ? [{ operation: "change" as const, path }] : [];
    });
  }

  if (item && item.type !== "dynamic_tool") return [];
  if (entry.itemType && entry.itemType !== "dynamic_tool") return [];
  const operation = toolOperation(
    item?.toolName ?? data?.toolName ?? entry.toolTitle ?? entry.label,
  );
  if (!operation) return [];
  const input = asRecord(item?.input ?? data?.input ?? data?.rawInput ?? data?.arguments);
  if (operation === "read" && Array.isArray(input?.paths)) {
    return input.paths.flatMap((value: unknown) => {
      const path = filePath(value);
      return path ? [{ operation, path }] : [];
    });
  }
  const path = operation === "rename" ? filePath(input?.destination) : inputPath(input);
  if (!path) return [];
  const oldPath = operation === "rename" ? filePath(input?.source) : undefined;
  return [{ operation, path, ...(oldPath ? { oldPath } : {}) }];
}

const verbs = {
  read: ["Read", "Reading", "Read"],
  edit: ["Edit", "Editing", "Edited"],
  create: ["Create", "Creating", "Created"],
  delete: ["Delete", "Deleting", "Deleted"],
  rename: ["Rename", "Renaming", "Renamed"],
  write: ["Write", "Writing", "Wrote"],
  change: ["Change", "Changing", "Changed"],
} as const;

function actionLabel(entry: WorkLogPresentationEntry, operation: FileOperation): string {
  const [base, active, completed] = verbs[operation];
  const statuses = [
    entry.toolLifecycleStatus,
    entry.structuredPayload?.status,
    asRecord(entry.toolData)?.status,
  ];
  if (entry.tone === "error" || statuses.includes("failed"))
    return `Failed to ${base.toLowerCase()}`;
  if (statuses.includes("declined")) return `Declined to ${base.toLowerCase()}`;
  if (
    statuses.some(
      (status) => status === "stopped" || status === "cancelled" || status === "interrupted",
    )
  ) {
    return `Stopped ${active.toLowerCase()}`;
  }
  if (statuses.includes("waiting")) return `Waiting to ${base.toLowerCase()}`;
  if (
    statuses.some(
      (status) => status === "inProgress" || status === "running" || status === "pending",
    )
  ) {
    return active;
  }
  if (statuses.includes("idle")) return base;
  return statuses.includes("completed") ? completed : base;
}

function resolveFileAction(entry: WorkLogPresentationEntry) {
  const targets = fileTargets(entry);
  const first = targets[0];
  if (!first) return null;
  const operation = targets.every((target) => target.operation === first.operation)
    ? first.operation
    : "change";
  const paths = [
    ...new Set(
      targets.flatMap((target) => (target.oldPath ? [target.path, target.oldPath] : [target.path])),
    ),
  ];
  return {
    action: actionLabel(entry, operation),
    fileName: first.path.slice(
      Math.max(first.path.lastIndexOf("/"), first.path.lastIndexOf("\\")) + 1,
    ),
    path: first.path,
    paths,
    count: new Set(targets.map((target) => target.path)).size,
  };
}

export function workEntryFileAction(entry: WorkLogPresentationEntry): {
  action: string;
  fileName: string;
  path: string;
  paths: ReadonlyArray<string>;
} | null {
  const result = resolveFileAction(entry);
  if (!result) return null;
  const { count: _count, ...action } = result;
  return action;
}

export function workEntryFileActionLabel(entry: WorkLogPresentationEntry): string | null {
  const result = resolveFileAction(entry);
  if (!result) return null;
  const extra = result.count - 1;
  return `${result.action} ${result.fileName}${extra > 0 ? ` and ${extra} ${extra === 1 ? "file" : "files"}` : ""}`;
}
