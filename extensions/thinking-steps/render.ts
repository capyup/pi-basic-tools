import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { deriveThinkingSteps } from "./parse.ts";
import { getActiveThinkingState, getCurrentThinkingScopeKey, getThinkingStepsMode } from "./state.ts";
import type { DerivedThinkingStep, ThinkingSemanticRole, ThinkingSourceBlock, ThinkingThemeLike } from "./types.ts";

// pi-basic-tools visual language:
//   - group header:  "<verb> <count> <noun>"  in accent/status color
//   - item line:     "• headline"             marker color reflects status
//   - continuation:  "  │ <wrapped body>"     muted connector, dim body
//   - terminator:    "  └ <last body line>"   muted corner connector
//
// pi-thinking-steps' job here is to render the same shape so the thinking
// block reads like any other Codex-style action block in the UI.

interface RenderOptions {
  mode: "collapsed" | "summary" | "expanded";
  steps: DerivedThinkingStep[];
  activeStepId?: string;
  isActive: boolean;
  nowMs?: number;
}

const MAX_SUMMARY_STEPS = 5;

// Map a parsed semantic step role to a glyph + theme color that matches
// pi-basic-tools' `roleIcon` palette.  Verify/success goes green, errors red,
// inspect/search use the mdLink hue used elsewhere for "lookup" actions.
function roleGlyph(role: ThinkingSemanticRole): string {
  switch (role) {
    case "inspect": return "◫";
    case "search":  return "⌕";
    case "compare": return "↔";
    case "verify":  return "✓";
    case "write":   return "✎";
    case "plan":    return "◇";
    case "error":   return "!";
    default:        return "·";
  }
}

function roleColor(_role: ThinkingSemanticRole): string {
  // The glyph shape (set by roleGlyph) carries the semantic meaning; color
  // belongs to the unified tier system, which keeps detail content muted
  // regardless of role.
  return "muted";
}

function pulseGlyph(theme: ThinkingThemeLike, nowMs: number): string {
  const frames = ["·", "•", "●", "•"];
  const frame = Math.floor(nowMs / 220) % frames.length;
  return theme.fg("warning", frames[frame] ?? "·");
}

// ---------- inline markdown rendering (kept from upstream) -----------------
// Thinking traces frequently contain `**bold**`, `_em_`, `` `code` `` markers.
// We sanitize control sequences and render the markers with theme colors so
// the output stays readable in a real terminal.

type InlineSegmentStyle = "plain" | "bold" | "code";
interface InlineSegment { text: string; style: InlineSegmentStyle }

function sanitizeThinkingText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u001b[\]PX^_][\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, "")
    .replace(/[\u0090\u0098\u009d\u009e\u009f][\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, "")
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[ -/]*[0-9@-~])/g, "")
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "");
}

