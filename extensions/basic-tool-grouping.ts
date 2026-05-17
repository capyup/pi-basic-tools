import { keyHint } from "@earendil-works/pi-coding-agent";
import { Container, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ROLE_GLYPHS, renderTreeRow, type VisualRole, type VisualStatus } from "./shared/visual.ts";
import { registerToolDefinitionOverride, retainToolExecutionPatch, tryInstallPatchSync } from "./tool-execution-patch.ts";

export type BasicToolRole = "inspect" | "search" | "write" | "run" | "network" | "ask" | "plan" | "default";

export type BasicToolSummary = {
  title?: string;
  target?: string;
  detail?: string;
  role?: BasicToolRole;
};

type ToolStatus = "pending" | "running" | "success" | "error";

type ToolItem = {
  toolCallId: string;
  toolName: string;
  groupId: number;
  index: number;
  status: ToolStatus;
  summary: BasicToolSummary;
  resultSummary?: BasicToolSummary;
  resultText?: string;
  isPartial?: boolean;
  hidden: boolean;
  invalidate?: () => void;
};

type ToolGroup = {
  id: number;
  items: ToolItem[];
  open: boolean;
  headToolCallId: string;
  visibleToolCallId: string;
  version: number;
};

type BasicToolGroupingState = {
  groups: Map<number, ToolGroup>;
  itemsByCallId: Map<string, ToolItem>;
  currentGroup?: ToolGroup;
  nextGroupId: number;
  installed: boolean;
  patchReleases: Array<() => Promise<void>>;
};

const BASIC_TOOL_NAMES = new Set([
  "read",
  "bash",
  // "edit" intentionally omitted — it has its own native diff UI via
  // renderShell:"self" + renderCall/renderResult; grouping would hide the diff.
  "grep",
  "find",
  "ls",
  "repo_map",
  "read_block",
  "symbol_outline",
  "apply_patch",
  "exec_command",
  // "write_stdin" intentionally omitted — its calls are aggregated onto the
  // parent exec_command row's meta (see stdinAggregator below) instead of
  // rendering as separate rows.
  "fetch",
  "sourcegraph",
  "fffind",
  "ffgrep",
  "fff-multi-grep",
  "todo",
]);

const STATE_KEY = Symbol.for("pi-basic-tools.basic-tool-grouping.state");
const STDIN_KEY = Symbol.for("pi-basic-tools.basic-tool-grouping.stdin");
const MAX_COLLAPSED_ITEMS = 5;
const MAX_GROUP_ITEMS = 12;

function getState(): BasicToolGroupingState {
  const existing = (globalThis as Record<PropertyKey, unknown>)[STATE_KEY];
  if (existing && typeof existing === "object") {
    const state = existing as BasicToolGroupingState;
    if (!Array.isArray(state.patchReleases)) state.patchReleases = [];
    return state;
  }
  const created: BasicToolGroupingState = {
    groups: new Map<number, ToolGroup>(),
    itemsByCallId: new Map<string, ToolItem>(),
    nextGroupId: 1,
    installed: false,
    patchReleases: [],
  };
  (globalThis as Record<PropertyKey, unknown>)[STATE_KEY] = created;
  return created;
}

type StdinCounts = { polls: number; writes: number; interrupts: number };

type StdinAggregatorState = {
  countsBySession: Map<string, StdinCounts>;
  // session_id → toolCallId of the parent exec_command row.
  execCommandBySession: Map<string, string>;
};

function getStdinState(): StdinAggregatorState {
  const existing = (globalThis as Record<PropertyKey, unknown>)[STDIN_KEY];
  if (existing && typeof existing === "object") return existing as StdinAggregatorState;
  const created: StdinAggregatorState = {
    countsBySession: new Map<string, StdinCounts>(),
    execCommandBySession: new Map<string, string>(),
  };
  (globalThis as Record<PropertyKey, unknown>)[STDIN_KEY] = created;
  return created;
}

const state = getState();
const stdinState = getStdinState();

function classifyStdinChars(chars: unknown): "polls" | "writes" | "interrupts" {
  if (chars === "") return "interrupts";
  if (typeof chars === "string" && chars.length > 0) return "writes";
  return "polls";
}

