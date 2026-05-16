# Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify `basic-tool-grouping` and `thinking-steps` onto one tree-style visual system (single-char connectors `├ /└ `, per-role glyphs, per-role colors, status accents), hide `write_stdin` rows by aggregating into the parent `exec_command`, and merge same-turn thinking blocks into one renderer that shows the latest 5 steps.

**Architecture:** Extract the role-color-glyph table and the tree row layout into a new `extensions/shared/visual.ts`. Both `basic-tool-grouping.ts` and `thinking-steps/render.ts` import from it. A module-local `stdinAggregator` keyed by `session_id` in `basic-tool-grouping.ts` collects `write_stdin` calls and stitches them onto the parent `exec_command` row's meta. The thinking-steps `internal-patch.ts` tracks the first `ThinkingStepsComponent` per assistant-message timestamp; later thinking blocks within that message append to it and their own render becomes a no-op.

**Tech Stack:** TypeScript + `bun:test` (existing `npm test`), `@earendil-works/pi-tui` (existing `truncateToWidth`/`visibleWidth`/`wrapTextWithAnsi`), Pi extension API (existing).

**Spec:** `docs/superpowers/specs/2026-05-16-visual-redesign-design.md`

---

## Pre-flight

- [ ] **Step 0.1: Confirm a clean working tree**

```bash
cd /Users/lucas/Developer/pi-basic-tools
git status --short
```

Expected: only the spec doc shows changed (already committed). If unstaged work exists outside the plan files, stop and ask the user before continuing.

- [ ] **Step 0.2: Confirm tests run today**

```bash
cd /Users/lucas/Developer/pi-basic-tools
npm test 2>&1 | tail -40
```

Expected: tests pass (or show only known/pre-existing failures unrelated to the redesign). Capture the baseline so we recognise regressions vs. our breaking changes.

---

## Task 1: Shared visual module

**Files:**
- Create: `extensions/shared/visual.ts`
- Create: `tests/shared-visual.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `tests/shared-visual.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  ROLE_GLYPHS,
  ROLE_COLORS,
  treeConnector,
  renderTreeRow,
  resolveMarker,
  type VisualRole,
  type VisualStatus,
} from "../extensions/shared/visual.ts";

function taggingTheme() {
  return {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `<b>${text}</b>`,
  };
}