function parseInlineSegments(text: string): InlineSegment[] {
  const sanitized = sanitizeThinkingText(text);
  const segments: InlineSegment[] = [];
  const markerRe =
    /(\*\*|__)(?=\S)([\s\S]*?\S)\1|`([^`]+)`|(?<![\w/.-])\*(?!\*)(?=\S)([\s\S]*?\S)(?<!\*)\*(?![\w/.-])|(?<![\w/.-])_(?!_)(?=\S)([\s\S]*?\S)(?<!_)_(?![\w/.-])/g;
  let lastIndex = 0;
  for (const match of sanitized.matchAll(markerRe)) {
    const start = match.index ?? 0;
    if (start > lastIndex) segments.push({ text: sanitized.slice(lastIndex, start), style: "plain" });
    if (match[2]) segments.push({ text: match[2], style: "bold" });
    if (match[3]) segments.push({ text: match[3], style: "code" });
    if (match[4]) segments.push({ text: match[4], style: "plain" });
    if (match[5]) segments.push({ text: match[5], style: "plain" });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < sanitized.length) segments.push({ text: sanitized.slice(lastIndex), style: "plain" });
  return segments;
}

function renderSegment(theme: ThinkingThemeLike, segment: InlineSegment, textColor: string): string {
  if (segment.style === "bold") return theme.bold(theme.fg(textColor, segment.text));
  if (segment.style === "code") return theme.bold(theme.fg("mdCode", segment.text));
  return theme.fg(textColor, segment.text);
}

function renderInline(theme: ThinkingThemeLike, text: string, textColor: string): string {
  const sanitized = sanitizeThinkingText(text);
  const segments = parseInlineSegments(sanitized);
  if (segments.length === 0) return theme.fg(textColor, sanitized);
  return segments.map((segment) => renderSegment(theme, segment, textColor)).join("");
}

// ---------- shared layout helpers ----------------------------------------

interface StepStyle {
  markerColor: string;
  summaryColor: string;
  bold: boolean;
}

function stepStyle(step: DerivedThinkingStep, active: boolean): StepStyle {
  if (active) {
    // Tier 1 signal (warning) lives on the marker; summary text stays Tier 3 (muted).
    // Bold is kept as a weight cue that the line is still being written.
    return { markerColor: "warning", summaryColor: "muted", bold: true };
  }
  if (step.hasExplicitFailure) {
    return { markerColor: "error", summaryColor: "error", bold: false };
  }
  if (step.role === "verify" && step.hasExplicitSuccess) {
    return { markerColor: "success", summaryColor: "muted", bold: false };
  }
  return { markerColor: "muted", summaryColor: "muted", bold: false };
}

function applyBold(theme: ThinkingThemeLike, text: string, bold: boolean): string {
  return bold ? theme.bold(text) : text;
}

function wrapStepHeader(
  theme: ThinkingThemeLike,
  width: number,
  step: DerivedThinkingStep,
  active: boolean,
): string[] {
  const style = stepStyle(step, active);
  const marker = theme.fg(style.markerColor, "•");
  const glyph = theme.fg(roleColor(step.role), roleGlyph(step.role));
  const prefix = `${marker} ${glyph} `;
  const continuationPrefix = "    "; // align under the first letter of the summary
  const summary = applyBold(theme, renderInline(theme, step.summary, style.summaryColor), style.bold);
  const innerWidth = Math.max(8, width - visibleWidth(prefix));
  const wrapped = wrapTextWithAnsi(summary, innerWidth);
  if (wrapped.length === 0) return [truncateToWidth(prefix, width, "")];
  return wrapped.map((line, index) =>
    truncateToWidth(`${index === 0 ? prefix : continuationPrefix}${line}`, width, ""),
  );
}

// Render the body text of a step beneath its header.  `isLast` controls whether
// the continuation connector is `  │ ` (more items follow) or `  └ ` (last).
function renderStepBody(
  theme: ThinkingThemeLike,
  width: number,
  body: string,
  isLast: boolean,
): string[] {
  const normalized = body.trim();
  if (!normalized) return [];

  const sanitized = sanitizeThinkingText(normalized).replace(/\t/g, "    ");
  const rawLines = sanitized.split("\n");
  if (rawLines.length === 0) return [];

  const continuationPrefix = `  ${theme.fg("muted", "│")} `;
  const corner = `  ${theme.fg("muted", "└")} `;
  const indent = `    `;
  const innerWidth = Math.max(8, width - visibleWidth(continuationPrefix));

  const lines: string[] = [];
  for (let rawIndex = 0; rawIndex < rawLines.length; rawIndex += 1) {
    const rawLine = rawLines[rawIndex] ?? "";
    if (rawLine.trim().length === 0) {
      lines.push(truncateToWidth(continuationPrefix, width, ""));
      continue;
    }
    const styled = renderInline(theme, rawLine, "thinkingText");
    const wrapped = wrapTextWithAnsi(styled, innerWidth);
    for (const piece of wrapped) {
      lines.push(truncateToWidth(`${continuationPrefix}${piece}`, width, ""));
    }
  }

  if (isLast && lines.length > 0) {
    // Replace the final continuation `│` with the corner `└` so the block
    // closes cleanly, matching the pi-basic-tools `formatCompactItem` shape.
    const lastBody = rawLines[rawLines.length - 1] ?? "";
    const lastStyled = renderInline(theme, lastBody.trim(), "thinkingText");
    const lastWrapped = wrapTextWithAnsi(lastStyled, innerWidth);
    if (lastWrapped.length > 0) {
      // Pop the wrapped tail off and re-emit it with the corner connector +
      // straight indent continuation for any extra wrap rows.
      for (let i = 0; i < lastWrapped.length; i += 1) lines.pop();
      const tailLines = lastWrapped.map((piece, index) =>
        truncateToWidth(`${index === 0 ? corner : indent}${piece}`, width, ""),
      );
      lines.push(...tailLines);
    }
  }

  return lines;
}

// ---------- step selection ------------------------------------------------

function pickCollapsedStep(steps: DerivedThinkingStep[], activeStepId?: string): DerivedThinkingStep | undefined {
  if (steps.length === 0) return undefined;
  if (activeStepId) {
    const active = steps.find((step) => step.id === activeStepId);
    if (active) return active;
  }

  let latestFailureIndex = -1;
  let latestSuccessAfterFailureIndex = -1;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.hasExplicitFailure) {
      latestFailureIndex = i;
      latestSuccessAfterFailureIndex = -1;
    }
    if (latestFailureIndex !== -1 && step.hasExplicitSuccess && i > latestFailureIndex) {
      latestSuccessAfterFailureIndex = i;
    }
  }

  if (latestSuccessAfterFailureIndex !== -1) return steps[latestSuccessAfterFailureIndex];
  if (latestFailureIndex !== -1) return steps[latestFailureIndex];

  return [...steps].sort((left, right) =>
    (right.collapsedPriority ?? 0) - (left.collapsedPriority ?? 0)
    || right.blockIndex - left.blockIndex
    || right.stepIndex - left.stepIndex,
  )[0];
}

function stepHasEventType(step: DerivedThinkingStep, type: string): boolean {
  return step.summaryEvents?.some((event) => event.type === type) ?? false;
}

function selectSummarySteps(steps: DerivedThinkingStep[], activeStepId?: string): DerivedThinkingStep[] {
  if (steps.length <= MAX_SUMMARY_STEPS) return steps;

  const indexed = steps.map((step, index) => ({ step, index }));
  const selected = new Set<number>();
  const activeIndex = activeStepId ? steps.findIndex((step) => step.id === activeStepId) : -1;

  let latestFailureIndex = -1;
  let latestSuccessAfterFailureIndex = -1;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.hasExplicitFailure) {
      latestFailureIndex = i;
      latestSuccessAfterFailureIndex = -1;
    }
    if (latestFailureIndex !== -1 && step.hasExplicitSuccess && i > latestFailureIndex) {
      latestSuccessAfterFailureIndex = i;
    }
  }

  if (activeIndex !== -1) selected.add(activeIndex);
  if (latestFailureIndex !== -1) selected.add(latestFailureIndex);
  if (latestSuccessAfterFailureIndex !== -1) selected.add(latestSuccessAfterFailureIndex);

  const scoreEntry = ({ step, index }: { step: DerivedThinkingStep; index: number }): number => {
    let score = step.collapsedPriority ?? 0;
    const isStaleSuccessBeforeLatestFailure =
      step.hasExplicitSuccess && latestFailureIndex !== -1 && index < latestFailureIndex;
    if (index === latestFailureIndex && latestSuccessAfterFailureIndex === -1) score += 120;
    if (index === latestSuccessAfterFailureIndex) score += 110;
    if (stepHasEventType(step, "decision") || stepHasEventType(step, "plan_change")) score += 80;
    if (step.hasExplicitFailure) score += 50;
    if (step.hasExplicitSuccess && !isStaleSuccessBeforeLatestFailure) score += 45;
    if (isStaleSuccessBeforeLatestFailure) score -= 200;
    if (
      stepHasEventType(step, "focus")
      && !stepHasEventType(step, "decision")
      && !stepHasEventType(step, "plan_change")
      && !step.hasExplicitFailure
      && !step.hasExplicitSuccess
    ) {
      score -= 15;
    }
    return score + (index / 100);
  };

  const targetCount = Math.min(MAX_SUMMARY_STEPS, steps.length);
  for (const entry of [...indexed].sort((left, right) => scoreEntry(right) - scoreEntry(left))) {
    if (selected.size >= targetCount) break;
    selected.add(entry.index);
  }

  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => steps[index]!)
    .slice(0, targetCount);
}

// ---------- mode renderers ------------------------------------------------

function pluralSteps(count: number): string {
  return `${count} step${count === 1 ? "" : "s"}`;
}

function renderGroupHeader(
  theme: ThinkingThemeLike,
  width: number,
  totalSteps: number,
  isActive: boolean,
): string {
  // Header format mirrors `Used 4 tools` / `Ran 5 commands` / `Explored 3
  // targets` from pi-basic-tools' compact tool grouping: `<verb> <count>
  // <noun>` with a single space separator and no `·` decoration.  The
  // count is always the true total even when summary mode shows fewer
  // selected steps below, again matching the basic-tool group title which
  // reports the real number of tool calls in the group.
  const titleColor = isActive ? "warning" : "muted";
  const title = theme.fg(titleColor, "Thinking");
  const subtitle = theme.fg("muted", pluralSteps(totalSteps));
  return truncateToWidth(`${title} ${subtitle}`, width, "");
}