function recordStdinCall(sessionId: string | undefined, chars: unknown): void {
  if (!sessionId) return;
  const counts = stdinState.countsBySession.get(sessionId) ?? { polls: 0, writes: 0, interrupts: 0 };
  counts[classifyStdinChars(chars)] += 1;
  stdinState.countsBySession.set(sessionId, counts);
  const parent = stdinState.execCommandBySession.get(sessionId);
  if (parent) {
    const parentItem = state.itemsByCallId.get(parent);
    if (parentItem) {
      bumpGroup(groupFor(parentItem));
      parentItem.invalidate?.();
    }
  }
}

function recordExecCommandSession(toolCallId: string, sessionId: string | undefined): void {
  if (!sessionId) return;
  stdinState.execCommandBySession.set(sessionId, toolCallId);
  const parentItem = state.itemsByCallId.get(toolCallId);
  if (parentItem) {
    bumpGroup(groupFor(parentItem));
    parentItem.invalidate?.();
  }
}

function execCommandSessionFor(item: ToolItem): string | undefined {
  for (const [sessionId, callId] of stdinState.execCommandBySession) {
    if (callId === item.toolCallId) return sessionId;
  }
  return undefined;
}

function stdinMetaFor(item: ToolItem): string | undefined {
  if (item.toolName !== "exec_command") return undefined;
  const sessionId = execCommandSessionFor(item);
  if (!sessionId) return undefined;
  const counts = stdinState.countsBySession.get(sessionId);
  if (!counts) return undefined;
  const parts: string[] = [];
  if (counts.polls > 0) parts.push(`${counts.polls} poll${counts.polls === 1 ? "" : "s"}`);
  if (counts.writes > 0) parts.push(`${counts.writes} write${counts.writes === 1 ? "" : "s"}`);
  if (counts.interrupts > 0) parts.push(`${counts.interrupts} interrupt${counts.interrupts === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function safeKeyHint(keybinding: string, description: string): string {
  try {
    return keyHint(keybinding, description);
  } catch {
    return `(${description})`;
  }
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

function textContent(result: any): string {
  const content = result?.content?.[0];
  return content?.type === "text" && typeof content.text === "string" ? content.text : "";
}

function hasMeaningfulNonToolContent(part: any): boolean {
  if (typeof part === "string") return part.trim().length > 0;
  if (!part || typeof part !== "object") return false;
  if (typeof part.text === "string") return part.text.trim().length > 0;
  if (typeof part.content === "string") return part.content.trim().length > 0;
  return false;
}

function lineCount(text: string): number {
  return text.split("\n").filter((line) => line.trim()).length;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function isBasicTool(toolName: string | undefined): boolean {
  return !!toolName && BASIC_TOOL_NAMES.has(toolName);
}

function closeCurrentGroup(): void {
  if (state.currentGroup) state.currentGroup.open = false;
  state.currentGroup = undefined;
}

function createGroup(firstToolCallId: string): ToolGroup {
  const group: ToolGroup = {
    id: state.nextGroupId++,
    items: [],
    open: true,
    headToolCallId: firstToolCallId,
    visibleToolCallId: firstToolCallId,
    version: 0,
  };
  state.groups.set(group.id, group);
  state.currentGroup = group;
  return group;
}

function getOrCreateItem(toolName: string, toolCallId: string, summary: BasicToolSummary): ToolItem {
  const existing = state.itemsByCallId.get(toolCallId);
  if (existing) {
    existing.summary = mergeSummary(existing.summary, summary);
    return existing;
  }

  if (state.currentGroup?.open && state.currentGroup.items.length >= MAX_GROUP_ITEMS) {
    closeCurrentGroup();
  }
  const group = state.currentGroup?.open ? state.currentGroup : createGroup(toolCallId);
  const previousVisible = state.itemsByCallId.get(group.visibleToolCallId);
  if (previousVisible) {
    previousVisible.hidden = true;
    previousVisible.invalidate?.();
  }
  const item: ToolItem = {
    toolCallId,
    toolName,
    groupId: group.id,
    index: group.items.length,
    status: "pending",
    summary,
    hidden: false,
  };
  group.items.push(item);
  group.visibleToolCallId = toolCallId;
  state.itemsByCallId.set(toolCallId, item);
  bumpGroup(group);
  return item;
}

function groupFor(item: ToolItem): ToolGroup | undefined {
  return state.groups.get(item.groupId);
}

function bumpGroup(group: ToolGroup | undefined): void {
  if (group) group.version += 1;
}

function roleForTool(toolName: string): BasicToolRole {
  if (["read", "read_block", "symbol_outline", "repo_map", "ls"].includes(toolName)) return "inspect";
  if (["grep", "find", "sourcegraph", "fffind", "ffgrep", "fff-multi-grep"].includes(toolName)) return "search";
  if (["apply_patch"].includes(toolName)) return "write";
  if (["bash", "exec_command", "write_stdin"].includes(toolName)) return "run";
  if (["fetch"].includes(toolName)) return "network";
  if (["todo"].includes(toolName)) return "plan";
  return "default";
}

function displaySummary(item: ToolItem): BasicToolSummary {
  return item.resultSummary ?? item.summary;
}

function statusFor(item: ToolItem): VisualStatus {
  if (item.status === "error") return "error";
  if (item.status === "pending" || item.status === "running") return "running";
  return "done";
}

function visualRoleFor(item: ToolItem): VisualRole {
  const raw = item.resultSummary?.role ?? item.summary.role ?? roleForTool(item.toolName);
  switch (raw) {
    case "inspect":
    case "search":
    case "write":
    case "run":
    case "network":
    case "plan":
    case "ask":
      return raw;
    default:
      return "default";
  }
}

function mergeMeta(...parts: Array<string | undefined>): string | undefined {
  const list = parts.filter((part): part is string => typeof part === "string" && part.length > 0);
  return list.length > 0 ? list.join(" · ") : undefined;
}

function formatTreeItem(item: ToolItem, theme: any, width: number, isLast: boolean): string[] {
  const headline = actionHeadline(item);
  const summary = displaySummary(item);
  return renderTreeRow({
    theme,
    width,
    isLast,
    role: visualRoleFor(item),
    status: statusFor(item),
    headline,
    meta: mergeMeta(summary.detail, stdinMetaFor(item)),
  });
}

/**
 * Build the single-line per-call headline. The verb is rolled into the line
 * itself (Read foo.ts, Search needle, Ran git status, …) so consecutive calls
 * render as one line each instead of a 2-line `Explored / └ Read X` box. The
 * umbrella verb still appears once per group via groupTitle() (Explored N
 * targets / Used N tools / …).
 *
 * The headline does NOT include the result detail (`· 2 lines`); that is
 * rendered as separate meta in renderTreeRow / BasicToolItemComponent so the
 * marker, headline, and meta columns stay visually distinct.
 */
function actionHeadline(item: ToolItem): string {
  const summary = displaySummary(item);
  const target = summary.target;
  const title = summary.title;

  if (item.toolName === "bash" || item.toolName === "exec_command")
    return `Ran ${target ?? title ?? item.toolName}`;
  if (item.toolName === "write_stdin") {
    const verb = title ?? "stdin";
    const tag = target ? ` ${target}` : "";
    return `${verb}${tag}`;
  }
  if (item.toolName === "apply_patch") return "Edited";
  if (item.toolName === "grep" || item.toolName === "ffgrep")
    return `Search ${target ?? ""}`.trim();
  if (item.toolName === "fff-multi-grep") return `Search ${target ?? ""}`.trim();
  if (item.toolName === "find" || item.toolName === "fffind")
    return `Find ${target ?? ""}`.trim();
  if (item.toolName === "ls") return `List ${target ?? "."}`;
  if (item.toolName === "read" || item.toolName === "read_block")
    return `Read ${target ?? title ?? item.toolName}`;
  if (item.toolName === "symbol_outline") return `Outline ${target ?? ""}`.trim();
  if (item.toolName === "repo_map") return `Map ${target ?? "project"}`;
  if (item.toolName === "fetch") return target ? `Fetched ${target}` : "Fetched";
  if (item.toolName === "sourcegraph") return `Search Sourcegraph ${target ?? ""}`.trim();
  if (item.toolName === "todo") {
    // todo callers wire their verb into summary.title (Added / Started /
    // Done / Reopened / Updated / Removed / Listed todos / Cleared todos /
    // Read todo). Target is the subject line; detail (post-result outcome
    // like `#3 pending`) flows through the meta column.
    const verb = title ?? "todo";
    return `${verb}${target ? ` ${target}` : ""}`;
  }

  if (title) return `${title} ${target ?? ""}`.trim();
  const parts: string[] = [];
  if (summary.title) parts.push(summary.title);
  if (summary.target) parts.push(summary.target);
  return parts.join(" ") || item.toolName;
}