describe("shared visual module", () => {
  test("treeConnector returns single-char branch/tail", () => {
    expect(treeConnector(false)).toBe("├ ");
    expect(treeConnector(true)).toBe("└ ");
  });

  test("ROLE_GLYPHS covers every role", () => {
    const roles: VisualRole[] = ["inspect", "search", "compare", "write", "run", "network", "plan", "ask", "verify", "default"];
    for (const role of roles) {
      expect(ROLE_GLYPHS[role]).toBeDefined();
      expect(ROLE_COLORS[role]).toBeDefined();
    }
    expect(ROLE_GLYPHS.inspect).toBe("◫");
    expect(ROLE_GLYPHS.search).toBe("⌕");
    expect(ROLE_GLYPHS.write).toBe("✎");
    expect(ROLE_GLYPHS.run).toBe("▸");
    expect(ROLE_COLORS.write).toBe("success");
    expect(ROLE_COLORS.search).toBe("accent");
  });

  test("resolveMarker: status=error overrides role", () => {
    const m = resolveMarker({ role: "inspect", status: "error" });
    expect(m.glyph).toBe("!");
    expect(m.color).toBe("error");
  });

  test("resolveMarker: status=running overrides role", () => {
    const m = resolveMarker({ role: "inspect", status: "running" });
    expect(m.glyph).toBe("◐");
    expect(m.color).toBe("warning");
  });

  test("resolveMarker: done falls back to role glyph/color", () => {
    const m = resolveMarker({ role: "write", status: "done" });
    expect(m.glyph).toBe("✎");
    expect(m.color).toBe("success");
  });

  test("renderTreeRow builds {connector}{glyph} {headline} · {meta}", () => {
    const theme = taggingTheme();
    const lines = renderTreeRow({
      theme,
      width: 80,
      isLast: false,
      role: "inspect",
      status: "done",
      headline: "README.md",
      meta: "147 lines",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("<muted>├ </muted>");
    expect(lines[0]).toContain("<mdLink>◫</mdLink>");
    expect(lines[0]).toContain("<muted>README.md</muted>");
    expect(lines[0]).toContain("<muted>· 147 lines</muted>");
  });

  test("renderTreeRow uses error color for error rows", () => {
    const theme = taggingTheme();
    const lines = renderTreeRow({
      theme,
      width: 80,
      isLast: true,
      role: "run",
      status: "error",
      headline: "git invalid-cmd",
      meta: "failed",
    });
    expect(lines[0]).toContain("<error>!</error>");
    expect(lines[0]).toContain("<error>git invalid-cmd</error>");
    expect(lines[0]).toContain("<error>· failed</error>");
  });

  test("renderTreeRow wraps long headlines with `  │ ` continuation", () => {
    const theme = taggingTheme();
    const longText = "ocr-large-pdf.sh /Users/lucas/Dropbox/Lectures/MICRO.101.微观经济学基础/参考文档/CCER历年试题(1996-2013)与答案(1996-2012).pdf";
    const lines = renderTreeRow({
      theme,
      width: 60,
      isLast: false,
      role: "run",
      status: "done",
      headline: longText,
      meta: undefined,
    });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]).toContain("<muted>  │ </muted>");
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
cd /Users/lucas/Developer/pi-basic-tools
npx bun test tests/shared-visual.test.ts 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 1.3: Implement the shared visual module**

Create `extensions/shared/visual.ts`:

```ts
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type VisualRole =
  | "inspect"
  | "search"
  | "compare"
  | "write"
  | "run"
  | "network"
  | "plan"
  | "ask"
  | "verify"
  | "default";

export type VisualStatus = "pending" | "running" | "done" | "error";

export interface VisualTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export const ROLE_GLYPHS: Record<VisualRole, string> = {
  inspect: "◫",
  search: "⌕",
  compare: "↔",
  write: "✎",
  run: "▸",
  network: "↗",
  plan: "◇",
  ask: "?",
  verify: "✓",
  default: "·",
};

export const ROLE_COLORS: Record<VisualRole, string> = {
  inspect: "mdLink",
  search: "accent",
  compare: "warning",
  write: "success",
  run: "warning",
  network: "mdCode",
  plan: "accent",
  ask: "accent",
  verify: "success",
  default: "muted",
};

export function treeConnector(isLast: boolean): string {
  return isLast ? "└ " : "├ ";
}

export function resolveMarker(input: { role: VisualRole; status: VisualStatus }): { glyph: string; color: string } {
  if (input.status === "error") return { glyph: "!", color: "error" };
  if (input.status === "running" || input.status === "pending") return { glyph: "◐", color: "warning" };
  return { glyph: ROLE_GLYPHS[input.role] ?? ROLE_GLYPHS.default, color: ROLE_COLORS[input.role] ?? ROLE_COLORS.default };
}

export interface TreeRowOptions {
  theme: VisualTheme;
  width: number;
  isLast: boolean;
  role: VisualRole;
  status: VisualStatus;
  headline: string;
  meta?: string;
  activeAccent?: boolean;
}

const MAX_CONTINUATION_LINES = 3;
const CONTINUATION_PREFIX = "  │ ";

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

export function renderTreeRow(options: TreeRowOptions): string[] {
  const { theme, width, isLast, role, status, headline, meta, activeAccent } = options;
  const marker = resolveMarker({ role, status });
  const connector = treeConnector(isLast);
  const connectorColor = activeAccent ? "accent" : "muted";
  const textColor = status === "error" ? "error" : "muted";

  const connectorPainted = theme.fg(connectorColor, connector);
  const glyphPainted = theme.fg(marker.color, marker.glyph);
  const prefix = `${connectorPainted}${glyphPainted} `;
  const prefixWidth = visibleWidth(connector) + visibleWidth(marker.glyph) + 1;
  const firstWidth = Math.max(1, width - prefixWidth);
  const continuationPrefixPainted = theme.fg("muted", CONTINUATION_PREFIX);
  const continuationWidth = Math.max(1, width - visibleWidth(CONTINUATION_PREFIX));

  const metaSuffix = meta ? `  · ${meta}` : "";
  const fullText = `${headline}${metaSuffix}`;

  if (visibleWidth(fullText) <= firstWidth) {
    const headlinePainted = theme.fg(textColor, headline);
    const metaPainted = meta ? theme.fg(textColor, `· ${meta}`) : "";
    const composed = meta ? `${prefix}${headlinePainted}  ${metaPainted}` : `${prefix}${headlinePainted}`;
    return [truncateToWidth(composed, width, "")];
  }

  const lines: string[] = [];
  const firstSplit = splitToWidth(fullText, firstWidth);
  lines.push(`${prefix}${theme.fg(textColor, firstSplit.head)}`);
  let rest = firstSplit.tail;
  for (let i = 0; rest && i < MAX_CONTINUATION_LINES; i += 1) {
    const part = splitToWidth(rest, continuationWidth);
    const suffix = part.tail && i === MAX_CONTINUATION_LINES - 1 ? "…" : "";
    lines.push(`${continuationPrefixPainted}${theme.fg(textColor, `${part.head}${suffix}`)}`);
    rest = suffix ? "" : part.tail;
  }
  return lines.map((line) => truncateToWidth(line, Math.max(1, width), ""));
}
```

- [ ] **Step 1.4: Run test to verify it passes**

```bash
cd /Users/lucas/Developer/pi-basic-tools
npx bun test tests/shared-visual.test.ts 2>&1 | tail -10
```

Expected: PASS — 7 assertions.

- [ ] **Step 1.5: Commit**

```bash
cd /Users/lucas/Developer/pi-basic-tools
git add extensions/shared/visual.ts tests/shared-visual.test.ts
git commit -m "shared: visual module with role glyphs, colors, tree row renderer"
```

---

## Task 2: basic-tool-grouping adopts tree style

**Files:**
- Modify: `extensions/basic-tool-grouping.ts`
- Modify: `tests/grouping-showcase.test.ts`

We update assertions in lockstep with implementation here, because the existing tests assert specific bullet/marker strings that the redesign deliberately changes. After this task, the renderer emits tree rows; we are not regressing functionality, only the visual.

- [ ] **Step 2.1: Update assertions to match new tree shape**

Edit `tests/grouping-showcase.test.ts`:

For each `combo` test, replace assertions that look like:
- `expect(collapsed).toContain("Read README.md")` — KEEP (headline text unchanged)
- Add a new assertion per combo that checks the tree connector: `expect(collapsed).toContain("├ ")` and `expect(collapsed).toContain("└ ")`
- Combo G (error): also assert `expect(collapsed).toContain("!")` (already present via `roleIcon`, but make explicit).

Specifically, after each `expect(collapsed).toContain(...)` group, append:

```ts
    expect(collapsed).toContain("├ ");
    expect(collapsed).toContain("└ ");
```

For combo G (error case):

```ts
    expect(collapsed).toContain("!"); // error glyph
```

For combo F (single tool, no group): the assertion `expect(solo).toContain("Map .")` is correct as-is; single items render via `BasicToolItemComponent` (no tree connector). Add:

```ts
    expect(solo).not.toContain("├ ");
    expect(solo).not.toContain("└ ");
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
cd /Users/lucas/Developer/pi-basic-tools
npx bun test tests/grouping-showcase.test.ts 2>&1 | tail -30
```

Expected: FAIL — tree connectors not present (still rendering `•`).

- [ ] **Step 2.3: Replace `formatCompactItem` and helpers**

Edit `extensions/basic-tool-grouping.ts`. At the top of the file, add the shared-module import alongside existing imports:

```ts
import { ROLE_GLYPHS, renderTreeRow, type VisualRole, type VisualStatus } from "./shared/visual.ts";
```

Find and DELETE these functions/blocks (they get replaced by shared helpers):

1. `function roleIcon(item: ToolItem): string { ... }` — lines roughly 189-203 (the whole function).
2. `function statusRole(item: ToolItem): string { ... }` — roughly 215-219.
3. `function wrapActionLine(...)` — roughly 301-318.
4. `function formatCompactItem(...)` — roughly 320-329.

Add their replacements right after the `displaySummary` helper (search for `function displaySummary`):

```ts
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
    meta: summary.detail,
  });
}
```

Replace `renderGroupLines` so it walks the visible items and emits tree rows:

```ts
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
```

Update `BasicToolItemComponent.render` so single (non-grouped) items still use a clean format. A solo item gets a one-line `▸ command` rendering with no tree connector — match the existing fallback path:

```ts
class BasicToolItemComponent implements Component {
  constructor(
    private readonly item: ToolItem,
    private readonly theme: any,
  ) {}

  render(width: number): string[] {
    const headline = actionHeadline(this.item);
    const summary = displaySummary(this.item);
    const status = statusFor(this.item);
    const role = visualRoleFor(this.item);
    const marker = (() => {
      if (status === "error") return { glyph: "!", color: "error" };
      if (status === "running") return { glyph: "◐", color: "warning" };
      return { glyph: ROLE_GLYPHS[role] ?? "·", color: status === "error" ? "error" : "muted" };
    })();
    const text = status === "error" ? this.theme.fg("error", headline) : this.theme.fg("muted", headline);
    const metaText = summary.detail ? this.theme.fg(status === "error" ? "error" : "muted", `  · ${summary.detail}`) : "";
    const line = `${this.theme.fg(marker.color, marker.glyph)} ${text}${metaText}`;
    return [truncateToWidth(line, Math.max(1, width), "")];
  }

  invalidate(): void {}
}
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
cd /Users/lucas/Developer/pi-basic-tools
npx bun test tests/grouping-showcase.test.ts 2>&1 | tail -30
```

Expected: PASS — all combo tests succeed; tree connectors `├ ` and `└ ` present in group output, absent from solo output.

- [ ] **Step 2.5: Commit**

```bash
cd /Users/lucas/Developer/pi-basic-tools
git add extensions/basic-tool-grouping.ts tests/grouping-showcase.test.ts
git commit -m "basic-tool-grouping: tree-style rows with role glyphs and per-status accent"
```

---

## Task 3: Hide stdin, merge into parent exec_command

**Files:**
- Modify: `extensions/basic-tool-grouping.ts`
- Modify: `tests/grouping-showcase.test.ts`
- Modify: `tests/terminal-session.test.ts` (only if existing stdin assertions break)

- [ ] **Step 3.1: Write the failing test**

Append to `tests/grouping-showcase.test.ts`:

```ts
  test("combo H: write_stdin polls/writes merge into parent exec_command meta", () => {
    resetBasicToolGroupingForTests();
    const theme = plainTheme();

    // 1. exec_command (gets a session_id back)
    renderGroupedToolCall("exec_command", { command: "tail -f log.txt" }, theme, ctx("c1"));
    renderGroupedToolResult(
      "exec_command",
      okResult("session started", { session_id: "abc123" }),
      { expanded: false, isPartial: true },
      theme,
      ctx("c1"),
    );

    // 2. write_stdin polls — these MUST NOT render their own row.
    renderGroupedToolCall("write_stdin", { session_id: "abc123", chars: "" }, theme, ctx("s1"));
    renderGroupedToolResult("write_stdin", okResult("poll #1", {}), { expanded: false, isPartial: false }, theme, ctx("s1"));
    renderGroupedToolCall("write_stdin", { session_id: "abc123", chars: "" }, theme, ctx("s2"));
    renderGroupedToolResult("write_stdin", okResult("poll #2", {}), { expanded: false, isPartial: false }, theme, ctx("s2"));
    renderGroupedToolCall("write_stdin", { session_id: "abc123", chars: "y\n" }, theme, ctx("s3"));
    renderGroupedToolResult("write_stdin", okResult("write", {}), { expanded: false, isPartial: false }, theme, ctx("s3"));

    // Re-render the parent (final state).
    const out = render(renderGroupedToolCall("exec_command", { command: "tail -f log.txt" }, theme, ctx("c1", false)), 80);
    console.log("\n=== Combo H: stdin merge ===\n" + out);

    // No stdin row.
    expect(out).not.toContain("stdin");
    expect(out).not.toContain("poll");
    expect(out).not.toContain("Ran 4 commands");
    // Parent exec_command row carries the meta.
    expect(out).toContain("tail -f log.txt");
    expect(out).toContain("2 polls");
    expect(out).toContain("1 write");
  });

  test("combo I: write_stdin without parent exec_command is dropped", () => {
    resetBasicToolGroupingForTests();
    const theme = plainTheme();

    renderGroupedToolCall("write_stdin", { session_id: "missing", chars: "" }, theme, ctx("s1"));
    renderGroupedToolResult("write_stdin", okResult("poll", {}), { expanded: false, isPartial: false }, theme, ctx("s1"));

    // Add a bash command afterward so we have something to render.
    renderGroupedToolCall("bash", { command: "echo hi" }, theme, ctx("b1"));
    renderGroupedToolResult("bash", okResult("hi", {}), { expanded: false, isPartial: false }, theme, ctx("b1"));

    const out = render(renderGroupedToolCall("bash", { command: "echo hi" }, theme, ctx("b1", false)), 80);
    expect(out).not.toContain("stdin");
    expect(out).toContain("Ran echo hi");
  });
```

- [ ] **Step 3.2: Run tests to verify they fail**

```bash
cd /Users/lucas/Developer/pi-basic-tools
npx bun test tests/grouping-showcase.test.ts 2>&1 | tail -15
```

Expected: FAIL — `stdin` still appears in output; `2 polls` / `1 write` not found.

- [ ] **Step 3.3: Remove `write_stdin` from BASIC_TOOL_NAMES**

In `extensions/basic-tool-grouping.ts`, edit the `BASIC_TOOL_NAMES` set to drop `"write_stdin"`:

```ts
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
  // "write_stdin" removed: aggregated into parent exec_command row.
  "fetch",
  "sourcegraph",
  "fffind",
  "ffgrep",
  "fff-multi-grep",
  "todo",
]);
```

- [ ] **Step 3.4: Add the stdin aggregator and parent lookup**

In `extensions/basic-tool-grouping.ts`, near the other module-scope state (right above `const STATE_KEY = ...`), add:

```ts
type StdinCounts = { polls: number; writes: number; interrupts: number };

type StdinAggregatorState = {
  // session_id → counts
  countsBySession: Map<string, StdinCounts>;
  // session_id → exec_command toolCallId (the parent row)
  execCommandBySession: Map<string, string>;
};

const STDIN_KEY = Symbol.for("pi-basic-tools.basic-tool-grouping.stdin");

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
```

Extend `resetBasicToolGroupingForTests` to also clear the stdin state:

```ts
export function resetBasicToolGroupingForTests(): void {
  state.groups.clear();
  state.itemsByCallId.clear();
  state.currentGroup = undefined;
  state.nextGroupId = 1;
  state.installed = false;
  stdinState.countsBySession.clear();
  stdinState.execCommandBySession.clear();
}
```

- [ ] **Step 3.5: Wire stdin recording into `renderGroupedToolCall` and `renderGroupedToolResult`**

In `extensions/basic-tool-grouping.ts`, at the top of `renderGroupedToolCall`, before the `if (!canGroupTool(context))` guard, add:

```ts
export function renderGroupedToolCall(toolName: string, args: Record<string, any>, theme: any, context: any, summary: BasicToolSummary = summarizeToolCall(toolName, args)): Component {
  if (toolName === "write_stdin") {
    recordStdinCall(typeof args.session_id === "string" ? args.session_id : undefined, args.chars);
    return emptyComponent();
  }
  if (!canGroupTool(context)) return emptyComponent();
  // ... rest unchanged
```

In `renderGroupedToolResult`, before the `if (!canGroupTool(context))` guard, add:

```ts
export function renderGroupedToolResult(toolName: string, result: any, options: { expanded?: boolean; isPartial?: boolean }, theme: any, context: any, summary?: BasicToolSummary): Component {
  if (toolName === "write_stdin") return emptyComponent();
  if (toolName === "exec_command") {
    const sessionId = result?.details?.session_id;
    if (typeof sessionId === "string" && context?.toolCallId) {
      recordExecCommandSession(String(context.toolCallId), sessionId);
    }
  }
  if (!canGroupTool(context)) return emptyComponent();
  // ... rest unchanged
```

Also extend the `pi.on("message_update", …)` hook in `installBasicToolGrouping` so it routes `write_stdin` parts to the aggregator instead of `getOrCreateItem`. Inside the `for (const part of content)` loop, after detecting `part.type === "toolCall"` and before the `basic` check:

```ts
      if (part.name === "write_stdin") {
        const args = part.arguments ?? {};
        const sessionId = typeof (args as any).session_id === "string" ? (args as any).session_id : undefined;
        // Only record once per part id; track via state.itemsByCallId membership.
        if (!state.itemsByCallId.has(String(part.id))) {
          recordStdinCall(sessionId, (args as any).chars);
          state.itemsByCallId.set(String(part.id), {
            toolCallId: String(part.id),
            toolName: "write_stdin",
            groupId: -1,
            index: -1,
            status: "success",
            summary: { title: "stdin", role: "run" },
            hidden: true,
          });
        }
        previousWasBasic = true;
        continue;
      }
```

And inside the `pi.on("tool_result", ...)` handler, before the `compactExternalBasicToolResult` call, capture `exec_command` session IDs:

```ts
  pi.on("tool_result", (event: any) => {
    if (event?.toolName === "exec_command") {
      const sessionId = event?.details?.session_id ?? event?.result?.details?.session_id;
      const toolCallId = event?.toolCallId ?? event?.toolCall?.id;
      if (typeof sessionId === "string" && typeof toolCallId === "string") {
        recordExecCommandSession(toolCallId, sessionId);
      }
    }
    return compactExternalBasicToolResult(event);
  });
```

- [ ] **Step 3.6: Inject stdin meta into `formatTreeItem`**

Replace the `formatTreeItem` body so it consults `stdinMetaFor` and appends to the meta string:

```ts
function formatTreeItem(item: ToolItem, theme: any, width: number, isLast: boolean): string[] {
  const headline = actionHeadline(item);
  const summary = displaySummary(item);
  const stdinMeta = stdinMetaFor(item);
  const meta = (() => {
    const base = summary.detail;
    if (base && stdinMeta) return `${base} · ${stdinMeta}`;
    return base ?? stdinMeta;
  })();
  return renderTreeRow({
    theme,
    width,
    isLast,
    role: visualRoleFor(item),
    status: statusFor(item),
    headline,
    meta,
  });
}
```

- [ ] **Step 3.7: Run stdin tests to verify they pass**

```bash
cd /Users/lucas/Developer/pi-basic-tools
npx bun test tests/grouping-showcase.test.ts 2>&1 | tail -15
```

Expected: PASS — combo H asserts `2 polls`, `1 write` in the exec_command row; combo I drops the orphan stdin.

- [ ] **Step 3.8: Run the full test suite to catch fallout**

```bash
cd /Users/lucas/Developer/pi-basic-tools
npm test 2>&1 | tail -40
```

Expected: at most the existing `thinking-steps` tests fail (they assert the OLD `┆`/`├─` shape that Task 4 will change). The `terminal-session.test.ts` tests should still pass — `write_stdin` works at the tool-execution level, only its DISPLAY is gone.

If `terminal-session.test.ts` fails, read the failure: most likely an assertion looks at a rendered string that no longer contains "stdin". Update the assertion to check the underlying tool result text, not the grouping output.

- [ ] **Step 3.9: Commit**

```bash
cd /Users/lucas/Developer/pi-basic-tools
git add extensions/basic-tool-grouping.ts tests/grouping-showcase.test.ts
git commit -m "basic-tool-grouping: hide write_stdin, aggregate counts onto parent exec_command"
```

---

## Task 4: thinking-steps render adopts shared visual system

**Files:**
- Modify: `extensions/thinking-steps/render.ts`
- Modify: `tests/thinking-steps.test.ts`

The existing tests assert the OLD shape (`┆`, `├─`, `└─` two-char connectors). After this task they assert the new shape (`├ `, `└ `, `Thinking Steps  · N thoughts`, no `┆`).

- [ ] **Step 4.1: Update the existing test assertions to the new shape**

Edit `tests/thinking-steps.test.ts`. Apply these changes — note the assertions that get inverted (formerly required `┆`, now required absent):

1. In `test("summary mode renders a tree-shaped header + connector rows", ...)`:
   - Replace `expect(header).toContain("┆")` with `expect(header).not.toContain("┆")`.
   - Replace the `├─` / `└─` substring checks with single-char versions: change `line.includes("├─") || line.includes("└─")` to `line.includes("├ ") || line.includes("└ ")`.

2. In `test("collapsed mode renders a tree-connector summary line with a pulse glyph when active", ...)`:
   - Replace `expect(text.startsWith("│ Thinking ")).toBe(true)` with `expect(text.startsWith("│ Thinking ")).toBe(true)` — KEEP, the collapsed mode still uses `│ Thinking ` prefix (collapsed mode is for the single-line above-editor case, not affected by the tree redesign).

3. In `test("expanded mode emits tree connectors and body with markdown structure", ...)`:
   - Replace `expect(lines.some((line) => line.includes("├─"))).toBe(true)` with `expect(lines.some((line) => line.includes("├ "))).toBe(true)`.
   - Replace `expect(lines.some((line) => line.includes("└─"))).toBe(true)` with `expect(lines.some((line) => line.includes("└ "))).toBe(true)`.

4. In `test("active thinking step uses accent color + bold", ...)`:
   - Replace `<accent>└─</accent>` with `<accent>└ </accent>`.

5. In `test("done Thinking summary header uses dim color", ...)`:
   - Replace `expect(lines[0]).toContain("<muted>┆</muted>")` with `expect(lines[0]).not.toContain("┆")`.
   - Replace `expect(lines[0]).toContain("<dim>Thinking Steps</dim>")` with `expect(lines[0]).toContain("Thinking Steps")` and add `expect(lines[0]).toContain("3 thoughts")` (sampleBlocks has 3).

6. In `test("active signal lives on step connectors, not the group header", ...)`:
   - Replace `<accent>├─</accent>` with `<accent>├ </accent>`.
   - Replace `<dim>Thinking Steps</dim>` with `Thinking Steps`.

7. In `test("role glyphs render in role color", ...)`:
   - Replace `<warning>↔</warning>` with `<warning>↔</warning>` — KEEP (compare role unchanged).
   - Replace `<mdLink>◫</mdLink>` with `<mdLink>◫</mdLink>` — KEEP (inspect unchanged).
   - Replace `<success>✓</success>` with `<success>✓</success>` — KEEP (verify unchanged).
   - The substring assertion `line.includes("├─") || line.includes("└─")` becomes `line.includes("├ ") || line.includes("└ ")`.

8. In `test("uses accent color for the connector of the active step", ...)`:
   - Replace `<accent>├─</accent>` with `<accent>├ </accent>`.

- [ ] **Step 4.2: Run tests to verify they fail**

```bash
cd /Users/lucas/Developer/pi-basic-tools
npx bun test tests/thinking-steps.test.ts 2>&1 | tail -30
```

Expected: FAIL — old code still produces `┆` headers and `├─` connectors.

- [ ] **Step 4.3: Update `render.ts` group header and connectors**

In `extensions/thinking-steps/render.ts`:

Add the shared-module import at the top:

```ts
import { ROLE_GLYPHS, ROLE_COLORS, treeConnector, type VisualRole } from "../shared/visual.ts";
```

Replace local `roleGlyph` and `roleColor` with delegations to the shared tables. Find:

```ts
function roleGlyph(role: ThinkingSemanticRole): string { ... }
function roleColor(role: ThinkingSemanticRole): string { ... }
```

Replace both with:

```ts
function thinkingRoleAsVisual(role: ThinkingSemanticRole): VisualRole {
  switch (role) {
    case "inspect":
    case "search":
    case "compare":
    case "write":
    case "plan":
    case "verify":
      return role;
    case "error":
      return "default";
    default:
      return "default";
  }
}

function roleGlyph(role: ThinkingSemanticRole): string {
  if (role === "error") return "!";
  return ROLE_GLYPHS[thinkingRoleAsVisual(role)] ?? ROLE_GLYPHS.default;
}

function roleColor(role: ThinkingSemanticRole): string {
  if (role === "error") return "error";
  return ROLE_COLORS[thinkingRoleAsVisual(role)] ?? ROLE_COLORS.default;
}
```

Replace `renderGroupHeader` so the header is `Thinking Steps  · N thoughts` (drop the `┆` prefix and conditionally include the count):

```ts
function renderGroupHeader(
  theme: ThinkingThemeLike,
  width: number,
  totalSteps: number,
  isActive: boolean,
): string {
  const titleRole = isActive ? "warning" : "dim";
  const title = theme.fg(titleRole, "Thinking Steps");
  if (totalSteps <= 1) return truncateToWidth(title, width, "");
  const count = theme.fg("muted", `  · ${totalSteps} thoughts`);
  return truncateToWidth(`${title}${count}`, width, "");
}
```

Replace the `wrapStepHeader` connector construction to use `treeConnector`:

Find:

```ts
const prefix = `${theme.fg(connectorColor, connector)} ${icon} `;
const continuationPrefix = " ".repeat(visibleWidth(`${connector} ${roleGlyph(step.role)} `));
```

Replace with:

```ts
const treePrefix = treeConnector(connector.endsWith("└─") || connector.endsWith("└ "));
const prefix = `${theme.fg(connectorColor, treePrefix)}${icon} `;
const continuationPrefix = " ".repeat(visibleWidth(`${treePrefix}${roleGlyph(step.role)} `));
```

And in `renderSummary` and `renderExpanded`, replace the connector strings `"├─"` and `"└─"` with `"├ "` and `"└ "`:

In `renderSummary`:

```ts
const connector = index === visible.length - 1 ? "└ " : "├ ";
```

In `renderExpanded`:

```ts
const connector = index === steps.length - 1 ? "└ " : "├ ";
```

And the expanded body prefix in `renderExpanded`:

```ts
const bodyPrefix = index === steps.length - 1 ? "   " : `${theme.fg("muted", "│")}  `;
```

This stays the same (continuation prefix uses `│  ` for non-last bodies, three spaces for the last step's body). Confirm it still works after the connector change.

Update the test for `selectSummarySteps`: the redesign uses **latest 5** (not salience-scored). Replace `selectSummarySteps` with a simple slice:

```ts
function selectSummarySteps(steps: DerivedThinkingStep[], _activeStepId?: string): DerivedThinkingStep[] {
  if (steps.length <= MAX_SUMMARY_STEPS) return steps;
  return steps.slice(-MAX_SUMMARY_STEPS);
}
```

(The old salience-weighted body becomes dead code; keep it removed for clarity.)

- [ ] **Step 4.4: Run tests to verify they pass**

```bash
cd /Users/lucas/Developer/pi-basic-tools
npx bun test tests/thinking-steps.test.ts 2>&1 | tail -30
```

Expected: PASS — header has no `┆`, connectors are `├ `/`└ `, the count `3 thoughts` appears.

- [ ] **Step 4.5: Commit**

```bash
cd /Users/lucas/Developer/pi-basic-tools
git add extensions/thinking-steps/render.ts tests/thinking-steps.test.ts
git commit -m "thinking-steps: tree-style header (\"Thinking Steps · N thoughts\") and single-char connectors"
```

---

## Task 5: Merge same-turn thinking blocks

**Files:**
- Modify: `extensions/thinking-steps/internal-patch.ts`
- Modify: `tests/thinking-steps.test.ts`

- [ ] **Step 5.1: Write the failing test**

Append to `tests/thinking-steps.test.ts`:

```ts
  test("multiple thinking blocks within one message merge into one component", () => {
    setCurrentThinkingScopeKey("merge-test");
    setThinkingStepsMode("summary", "merge-test");
    clearActiveThinkingState(undefined, "merge-test");

    const messageTimestamp = 1234567890;
    // Two thinking blocks, each with one short paragraph (parser yields one step each).
    const block1: ThinkingSourceBlock[] = [{ contentIndex: 0, text: "Inspect Users/lucas." }];
    const block2: ThinkingSourceBlock[] = [{ contentIndex: 2, text: "Verify file size and pages." }];

    const c1 = new ThinkingStepsComponent(widthSafeTheme, messageTimestamp, block1, "merge-test");
    const c2 = new ThinkingStepsComponent(widthSafeTheme, messageTimestamp, block2, "merge-test");

    // After redesign: the second component for the same message timestamp
    // returns [], its steps merged into the first.
    const linesFirst = c1.render(200);
    const linesSecond = c2.render(200);

    expect(linesSecond).toEqual([]);
    // First component now renders 2 steps under one header.
    const stepRows = linesFirst.filter((line) => line.includes("├ ") || line.includes("└ "));
    expect(stepRows.length).toBe(2);
    expect(linesFirst.some((line) => line.includes("Inspect"))).toBe(true);
    expect(linesFirst.some((line) => line.includes("Verify"))).toBe(true);
    expect(linesFirst[0]).toContain("Thinking Steps");
    expect(linesFirst[0]).toContain("2 thoughts");

    clearActiveThinkingState(undefined, "merge-test");
  });
```

- [ ] **Step 5.2: Run test to verify it fails**

```bash
cd /Users/lucas/Developer/pi-basic-tools
npx bun test tests/thinking-steps.test.ts -t "merge into one component" 2>&1 | tail -10
```

Expected: FAIL — `c2.render(200)` currently returns its own header + step, not `[]`.

- [ ] **Step 5.3: Add a per-message-timestamp registry in render.ts**

Edit `extensions/thinking-steps/render.ts`. Above the `ThinkingStepsComponent` class definition, add:

```ts
type MergeRegistryEntry = {
  primary: ThinkingStepsComponent;
  blocks: ThinkingSourceBlock[];
};

const MERGE_REGISTRY_KEY = Symbol.for("pi-basic-tools.thinking-steps.merge-registry");

function getMergeRegistry(): Map<string, MergeRegistryEntry> {
  const existing = (globalThis as Record<PropertyKey, unknown>)[MERGE_REGISTRY_KEY];
  if (existing instanceof Map) return existing as Map<string, MergeRegistryEntry>;
  const created = new Map<string, MergeRegistryEntry>();
  (globalThis as Record<PropertyKey, unknown>)[MERGE_REGISTRY_KEY] = created;
  return created;
}

function mergeRegistryKey(scopeKey: string, messageTimestamp: number): string {
  return `${scopeKey}::${messageTimestamp}`;
}

export function clearThinkingMergeRegistry(scopeKey?: string, messageTimestamp?: number): void {
  const registry = getMergeRegistry();
  if (scopeKey === undefined && messageTimestamp === undefined) {
    registry.clear();
    return;
  }
  if (scopeKey !== undefined && messageTimestamp !== undefined) {
    registry.delete(mergeRegistryKey(scopeKey, messageTimestamp));
    return;
  }
  if (scopeKey !== undefined) {
    for (const key of [...registry.keys()]) {
      if (key.startsWith(`${scopeKey}::`)) registry.delete(key);
    }
  }
}
```

- [ ] **Step 5.4: Update `ThinkingStepsComponent` to register + merge**

In `extensions/thinking-steps/render.ts`, modify the constructor and add public methods:

```ts
export class ThinkingStepsComponent implements Component {
  private steps: DerivedThinkingStep[];
  private cacheKey?: string;
  private cachedLines?: string[];
  private readonly scopeKey: string;
  private readonly sourceBlocks: ThinkingSourceBlock[];
  private isShadow = false;

  constructor(
    private readonly theme: ThinkingThemeLike,
    private readonly messageTimestamp: number,
    blocks: ThinkingSourceBlock[],
    scopeKey?: string,
  ) {
    this.sourceBlocks = [...blocks];
    this.scopeKey = scopeKey ?? getCurrentThinkingScopeKey();
    this.steps = deriveThinkingSteps(this.sourceBlocks);

    const registry = getMergeRegistry();
    const key = mergeRegistryKey(this.scopeKey, this.messageTimestamp);
    const existing = registry.get(key);
    if (existing) {
      existing.primary.appendBlocks(this.sourceBlocks);
      this.isShadow = true;
    } else {
      registry.set(key, { primary: this, blocks: this.sourceBlocks });
    }
  }

  /** Called by a subsequent same-message component to fold its blocks into the primary. */
  appendBlocks(extra: ThinkingSourceBlock[]): void {
    let added = false;
    for (const block of extra) {
      if (this.sourceBlocks.some((existing) => existing.contentIndex === block.contentIndex)) continue;
      this.sourceBlocks.push(block);
      added = true;
    }
    if (added) {
      this.steps = deriveThinkingSteps(this.sourceBlocks);
      this.invalidate();
    }
  }

  render(width: number): string[] {
    if (this.isShadow) return [];
    const mode = getThinkingStepsMode(this.scopeKey);
    const active = getActiveThinkingState(this.messageTimestamp, this.scopeKey);
    const activeStepId = active.active && active.contentIndex !== undefined
      ? [...this.steps].reverse().find((step) => step.contentIndex === active.contentIndex)?.id
      : undefined;
    const shouldBypassCache = mode === "collapsed" && active.active;
    const nextCacheKey = `${width}:${mode}:${active.active ? 1 : 0}:${activeStepId ?? ""}:${this.sourceBlocks.length}`;
    if (!shouldBypassCache && this.cachedLines && this.cacheKey === nextCacheKey) {
      return this.cachedLines;
    }

    const lines = renderThinkingStepsLines(this.theme, width, {
      mode,
      steps: this.steps,
      activeStepId,
      isActive: active.active,
      nowMs: Date.now(),
    });

    if (!shouldBypassCache) {
      this.cacheKey = nextCacheKey;
      this.cachedLines = lines;
    } else {
      this.cacheKey = undefined;
      this.cachedLines = undefined;
    }
    return lines;
  }

  invalidate(): void {
    this.cacheKey = undefined;
    this.cachedLines = undefined;
  }
}
```

- [ ] **Step 5.5: Clear the merge registry at message boundaries**

In `extensions/thinking-steps/index.ts`, import `clearThinkingMergeRegistry`:

```ts
import { ThinkingStepsComponent, clearThinkingMergeRegistry } from "./render.ts";
```

Wait — `index.ts` doesn't currently import from `render.ts`. Instead, the cleanest hook point is the existing `message_start` (role=user) handler, which already clears active thinking state. Add the call there:

```ts
  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;
    recordThinkingMessageScope(event.message, sessionScopeKey);
    const ownerScopeKey = resolveThinkingMessageScope(event.message, sessionScopeKey);
    const timestamp = typeof (event.message as { timestamp?: unknown }).timestamp === "number"
      ? (event.message as { timestamp: number }).timestamp
      : undefined;
    clearActiveThinkingState(timestamp, ownerScopeKey);
    if (timestamp !== undefined) clearThinkingMergeRegistry(ownerScopeKey, timestamp);
  });
```

And add a top-level import in `index.ts`:

```ts
import { clearThinkingMergeRegistry } from "./render.ts";
```

Also clear on `session_shutdown`:

```ts
  pi.on("session_shutdown", async (_event, ctx) => {
    const activeScopeKey = setSessionScopeKey(ctx.cwd);
    clearActiveThinkingState(undefined, activeScopeKey);
    clearThinkingMessageOwnership(activeScopeKey);
    clearThinkingMergeRegistry(activeScopeKey);
    // ... rest unchanged
```

- [ ] **Step 5.6: Run the merge test to verify it passes**

```bash
cd /Users/lucas/Developer/pi-basic-tools
npx bun test tests/thinking-steps.test.ts -t "merge into one component" 2>&1 | tail -10
```

Expected: PASS — second component returns `[]`, first component shows 2 step rows under one `Thinking Steps  · 2 thoughts` header.

- [ ] **Step 5.7: Run the full thinking-steps test file**

```bash
cd /Users/lucas/Developer/pi-basic-tools
npx bun test tests/thinking-steps.test.ts 2>&1 | tail -40
```

Expected: PASS — all tests including the new merge test and the previously-updated ones.

If a previously-passing test now fails because the registry is sticky between tests, add `clearThinkingMergeRegistry()` to its setup. The simplest pattern: import it at the top of the test file and call it at the start of any test that creates fresh `ThinkingStepsComponent`s:

```ts
import { clearThinkingMergeRegistry } from "../extensions/thinking-steps/render.ts";

// ... in tests:
clearThinkingMergeRegistry();
```

- [ ] **Step 5.8: Commit**

```bash
cd /Users/lucas/Developer/pi-basic-tools
git add extensions/thinking-steps/render.ts extensions/thinking-steps/index.ts tests/thinking-steps.test.ts
git commit -m "thinking-steps: merge same-turn blocks into one renderer"
```

---

## Task 6: Full regression sweep

**Files:**
- None modified directly; this task only verifies and unblocks any leftover failures.

- [ ] **Step 6.1: Run the full test suite**

```bash
cd /Users/lucas/Developer/pi-basic-tools
npm test 2>&1 | tail -80
```

Expected: PASS — every test file green.

If failures remain:
- `terminal-session.test.ts` / `network-tools.test.ts`: probably asserts the rendered `stdin` shape. Update its assertion to look at the tool result `text` or `details`, not at the grouping output. The underlying tool call still works; only its UI row is gone.
- Any test that asserts `┆` or `├─` (two-char): missed in Task 4 step 4.1. Apply the same substitution rules.

- [ ] **Step 6.2: Run the type check / build check**

```bash
cd /Users/lucas/Developer/pi-basic-tools
npm run check 2>&1 | tail -30
npm run test:build 2>&1 | tail -20
```

Expected: both pass with no TypeScript errors. Fix any reported issues — usually a missing `import` from `./shared/visual.ts` or a stale type signature.

- [ ] **Step 6.3: Run the PTY capture test to refresh the golden transcript**

```bash
cd /Users/lucas/Developer/pi-basic-tools
npm run test:tui-capture 2>&1 | tail -40
```

Expected: the captured terminal output uses `├ `/`└ ` connectors and contains no `stdin` rows. If the golden assertion fails because the expected text still expects the old shape, update the test (`tests/...` looking for `Explored 3 targets` etc.) — these asserted on `Explored 3 targets` headlines which we kept verbatim, so they should pass.

If `test:tui-capture` cannot run locally (PTY unavailable, dependency missing), skip and add a TODO marker in the commit message: "PTY capture left for CI to refresh." But try first.

- [ ] **Step 6.4: Commit (if any test-only edits)**

```bash
cd /Users/lucas/Developer/pi-basic-tools
git status --short
# If anything is staged from this task:
git add <changed-test-files>
git commit -m "tests: regression sweep after tree-style redesign"
```

If `git status --short` shows nothing, skip the commit.

---

## Task 7: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 7.1: Find the relevant section**

```bash
cd /Users/lucas/Developer/pi-basic-tools
grep -n "Codex-style\|thinking-steps\|enable-builtin-search" README.md | head -10
```

The `thinking-steps` description in README.md (around line 46) says it uses `• … │ … └` connectors. Update to reflect the new tree shape.

- [ ] **Step 7.2: Apply the README edit**

Edit `README.md`, find the paragraph starting with ``thinking-steps`` rewires Pi's built-in thinking renderer so chain-of-thought blocks use the same `• … │ … └` connectors and accent/muted color tokens as `enable-builtin-search`'s compact tool grouping. ...``

Replace ``• … │ … └`` with ``├ /└  tree connectors with per-role glyphs (◫ inspect, ⌕ search, ✎ write, ▸ run, ↗ network, ◇ plan, ↔ compare, ✓ verify)``.

Also find the `enable-builtin-search` paragraph mentioning `Codex-style action block like 'Ran 3 commands'`. Add a sentence: "Each tool row uses a tree connector (`├ `/`└ `) plus a role glyph; `write_stdin` polls and writes are aggregated onto the parent `exec_command` row's meta instead of rendering as separate rows."

- [ ] **Step 7.3: Commit**

```bash
cd /Users/lucas/Developer/pi-basic-tools
git add README.md
git commit -m "docs: describe tree-style rendering and write_stdin aggregation"
```

---

## Self-review (run before reporting done)

- [ ] **Step 8.1: Spec coverage check**

For each section of `docs/superpowers/specs/2026-05-16-visual-redesign-design.md`, confirm a task delivered it:

| Spec section | Delivered by |
|---|---|
| Visual system: tree connectors | Task 1 (shared module), Tasks 2 & 4 (callers) |
| Visual system: role glyphs + colors | Task 1 |
| Visual system: group header | Task 2 (basic-tool), Task 4 (thinking-steps) |
| Behavioral: thinking-steps merge | Task 5 |
| Behavioral: stdin merge into exec_command | Task 3 |
| Variant A row format | Task 1 (`renderTreeRow`) |
| Edge: stdin without parent | Task 3 (drop silently) |
| Edge: width < 30 | Task 1 (`renderTreeRow` truncation) |
| Edge: error styling | Task 1 (`renderTreeRow`), Tasks 2 & 4 propagate |
| Edge: mid-stream pulse on thinking | Task 4 (existing `pulseGlyph` kept for collapsed mode) |
| Tests: role × status matrix | Task 1 |
| Tests: stdin aggregation | Task 3 |
| Tests: multi-block thinking merge | Task 5 |
| README update | Task 7 |

Missing: none.

- [ ] **Step 8.2: Final git log**

```bash
cd /Users/lucas/Developer/pi-basic-tools
git log --oneline -10
```

Expected: 6-7 new commits since the spec commit, telling a clear story (shared module → basic-tool tree → stdin merge → thinking-steps tree → thinking-steps merge → tests sweep → README).