function renderCollapsed(
  theme: ThinkingThemeLike,
  width: number,
  steps: DerivedThinkingStep[],
  activeStepId: string | undefined,
  isActive: boolean,
  nowMs: number,
): string[] {
  const step = pickCollapsedStep(steps, activeStepId);
  if (!step) return [];

  const style = stepStyle(step, isActive);
  const label = theme.fg(isActive ? "warning" : "muted", "Thinking");
  const sep = theme.fg("muted", "·");
  const glyph = theme.fg(roleColor(step.role), roleGlyph(step.role));
  const pulse = isActive ? ` ${pulseGlyph(theme, nowMs)}` : "";
  const pulseWidth = visibleWidth(pulse);
  const prefix = `${label} ${sep} ${glyph} `;
  const continuationPrefix = `${" ".repeat(visibleWidth("Thinking · "))}${" ".repeat(visibleWidth(`${roleGlyph(step.role)} `))}`;
  const innerWidth = Math.max(8, width - visibleWidth(prefix) - pulseWidth);
  const continuationWidth = Math.max(8, width - visibleWidth(continuationPrefix) - pulseWidth);

  const summary = applyBold(theme, renderInline(theme, step.summary, style.summaryColor), style.bold);
  const wrapped = wrapTextWithAnsi(summary, innerWidth);

  if (wrapped.length <= 1) {
    return [truncateToWidth(`${prefix}${wrapped[0] ?? summary}${pulse}`, width, "")];
  }

  const lines = wrapped.map((line, index) => {
    const isLast = index === wrapped.length - 1;
    if (index === 0) return truncateToWidth(`${prefix}${line}`, width, "");
    const wrappedInContinuation = wrapTextWithAnsi(line, continuationWidth);
    const useLine = wrappedInContinuation[0] ?? line;
    return truncateToWidth(
      `${continuationPrefix}${useLine}${isLast ? pulse : ""}`,
      width,
      "",
    );
  });
  return lines;
}