function groupStatus(group: ToolGroup): "running" | "error" | "done" {
  if (group.items.some((item) => item.status === "error")) return "error";
  if (group.items.some((item) => item.status === "pending" || item.status === "running")) return "running";
  return "done";
}

function plural(noun: string, count: number): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function roleFragment(role: BasicToolRole, count: number): string {
  switch (role) {
    case "run": return `ran ${plural("command", count)}`;
    case "write": return `edited ${plural("file", count)}`;
    case "search": return `searched ${plural("pattern", count)}`;
    case "inspect": return `read ${plural("file", count)}`;
    case "network": return `fetched ${plural("resource", count)}`;
    case "plan": return `tracked ${plural("todo", count)}`;
    case "ask": return `asked ${plural("question", count)}`;
    default: return `used ${plural("tool", count)}`;
  }
}

const ROLE_DISPLAY_ORDER: BasicToolRole[] = ["run", "write", "search", "inspect", "network", "plan", "ask", "default"];

function groupTitle(group: ToolGroup): string {
  const roles = group.items.map((item) => item.resultSummary?.role ?? item.summary.role ?? roleForTool(item.toolName));
  const total = group.items.length;
  if (roles.every((role) => role === "run")) return `Ran ${plural("command", total)}`;
  if (roles.every((role) => role === "write")) return `Edited ${plural("file", total)}`;
  if (roles.every((role) => role === "inspect" || role === "search")) return `Explored ${plural("target", total)}`;
  if (roles.every((role) => role === "network")) return `Fetched ${plural("resource", total)}`;
  if (roles.every((role) => role === "plan")) return `Tracked ${plural("todo", total)}`;

  const counts = new Map<BasicToolRole, number>();
  for (const role of roles) counts.set(role, (counts.get(role) ?? 0) + 1);
  const parts: string[] = [];
  for (const role of ROLE_DISPLAY_ORDER) {
    const count = counts.get(role);
    if (count) parts.push(roleFragment(role, count));
  }
  if (parts.length === 0) return `Used ${plural("tool", total)}`;
  parts[0] = parts[0][0].toUpperCase() + parts[0].slice(1);
  return parts.join(", ");
}

