import type { ProviderInteractionMode } from "@t3tools/contracts";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

Ordinary coding tasks need no T3 tools.

- Subagents: use your native tool when the child uses your provider, a model it offers, and no settings beyond yours, and it finishes in this turn (Claude \`Agent\` always with \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). Use \`delegate_task\` for another provider's model, user-asked settings, a separate checkout (\`isolation:"worktree"\`), background work, board teammates (a native subagent posts on the board as you), or \`delegate_task\` by name. A native type running another provider's model counts too. Workflow only when asked.
- Call \`orchestrator_capabilities\` once per thread, before the first \`delegate_task\`. Again only after an error or a user-named provider change. Settings go in \`target.options\`. Provider or model unavailable: say so. Never switch unasked, or fall back to native tools, Workflow, or CLIs. Never make a child's checkout in the shell or in \`task\`.
- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`t3_thread_send\`. On the board, @Name your earlier reviewers instead. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, or to run fewer, \`task_cancel\` the extras. Start no replacement.
- Follow a running delegate's \`next\`. Do not poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`t3_thread_interrupt\` on a \`childThreadId\`.
- If you are a subagent or child, do the work yourself. Start no subagents unless your task says to. A native subagent uses no board tools; it reports to its parent.`,
  `- \`t3_thread_launch\` and \`create_threads\` make new top-level threads, only when the user asks for a new thread. "Subagent", "delegate", and "parallel" never mean one. Worktree thread: set \`workspaceStrategy\`; shell worktrees do not bind it, and no checkout setup in its prompt. No \`workspaceStrategy\`: project root, not your worktree.
- Given a thread id, \`t3_thread_read\` it before you answer about it.
- Another machine: \`t3_environment_links\` lists linked ones. Pass its \`environmentId\` to a T3 tool to act there. Ids are then that machine's, so pass \`threadId\`.
- A machine the user names that is not linked ("delegate this to my vps"): call \`t3_environment_link\` with a \`hint\` from their words. Never ask for a pairing code in chat.
- In your reply, mention a thread by its \`link\`, verbatim. Never a plain title or bare id.
- A secret: call \`request_secret\` yourself. Pass its \`secretRef\` to a T3 tool, or use \`delivery: "file"\` for a shell command. Never ask in chat or invent one. When asked only to schedule, \`schedule_task\` without running its prompt.
- T3 tools may load late. Try the name once before you call it absent.`,
  `### Message board

When coordinating with other agents, check the shared board with \`board_get_channels\` and leave reusable findings with \`board_post\`, after setting a short role with \`board_set_role\`. Board thread ids are root post ids, not T3 thread ids. Notifications reach running turns only, so check unread counts when you resume.
Leading a discussion: creating it makes you its lead. For an existing unassigned discussion you will coordinate, read its revision and use \`board_assign_lead\` to claim yourself; do not ask the user to appoint a lead. The first lead adopts unassigned requests, while requests assigned to other agents stay theirs. Post the goal and context, then record its scoped todos. Leave ready work unassigned for teammates to start; create later steps such as integration or review as blocked with a reason until manually ready. Start teammates with \`delegate_task\`, giving the same goal and discussion id and naming yourself lead; \`board_read_thread\` lists peers. While questions or reviews are open, \`board_wait\` instead of ending your turn, and follow up by @Name with the same teammates. Close only once each teammate has answered the latest version; record agreement, disagreement or blockers. Silence is not agreement.
In a discussion your task includes the exchange: read peers' proposals, answer questions put to you, and revise or defend your position. Don't finish while you owe a peer an answer; \`board_wait\` for an answer you need. Read tasks with \`board_read_todos\` (query list with available/open/mine/all, or query get with todoId); read discussion context separately. Use \`board_todo_action\` with a stable request_key and a semantic action. Every non-create action needs the current expectedVersion; start/complete/release infer you as worker. Todo means manually ready, optionally reserved; start makes it working. Create future work directly as blocked with a reason, and unblock before starting. Release blocked work to retain its blocker; cancel withdrawn work with a reason rather than deleting it. Reassign/cancel/reopen/remove need a reason; acting on another owner's scope needs explicit override and a reason where supported. Changing a task owner does not transfer actual file ownership. Retry a lost response with the identical action/key; a replay is historical acknowledgement, not current task state. Recover conflicts from error.todoConflict.current or a point read, never by guessing a new version or owner. Todo completion asserts only your task result: it neither resolves a user-message request nor certifies peer agreement. Mutations create no posts, notifications, wakeups, or read markers; publish a separate useful discussion contribution when needed. Users observe todos; agents manage them.`,
  `Maintain discussion context and decision sources yourself with \`board_update_context\` when useful; the extra context field is optional and request execution already gathers the discussion goal, user corrections and reply sources. Do not ask the user to rewrite those into a context field. An automatic response assignment is not leadership: reply naturally in the discussion with \`board_append\`, then report the assigned outcomes; do not claim the lead just to answer. Greetings, thanks, corrections and status pings still deserve a response. For user requests, read current ownership, context, generations and revision with \`board_read_handling\`. Handle only your assigned contributions and report each explicit outcome with \`board_report_outcome\`, citing current source posts and your run id. Seen, a post, silence, and a finished turn do not establish an outcome. Never report another recipient's contribution as completed. A missing or blocked outcome needs attention; do not start another paid turn automatically. Use \`board_resume_request\` only when authorized for that selected request; unrelated held work stays held. Re-read on revision or generation conflicts. Close with \`board_close_discussion\` only after inspecting all required contributions through the latest revision, including older unresolved gaps. Reopening does not override Stop.
When your board task is finished, mark your actual todo done, then claim the next unassigned todo in your scope. Post one short result, relevant validation/limits, and that todo, or else an offer of help, in the same discussion. A handoff names its todo, next action and only relevant findings/files/tests. Address a coordinator or running teammate; finished peers need their delegating parent or user to resume them. With no concrete task, end normally: no polling, keepalive or repeated availability pings.`,
  `### Visuals and preview

- Answer data with a trend or comparison with a chart, and show any visual the user asks for here: pass its HTML to \`html_preview\`, then \`html_render\`. If the visual is a file, pass that file's HTML. A screenshot on disk or a text description does not show it. Never start a server for it. Tools a web page exposes give data only. Never use them to show results. Asked for an image to post, send, or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- Never use \`preview_*\` to verify or show your own edit, even a frontend edit or an open tab. Do not repeat preview calls from an earlier turn. Use them only when the current request asks for browser work or names a page or tab. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.`,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code browser

When browser work was asked, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.
`;

const T3_CODE_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## T3 Code devices

When a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel.${loadTools}
1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.
2. Call \`device_open\` with both. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.
3. Call \`device_screenshot\` to look at the screen.

Never do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device over ssh only when the user explicitly asks. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session; if it still fails, tell the user and stop, unless they explicitly asked you to drive it over ssh. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.`;

/** Device guidance for sessions holding the `device` capability, from top-level threads to delegated children. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${T3_CODE_DEVICE_TOOLS.map((tool) => `mcp__t3-code__${tool}`).join(",")}\`.`,
);

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp &&
    input.previousState.hasDeviceTools === input.state.hasDeviceTools
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [
          T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
          ...(input.state.hasDeviceTools ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS] : []),
          T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
          T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

const orchestrationInstructions = (hasDeviceTools: boolean) =>
  hasDeviceTools
    ? `${T3_CODE_ORCHESTRATION_INSTRUCTIONS}\n${T3_CODE_DEVICE_TOOL_INSTRUCTIONS}\n`
    : T3_CODE_ORCHESTRATION_INSTRUCTIONS;

function prependT3OrchestrationInstructions(prompt: string, instructions: string): string {
  return `<t3_code_orchestration_instructions>${instructions.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** For providers whose instructions ride on the prompt, so a compacted conversation loses them. */
export function t3OrchestrationPrompt(input: {
  readonly prompt: string;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly orchestrationDelivered: boolean;
  readonly deviceInstructionsDelivered: boolean;
}): string {
  if (!input.hasT3Mcp) return input.prompt;
  if (!input.orchestrationDelivered) {
    return prependT3OrchestrationInstructions(
      input.prompt,
      orchestrationInstructions(input.hasDeviceTools),
    );
  }
  return input.hasDeviceTools && !input.deviceInstructionsDelivered
    ? prependT3OrchestrationInstructions(input.prompt, T3_CODE_DEVICE_TOOL_INSTRUCTIONS)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  hasDeviceTools: boolean,
): string | undefined {
  return hasT3Mcp ? orchestrationInstructions(hasDeviceTools) : undefined;
}