function renderSummary(
  theme: ThinkingThemeLike,
  width: number,
  steps: DerivedThinkingStep[],
  activeStepId: string | undefined,
  isActive: boolean,
): string[] {
  const visible = selectSummarySteps(steps, activeStepId);
  const lines: string[] = [renderGroupHeader(theme, width, steps.length, isActive)];
  for (const step of visible) {
    lines.push(...wrapStepHeader(theme, width, step, step.id === activeStepId));
  }
  return lines;
}

function renderExpanded(
  theme: ThinkingThemeLike,
  width: number,
  steps: DerivedThinkingStep[],
  activeStepId: string | undefined,
  isActive: boolean,
): string[] {
  const lines: string[] = [renderGroupHeader(theme, width, steps.length, isActive)];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    const isLast = index === steps.length - 1;
    lines.push(...wrapStepHeader(theme, width, step, step.id === activeStepId));
    lines.push(...renderStepBody(theme, width, step.body, isLast));
  }
  return lines;
}

// ---------- public API ----------------------------------------------------

export function renderThinkingStepsLines(theme: ThinkingThemeLike, width: number, options: RenderOptions): string[] {
  if (options.steps.length === 0) return [];
  if (options.mode === "collapsed") {
    return renderCollapsed(theme, width, options.steps, options.activeStepId, options.isActive, options.nowMs ?? Date.now());
  }
  if (options.mode === "expanded") {
    return renderExpanded(theme, width, options.steps, options.activeStepId, options.isActive);
  }
  return renderSummary(theme, width, options.steps, options.activeStepId, options.isActive);
}

export class ThinkingStepsComponent implements Component {
  private steps: DerivedThinkingStep[];
  private cacheKey?: string;
  private cachedLines?: string[];
  private readonly scopeKey: string;

  constructor(
    private readonly theme: ThinkingThemeLike,
    private readonly messageTimestamp: number,
    blocks: ThinkingSourceBlock[],
    scopeKey?: string,
  ) {
    this.steps = deriveThinkingSteps(blocks);
    this.scopeKey = scopeKey ?? getCurrentThinkingScopeKey();
  }

  render(width: number): string[] {
    const mode = getThinkingStepsMode(this.scopeKey);
    const active = getActiveThinkingState(this.messageTimestamp, this.scopeKey);
    const activeStepId = active.active && active.contentIndex !== undefined
      ? [...this.steps].reverse().find((step) => step.contentIndex === active.contentIndex)?.id
      : undefined;
    const shouldBypassCache = mode === "collapsed" && active.active;
    const nextCacheKey = `${width}:${mode}:${active.active ? 1 : 0}:${activeStepId ?? ""}`;
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