function renderGroupLines(group: ToolGroup, expanded: boolean, theme: any, width: number): string[] {
  const status = groupStatus(group);
  const titleRole = status === "error" ? "error" : status === "running" ? "warning" : "muted";

  const maxItems = expanded ? 80 : MAX_COLLAPSED_ITEMS;
  const visible = group.items.slice(-maxItems);
  const lines = [theme.fg(titleRole, groupTitle(group))];
  for (let index = 0; index < visible.length; index += 1) {
    const item = visible[index]!;
    const isLast = index === visible.length - 1;
    lines.push(...formatTreeItem(item, theme, width, isLast));
  }
  const hidden = group.items.length - visible.length;
  if (expanded && hidden > 0) lines.push(theme.fg("muted", `… ${hidden} earlier call${hidden === 1 ? "" : "s"}`));
  if (!expanded) lines.push(theme.fg("muted", safeKeyHint("app.tools.expand", "to expand")));
  return lines;
}

class BasicToolGroupComponent implements Component {
  private cacheKey?: string;
  private cachedLines?: string[];

  constructor(
    private readonly item: ToolItem,
    private readonly group: ToolGroup,
    private readonly theme: any,
    private readonly expanded: boolean,
  ) {}

  render(width: number): string[] {
    // Only the slot owned by the group's most recently added tool call should
    // render the group. Earlier slots stay empty so the group block doesn't
    // duplicate once every tool call gets its own ToolExecutionComponent.
    if (this.item.hidden) return [];
    const cacheKey = `${width}:${this.group.version}:${this.expanded ? 1 : 0}`;
    if (this.cachedLines && this.cacheKey === cacheKey) return this.cachedLines;
    const lines = renderGroupLines(this.group, this.expanded, this.theme, width);
    this.cacheKey = cacheKey;
    this.cachedLines = lines.map((line) => truncateToWidth(line, Math.max(1, width)));
    return this.cachedLines;
  }

