import { keyHint } from "@earendil-works/pi-coding-agent";
import { Container, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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
};

const BASIC_TOOL_NAMES = new Set([
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "repo_map",
  "read_block",
  "symbol_outline",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "fetch",
  "sourcegraph",
  "fffind",
  "ffgrep",
  "fff-multi-grep",
  "todo",
]);

const STATE_KEY = Symbol.for("pi-basic-tools.basic-tool-grouping.state");
const MAX_COLLAPSED_ITEMS = 5;
const MAX_GROUP_ITEMS = 12;

function getState(): BasicToolGroupingState {
  const existing = (globalThis as Record<PropertyKey, unknown>)[STATE_KEY];
  if (existing && typeof existing === "object") return existing as BasicToolGroupingState;
  const created: BasicToolGroupingState = {
    groups: new Map<number, ToolGroup>(),
    itemsByCallId: new Map<string, ToolItem>(),
    nextGroupId: 1,
    installed: false,
  };
  (globalThis as Record<PropertyKey, unknown>)[STATE_KEY] = created;
  return created;
}

const state = getState();

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

function roleIcon(item: ToolItem): string {
  if (item.status === "error") return "!";
  if (item.status === "success") return "✓";
  if (item.status === "running") return "·";
  const role = item.resultSummary?.role ?? item.summary.role ?? roleForTool(item.toolName);
  switch (role) {
    case "inspect": return "◫";
    case "search": return "⌕";
    case "write": return "✎";
    case "run": return "◇";
    case "network": return "↗";
    case "ask": return "?";
    default: return "·";
  }
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

function statusRole(item: ToolItem): string {
  if (item.status === "error") return "error";
  if (item.status === "running" || item.status === "pending") return "warning";
  return "muted";
}

function displaySummary(item: ToolItem): BasicToolSummary {
  return item.resultSummary ?? item.summary;
}

function joinSummaryParts(summary: BasicToolSummary): string {
  const parts: string[] = [];
  if (summary.title) parts.push(summary.title);
  if (summary.target) parts.push(summary.target);
  if (summary.detail) parts.push(`· ${summary.detail}`);
  return parts.join(" ");
}

const MAX_ACTION_CONTINUATION_LINES = 3;

/**
 * Build the single-line per-call headline. The verb is rolled into the line
 * itself (Read foo.ts, Search needle, Ran git status, …) so that consecutive
 * calls render as one line each instead of the old 2-line `Explored / └ Read X`
 * box. The umbrella verb still appears once per group via groupTitle()
 * (Explored N targets / Used N tools / …), so the action category stays
 * obvious without N copies of the same word.
 */
function actionHeadline(item: ToolItem): string {
  const summary = displaySummary(item);
  const target = summary.target;
  const detail = summary.detail;
  const title = summary.title;
  const suffix = detail ? ` · ${detail}` : "";

  if (item.toolName === "bash" || item.toolName === "exec_command")
    return `Ran ${target ?? title ?? item.toolName}${suffix}`;
  if (item.toolName === "write_stdin") {
    const verb = title ?? "stdin";
    const tag = target ? ` ${target}` : "";
    return `${verb}${tag}${suffix}`;
  }
  if (item.toolName === "apply_patch") return `Edited${detail ? ` · ${detail}` : ""}`;
  if (item.toolName === "grep" || item.toolName === "ffgrep")
    return `Search ${target ?? ""}${suffix}`.trim();
  if (item.toolName === "fff-multi-grep") return `Search ${target ?? ""}${suffix}`.trim();
  if (item.toolName === "find" || item.toolName === "fffind")
    return `Find ${target ?? ""}${suffix}`.trim();
  if (item.toolName === "ls") return `List ${target ?? "."}${suffix}`;
  if (item.toolName === "read" || item.toolName === "read_block")
    return `Read ${target ?? title ?? item.toolName}${suffix}`;
  if (item.toolName === "symbol_outline") return `Outline ${target ?? ""}${suffix}`.trim();
  if (item.toolName === "repo_map") return `Map ${target ?? "project"}${suffix}`;
  if (item.toolName === "fetch") return target ? `Fetched ${target}${suffix}` : `Fetched${suffix}`;
  if (item.toolName === "sourcegraph") return `Search Sourcegraph ${target ?? ""}${suffix}`.trim();
  if (item.toolName === "todo") {
    // todo callers wire their verb into summary.title (Added / Started /
    // Done / Reopened / Updated / Removed / Listed todos / Cleared todos
    // / Read todo). Target is the subject line; detail is the post-result
    // outcome (e.g. `#3 pending`).
    const verb = title ?? "todo";
    return `${verb}${target ? ` ${target}` : ""}${suffix}`;
  }

  const fallback = joinSummaryParts(summary);
  if (title) return `${title} ${target ?? ""}${suffix}`.trim();
  return fallback || item.toolName;
}

function splitToWidth(text: string, width: number): { head: string; tail: string } {
  const maxWidth = Math.max(1, width);
  let used = 0;
  let index = 0;
  let lastBreakIndex = 0;
  for (const char of text) {
    const charWidth = visibleWidth(char);
    if (used + charWidth > maxWidth) break;
    used += charWidth;
    index += char.length;
    if (/\s/.test(char)) lastBreakIndex = index;
  }
  const breakWidth = lastBreakIndex > 0 ? visibleWidth(text.slice(0, lastBreakIndex).trimEnd()) : 0;
  const splitIndex = index < text.length && breakWidth >= maxWidth * 0.55 ? lastBreakIndex : index;
  return { head: text.slice(0, splitIndex).trimEnd(), tail: text.slice(splitIndex).trimStart() };
}

function wrapActionLine(marker: string, headline: string, theme: any, item: ToolItem, width: number): string[] {
  const statusColor = statusRole(item);
  const headlineRole = item.status === "error" ? "error" : "muted";
  const firstPrefix = `${theme.fg(statusColor, marker)} `;
  const continuationPrefix = `  ${theme.fg("muted", "│")} `;
  const firstWidth = Math.max(1, width - visibleWidth(`${marker} `));
  const continuationWidth = Math.max(1, width - visibleWidth("  │ "));
  const first = splitToWidth(headline, firstWidth);
  const lines = [`${firstPrefix}${theme.fg(headlineRole, first.head || headline)}`];
  let rest = first.tail;
  for (let index = 0; rest && index < MAX_ACTION_CONTINUATION_LINES; index += 1) {
    const part = splitToWidth(rest, continuationWidth);
    const suffix = part.tail && index === MAX_ACTION_CONTINUATION_LINES - 1 ? "..." : "";
    lines.push(`${continuationPrefix}${theme.fg(headlineRole, `${part.head}${suffix}`)}`);
    rest = suffix ? "" : part.tail;
  }
  return lines;
}

function formatCompactItem(item: ToolItem, theme: any, width: number): string[] {
  const headline = actionHeadline(item);
  // Marker shape encodes state so item text can stay muted in all non-error
  // cases:  running -> warning ◐ , error -> error ! , done -> muted • .
  let marker: string;
  if (item.status === "error") marker = "!";
  else if (item.status === "running" || item.status === "pending") marker = "◐";
  else marker = "•";
  return wrapActionLine(marker, headline, theme, item, width);
}

function groupStatus(group: ToolGroup): "running" | "error" | "done" {
  if (group.items.some((item) => item.status === "error")) return "error";
  if (group.items.some((item) => item.status === "pending" || item.status === "running")) return "running";
  return "done";
}

function plural(noun: string, count: number): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function groupTitle(group: ToolGroup): string {
  const roles = group.items.map((item) => item.resultSummary?.role ?? item.summary.role ?? roleForTool(item.toolName));
  const total = group.items.length;
  if (roles.every((role) => role === "run")) return `Ran ${plural("command", total)}`;
  if (roles.every((role) => role === "write")) return `Edited ${plural("file", total)}`;
  if (roles.every((role) => role === "inspect" || role === "search")) return `Explored ${plural("target", total)}`;
  if (roles.every((role) => role === "network")) return `Fetched ${plural("resource", total)}`;
  if (roles.every((role) => role === "plan")) return `Tracked ${plural("todo", total)}`;
  return `Used ${plural("tool", total)}`;
}

function renderGroupLines(group: ToolGroup, expanded: boolean, theme: any, width: number): string[] {
  const status = groupStatus(group);
  const titleRole = status === "error" ? "error" : status === "running" ? "warning" : "muted";

  const maxItems = expanded ? 80 : MAX_COLLAPSED_ITEMS;
  const visible = group.items.slice(-maxItems);
  const lines = [theme.fg(titleRole, groupTitle(group))];
  for (const item of visible) {
    lines.push(...formatCompactItem(item, theme, width));
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
    private readonly group: ToolGroup,
    private readonly theme: any,
    private readonly expanded: boolean,
  ) {}

  render(width: number): string[] {
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
    return formatCompactItem(this.item, this.theme, width).map((line) => truncateToWidth(line, Math.max(1, width)));
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
}

export function installBasicToolGrouping(pi: { on?: (event: string, handler: Function) => void }): void {
  if (state.installed || typeof pi.on !== "function") return;
  state.installed = true;

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
  if (["grep", "find", "ls", "fffind", "ffgrep", "fff-multi-grep"].includes(toolName)) return { ...(fallback ?? { title: toolName, role }), detail: `${lineCount(text)} lines` };
  if (toolName === "bash") return { ...(fallback ?? { title: "run", role }), detail: result?.isError ? "failed" : `${lineCount(text)} output lines` };
  if (toolName === "read") return { ...(fallback ?? { title: "read", role }), detail: `${lineCount(text)} lines` };
  if (toolName === "write") return { ...(fallback ?? { title: "write", role }), detail: "written" };
  if (toolName === "edit") return { ...(fallback ?? { title: "edit", role }), detail: "edited" };
  return fallback ?? { title: toolName, detail: text ? `${lineCount(text)} lines` : undefined, role };
}

export function renderGroupedToolCall(toolName: string, args: Record<string, any>, theme: any, context: any, summary: BasicToolSummary = summarizeToolCall(toolName, args)): Component {
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
  if (!item.hidden && group && group.items.length > 1) return new BasicToolGroupComponent(group, theme, !!context?.expanded);
  return new BasicToolItemComponent(item, theme);
}

export function renderGroupedToolResult(toolName: string, result: any, options: { expanded?: boolean; isPartial?: boolean }, theme: any, context: any, summary?: BasicToolSummary): Component {
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