  invalidate(): void {
    this.cacheKey = undefined;
    this.cachedLines = undefined;
  }
}

class BasicToolItemComponent implements Component {
  constructor(
    private readonly item: ToolItem,
    private readonly theme: any,
  ) {}

  render(width: number): string[] {
    if (this.item.hidden) return [];

    const headline = actionHeadline(this.item);
    const summary = displaySummary(this.item);
    const status = statusFor(this.item);
    const role = visualRoleFor(this.item);
    const marker = (() => {
      if (status === "error") return { glyph: "!", color: "error" };
      if (status === "running") return { glyph: "◐", color: "warning" };
      return { glyph: ROLE_GLYPHS[role] ?? "·", color: "muted" };
    })();
    const textColor = status === "error" ? "error" : "muted";
    const headlinePainted = this.theme.fg(textColor, headline);
    const meta = mergeMeta(summary.detail, stdinMetaFor(this.item));
    const metaPainted = meta ? this.theme.fg(textColor, `  · ${meta}`) : "";
    const line = `${this.theme.fg(marker.color, marker.glyph)} ${headlinePainted}${metaPainted}`;
    return [truncateToWidth(line, Math.max(1, width), "")];
  }

  invalidate(): void {}
}

function emptyComponent(): Component {
  return new Container();
}

function mergeSummary(previous: BasicToolSummary, next: BasicToolSummary): BasicToolSummary {
  return {
    title: next.title ?? previous.title,
    target: next.target ?? previous.target,
    detail: next.detail ?? previous.detail,
    role: next.role ?? previous.role,
  };
}

export function canGroupTool(context: any): boolean {
  return typeof context?.toolCallId === "string" && context.toolCallId.length > 0;
}

export function resetBasicToolGroupingForTests(): void {
  state.groups.clear();
  state.itemsByCallId.clear();
  state.currentGroup = undefined;
  state.nextGroupId = 1;
  state.installed = false;
  stdinState.countsBySession.clear();
  stdinState.execCommandBySession.clear();
}

// Tools registered by other extensions whose call/result rendering we want to
// reroute through our grouping UI. Each name gets a renderShell: "self" +
// renderCall/renderResult override that delegates to renderGroupedToolCall /
// renderGroupedToolResult. The underlying registerTool definition (execute,
// schema, prompt guidelines) stays with its owning extension — only the UI
// path changes. See extensions/tool-execution-patch.ts for the prototype
// patch that consults the override registry.
const OVERRIDDEN_FOREIGN_TOOLS = ["fffind", "ffgrep", "fff-multi-grep"] as const;

function registerForeignToolOverrides(): void {
  for (const toolName of OVERRIDDEN_FOREIGN_TOOLS) {
    registerToolDefinitionOverride(toolName, {
      renderShell: "self",
      renderCall(args, theme, context) {
        return renderGroupedToolCall(
          toolName,
          (args ?? {}) as Record<string, any>,
          theme,
          context,
          summarizeToolCall(toolName, (args ?? {}) as Record<string, any>),
        );
      },
      renderResult(result, options, theme, context) {
        return renderGroupedToolResult(toolName, result, (options ?? {}) as { expanded?: boolean; isPartial?: boolean }, theme, context);
      },
    });
  }
}

export function installBasicToolGrouping(pi: { on?: (event: string, handler: Function) => void }): void {
  if (state.installed || typeof pi.on !== "function") return;
  state.installed = true;

  // Make pi-fff's fffind / ffgrep / fff-multi-grep render through our grouping
  // UI (the renderer overrides are idempotent: last write wins).
  registerForeignToolOverrides();

  // Pi may emit turn_start/agent_start while continuing after a tool result, so
  // only user messages and non-basic tool calls act as grouping boundaries.
  pi.on("message_start", (event: any) => {
    const role = event?.message?.role;
    if (role === "user") closeCurrentGroup();
  });
  pi.on("tool_execution_start", (event: any) => {
    const toolName = event?.toolName ?? event?.name ?? event?.tool?.name ?? event?.toolCall?.name;
    if (typeof toolName === "string" && !isBasicTool(toolName)) closeCurrentGroup();
  });
  pi.on("message_update", (event: any) => {
    const content = event?.message?.content;
    if (!Array.isArray(content)) return;
    let previousWasBasic = false;
    let sequenceGroup: ToolGroup | undefined;
    for (const part of content) {
      if (part?.type !== "toolCall") {
        previousWasBasic = false;
        if (hasMeaningfulNonToolContent(part)) {
          if (sequenceGroup) sequenceGroup.open = false;
          sequenceGroup = undefined;
          closeCurrentGroup();
        }
        continue;
      }
      if (part.name === "write_stdin") {
        const args = part.arguments ?? {};
        const sessionId = typeof args?.session_id === "string" ? args.session_id : undefined;
        recordStdinCall(sessionId, args?.chars);
        continue;
      }
      const basic = isBasicTool(part.name);
      if (!basic) {
        previousWasBasic = false;
        if (sequenceGroup) sequenceGroup.open = false;
        sequenceGroup = undefined;
        closeCurrentGroup();
        continue;
      }

      const existing = state.itemsByCallId.get(String(part.id));
      if (existing) {
        sequenceGroup = groupFor(existing);
        state.currentGroup = sequenceGroup?.open ? sequenceGroup : undefined;
        existing.summary = mergeSummary(existing.summary, summarizeToolCall(part.name, part.arguments ?? {}));
        bumpGroup(sequenceGroup);
        previousWasBasic = true;
        continue;
      }

      if (sequenceGroup?.open) {
        state.currentGroup = sequenceGroup;
      } else if (state.currentGroup?.open) {
        sequenceGroup = state.currentGroup;
      } else {
        state.currentGroup = undefined;
      }
      const item = getOrCreateItem(part.name, String(part.id), summarizeToolCall(part.name, part.arguments ?? {}));
      sequenceGroup = groupFor(item);
      previousWasBasic = true;
    }
  });
  pi.on("tool_result", (event: any) => {
    return compactExternalBasicToolResult(event);
  });

  // Patch Pi's ToolExecutionComponent so wrappers around hidden grouped tools
  // collapse to zero lines (otherwise the constructor's unconditional Spacer
  // produces one stacked blank line per hidden tool — see
  // extensions/tool-execution-patch.ts for the full explanation).
  //
  // Try synchronous require() first — this patches the prototype immediately
  // during extension load, before any render cycle runs. If the CJS require
  // fails (e.g. ESM-only build), fall back to the async dynamic import path.
  if (!tryInstallPatchSync()) {
    retainToolExecutionPatch()
      .then((release) => state.patchReleases.push(release))
      .catch((error) => console.warn(`pi-basic-tools basic-tool-grouping: tool-execution patch unavailable (${error instanceof Error ? error.message : String(error)})`));
  }

  pi.on("session_shutdown", async () => {
    const release = state.patchReleases.pop();
    if (!release) return;
    try {
      await release();
    } catch (error) {
      state.patchReleases.push(release);
      console.warn(`pi-basic-tools basic-tool-grouping: tool-execution patch release failed (${error instanceof Error ? error.message : String(error)})`);
    }
  });
}

export function compactExternalBasicToolResult(event: any): { content: Array<{ type: "text"; text: string }>; details?: unknown } | undefined {
  const toolName = event?.toolName;
  if (!["fffind", "ffgrep", "fff-multi-grep"].includes(toolName)) return undefined;

  const input = event?.input ?? {};
  const details = event?.details ?? {};
  const text = Array.isArray(event?.content) ? textContent({ content: event.content }) : "";
  const count = Number.isFinite(details.totalMatched) ? Number(details.totalMatched) : lineCount(text);
  const files = Number.isFinite(details.totalFiles) ? Number(details.totalFiles) : undefined;
  const target = firstString(input.pattern, Array.isArray(input.patterns) ? input.patterns.join(", ") : undefined, input.path, input.constraints, ".");
  const action = toolName === "fffind" ? "Find" : "Search";
  const scope = firstString(input.path, input.constraints);
  const countLabel = files === undefined ? `${count} result${count === 1 ? "" : "s"}` : `${count} result${count === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`;
  const scopeLabel = scope && scope !== target ? ` in ${scope}` : "";
  const textResult = `${action} ${target ?? ""}${scopeLabel} · ${countLabel}`.trim();

  return {
    content: [{ type: "text", text: textResult }],
    details: {
      ...details,
      compactedForDisplay: true,
      originalLineCount: lineCount(text),
    },
  };
}

export function summarizeToolCall(toolName: string, args: Record<string, any> = {}): BasicToolSummary {
  const role = roleForTool(toolName);
  const path = typeof args.path === "string" ? args.path : undefined;
  const command = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : undefined;
  if (toolName === "bash" && command) return { title: "run", target: collapseWhitespace(command), role };
  if (toolName === "exec_command" && command) return { title: "exec", target: collapseWhitespace(command), role };
  if (toolName === "write_stdin") return { title: "stdin", target: args.session_id ? `#${args.session_id}` : undefined, detail: args.chars === "\u0003" ? "interrupt" : args.chars ? "write" : "poll", role };
  if (toolName === "grep") return { title: "grep", target: args.pattern ? String(args.pattern) : path, role };
  if (toolName === "ffgrep") return { title: "ffgrep", target: args.pattern ? String(args.pattern) : path, role };
  if (toolName === "fff-multi-grep") return { title: "fff multi grep", target: Array.isArray(args.patterns) ? args.patterns.join(", ") : args.constraints ? String(args.constraints) : undefined, role };
  if (toolName === "find") return { title: "find", target: args.pattern ? String(args.pattern) : path, role };
  if (toolName === "fffind") return { title: "fffind", target: args.pattern ? String(args.pattern) : path, role };
  if (toolName === "ls") return { title: "ls", target: path ?? ".", role };
  if (toolName === "read_block") return { title: "read block", target: path, detail: args.symbol ? String(args.symbol) : args.line ? `L${args.line}` : undefined, role };
  if (toolName === "symbol_outline") return { title: "outline", target: path, role };
  if (toolName === "repo_map") return { title: "repo map", target: path ?? ".", role };
  if (toolName === "apply_patch") return { title: "apply patch", role };
  if (toolName === "fetch") return { title: "fetch", target: args.url ? String(args.url) : undefined, role };
  if (toolName === "sourcegraph") return { title: "sourcegraph", target: args.query ? String(args.query) : undefined, role };
  if (toolName === "todo") {
    // Baseline summary for todo calls. The dedicated renderer at
    // extensions/todo/render.ts overrides this with the action-aware
    // verb/target before passing the summary to renderGroupedToolCall.
    return { title: "todo", role };
  }
  if (path) return { title: toolName, target: basename(path), role };
  return { title: toolName, role };
}

export function summarizeToolResult(toolName: string, result: any, fallback?: BasicToolSummary): BasicToolSummary {
  const details = result?.details ?? {};
  const text = textContent(result);
  const role = fallback?.role ?? roleForTool(toolName);

  if (toolName === "read_block" && details.displayPath) return { title: "read block", target: `${details.displayPath}:${details.outputStart}-${details.outputEnd}`, role };
  if (toolName === "symbol_outline" && details.displayPath) return { title: "outline", target: details.displayPath, detail: `${details.displayedCount ?? details.blockCount ?? 0} blocks`, role };
  if (toolName === "repo_map" && details.root) return { title: "repo map", target: basename(String(details.root)), detail: `${details.fileCount ?? "?"} files`, role };
  if (toolName === "apply_patch") return { title: "apply patch", detail: `${details.totalFiles ?? 0} files`, role };
  if (["fffind", "ffgrep", "fff-multi-grep"].includes(toolName)) {
    // pi-fff returns details.totalMatched / details.totalFiles (also preserved
    // by compactExternalBasicToolResult). Build a meaningful "N results in M
    // files" detail instead of the post-compaction "1 lines".
    const matched = Number(details.totalMatched);
    const files = Number(details.totalFiles);
    const parts: string[] = [];
    if (Number.isFinite(matched)) parts.push(`${matched} result${matched === 1 ? "" : "s"}`);
    if (Number.isFinite(files) && files > 0) parts.push(`in ${files} file${files === 1 ? "" : "s"}`);
    if (parts.length === 0 && text) parts.push(`${lineCount(text)} lines`);
    return { ...(fallback ?? { title: toolName, role }), detail: parts.join(" ") || undefined };
  }
  if (["grep", "find", "ls"].includes(toolName)) return { ...(fallback ?? { title: toolName, role }), detail: `${lineCount(text)} lines` };
  if (toolName === "bash") return { ...(fallback ?? { title: "run", role }), detail: result?.isError ? "failed" : `${lineCount(text)} output lines` };
  if (toolName === "read") return { ...(fallback ?? { title: "read", role }), detail: `${lineCount(text)} lines` };
  if (toolName === "write") return { ...(fallback ?? { title: "write", role }), detail: "written" };
  if (toolName === "edit") return { ...(fallback ?? { title: "edit", role }), detail: "edited" };
  return fallback ?? { title: toolName, detail: text ? `${lineCount(text)} lines` : undefined, role };
}

export function renderGroupedToolCall(toolName: string, args: Record<string, any>, theme: any, context: any, summary: BasicToolSummary = summarizeToolCall(toolName, args)): Component {
  if (toolName === "write_stdin") {
    const sessionId = typeof args?.session_id === "string" ? args.session_id : undefined;
    recordStdinCall(sessionId, args?.chars);
    return emptyComponent();
  }
  if (!isBasicTool(toolName)) return emptyComponent();
  if (!canGroupTool(context)) return emptyComponent();
  const toolCallId = String(context.toolCallId);
  const item = getOrCreateItem(toolName, toolCallId, summary);
  if (typeof context?.invalidate === "function") item.invalidate = context.invalidate;
  const nextStatus = context?.executionStarted ? "running" : item.status;
  if (item.status !== nextStatus) {
    item.status = nextStatus;
    bumpGroup(groupFor(item));
  }
  const group = groupFor(item);
  if (group && group.items.length > 1) return new BasicToolGroupComponent(item, group, theme, !!context?.expanded);
  return new BasicToolItemComponent(item, theme);
}

export function renderGroupedToolResult(toolName: string, result: any, options: { expanded?: boolean; isPartial?: boolean }, theme: any, context: any, summary?: BasicToolSummary): Component {
  if (toolName === "write_stdin") return emptyComponent();
  if (!isBasicTool(toolName)) return emptyComponent();
  if (toolName === "exec_command") {
    const sessionId = result?.details?.session_id;
    if (typeof sessionId === "string" && context?.toolCallId) {
      recordExecCommandSession(String(context.toolCallId), sessionId);
    }
  }
  if (!canGroupTool(context)) return emptyComponent();
  const toolCallId = String(context.toolCallId);
  const item = getOrCreateItem(toolName, toolCallId, summary ?? summarizeToolCall(toolName, context?.args ?? {}));
  const nextStatus = result?.isError ? "error" : options.isPartial ? "running" : "success";
  item.status = nextStatus;
  item.isPartial = options.isPartial;
  item.resultText = textContent(result);
  item.resultSummary = summarizeToolResult(toolName, result, item.summary);
  bumpGroup(groupFor(item));
  return emptyComponent();
}
