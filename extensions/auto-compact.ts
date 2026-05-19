/**
 * Proactive auto-compaction for Capy Tools, forked from
 * https://github.com/capyup/pi-auto-compact (MIT, capyup).
 *
 * Pi's built-in auto-compaction checks after `agent_end`; this extension also
 * checks before a request, after tool batches, on session resume/fork, and in
 * the `context` hook as an emergency fallback before the model request leaves
 * the process. Settings are stored in the unified Capy Tools config file and
 * controlled from `/capy-tools-settings`.
 */

import type { AgentMessage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_AUTO_COMPACT_CONFIG,
  STRATEGY_LABELS,
  getCapyToolsSettings,
  restoreCapyToolsSettings,
  updateCapyToolsSettings,
  type AutoCompactConfig,
  type CompactionStrategy,
} from "./capy-tools-config.ts";

const estimateMessageTokens = estimateTokens;

type AutoCompactPhase = "pre-turn" | "mid-turn" | "emergency" | "session-resume";

const AUTO_COMPACT_FOLLOW_UP: Record<AutoCompactPhase, string> = {
  "pre-turn": "Auto-compact ran before this turn. Continue with the current task.",
  "mid-turn": "Auto-compact ran mid-turn. Continue executing the remaining work.",
  "emergency": "Emergency auto-compact ran. Resume where we left off.",
  "session-resume": "Auto-compact ran on session resume. Continue with the active task.",
};

let config: AutoCompactConfig = { ...DEFAULT_AUTO_COMPACT_CONFIG };
let pendingCompaction = false;
let lastEstimatedTokens = 0;
let truncationAppliedThisTurn = false;
let cachedContextWindow = 0;
let cachedAutoCompactLimit = 0;
let cachedKeepRecentTokens = 0;

export function getAutoCompactConfig(): AutoCompactConfig {
  return { ...config };
}

export async function restoreAutoCompactSettings(): Promise<AutoCompactConfig> {
  const settings = await restoreCapyToolsSettings();
  applyConfig(settings.autoCompact);
  return getAutoCompactConfig();
}

export async function persistAutoCompactConfig(overrides: Partial<AutoCompactConfig>): Promise<AutoCompactConfig> {
  applyConfig(overrides);
  await updateCapyToolsSettings((settings) => ({ ...settings, autoCompact: { ...config } }));
  return getAutoCompactConfig();
}

export function getAutoCompactRuntimeStatus(ctx?: {
  getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  model?: { contextWindow?: number };
}) {
  if (ctx) updateCachedLimitsFromContext(ctx);
  const usage = ctx?.getContextUsage?.();
  const tokens = usage?.tokens ?? lastEstimatedTokens;
  const contextWindow = usage?.contextWindow ?? cachedContextWindow;
  const percent = usage?.percent ?? (contextWindow > 0 ? (tokens / contextWindow) * 100 : null);
  return {
    config: getAutoCompactConfig(),
    tokens,
    contextWindow,
    percent,
    autoCompactLimit: cachedAutoCompactLimit,
    keepRecentTokens: cachedKeepRecentTokens,
    pendingCompaction,
    truncationAppliedThisTurn,
  };
}

function applyConfig(overrides: Partial<AutoCompactConfig>): void {
  config = { ...config, ...overrides };
  if (cachedContextWindow > 0) {
    cachedAutoCompactLimit = computeAutoCompactLimit(cachedContextWindow);
    cachedKeepRecentTokens = computeKeepRecentTokens(cachedContextWindow);
  }
}

function computeAutoCompactLimit(contextWindow: number): number {
  if (config.autoCompactPercent > 0) {
    return Math.floor((contextWindow * config.autoCompactPercent) / 100);
  }
  return config.autoCompactTokenLimit;
}

function computeKeepRecentTokens(contextWindow: number): number {
  return Math.floor((contextWindow * config.keepRecentPercent) / 100);
}

function updateCachedLimitsFromContext(ctx: { model?: { contextWindow?: number } }, contextWindowOverride?: number): void {
  const contextWindow = contextWindowOverride ?? ctx.model?.contextWindow ?? 200000;
  if (contextWindow !== cachedContextWindow) {
    cachedContextWindow = contextWindow;
  }
  cachedAutoCompactLimit = computeAutoCompactLimit(contextWindow);
  cachedKeepRecentTokens = computeKeepRecentTokens(contextWindow);
}

function getTokenUsage(ctx: {
  getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  model?: { contextWindow?: number };
}): number {
  const usage = ctx.getContextUsage?.();
  if (usage?.contextWindow) {
    updateCachedLimitsFromContext(ctx, usage.contextWindow);
  } else {
    updateCachedLimitsFromContext(ctx);
  }
  return usage?.tokens ?? lastEstimatedTokens;
}

function estimateTotalTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) total += estimateMessageTokens(msg);
  return total;
}

function snapToUserBoundary(messages: AgentMessage[], rawIndex: number): number {
  let idx = rawIndex;
  while (idx < messages.length) {
    if (messages[idx].role === "user") break;
    idx++;
  }
  return Math.min(idx, messages.length);
}

function findCutPointRecent(messages: AgentMessage[], keepTokens: number): number {
  let accumulated = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateMessageTokens(messages[i]);
    if (accumulated + tokens > keepTokens) {
      return snapToUserBoundary(messages, i + 1);
    }
    accumulated += tokens;
  }
  return 0;
}

function findBookendCutRange(messages: AgentMessage[], keepTokens: number): [number, number] {
  const halfBudget = Math.floor(keepTokens / 2);

  let headEnd = 0;
  let headTokens = 0;
  for (let i = 0; i < messages.length; i++) {
    const tokens = estimateMessageTokens(messages[i]);
    if (headTokens + tokens > halfBudget) break;
    headTokens += tokens;
    headEnd = i + 1;
  }
  headEnd = snapToUserBoundary(messages, headEnd);

  let tailStart = messages.length;
  let tailTokens = 0;
  for (let i = messages.length - 1; i >= headEnd; i--) {
    const tokens = estimateMessageTokens(messages[i]);
    if (tailTokens + tokens > halfBudget) break;
    tailTokens += tokens;
    tailStart = i;
  }
  while (tailStart > headEnd && messages[tailStart]?.role !== "user") tailStart--;
  tailStart = Math.max(tailStart, headEnd);

  if (tailStart <= headEnd) return [0, 0];
  return [headEnd, tailStart];
}

function applyTruncationStrategy(
  messages: AgentMessage[],
  keepTokens: number,
  strategy: CompactionStrategy,
): AgentMessage[] | null {
  switch (strategy) {
    case "keep-recent": {
      const cutIndex = findCutPointRecent(messages, keepTokens);
      if (cutIndex <= 0) return null;
      const removed = messages.slice(0, cutIndex);
      const kept = messages.slice(cutIndex);
      return [createTruncationNotice(removed.length, estimateTotalTokens(removed)), ...kept];
    }
    case "keep-bookends": {
      const [removeStart, removeEnd] = findBookendCutRange(messages, keepTokens);
      if (removeStart >= removeEnd) return null;
      const removed = messages.slice(removeStart, removeEnd);
      return [
        ...messages.slice(0, removeStart),
        createTruncationNotice(removed.length, estimateTotalTokens(removed)),
        ...messages.slice(removeEnd),
      ];
    }
    case "summarize-all": {
      if (messages.length <= 1) return null;
      const lastUserIdx = messages.length - 1;
      const removed = messages.slice(0, lastUserIdx);
      return [createTruncationNotice(removed.length, estimateTotalTokens(removed)), messages[lastUserIdx]];
    }
  }
}

function createTruncationNotice(removedCount: number, removedTokens: number): AgentMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `[Context compacted: ${removedCount} earlier messages (~${Math.round(removedTokens / 1000)}K tokens) were summarized. Full context is preserved in session history. Continue with the current task.]`,
      },
    ],
    timestamp: Date.now(),
  } as AgentMessage;
}

function triggerAutoCompact(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  phase: AutoCompactPhase,
  customInstructions?: string,
): void {
  if (pendingCompaction) return;
  pendingCompaction = true;
  ctx.compact({
    customInstructions,
    onComplete: () => {
      pendingCompaction = false;
      // Defer until pi has flushed queued user messages from compaction_end.
      setImmediate(() => {
        if (ctx.isIdle()) pi.sendUserMessage(AUTO_COMPACT_FOLLOW_UP[phase]);
      });
    },
    onError: () => {
      pendingCompaction = false;
    },
  });
}

function assistantMessageHasToolCalls(message: AgentMessage): boolean {
  if (message.role !== "assistant" || !("content" in message) || !Array.isArray(message.content)) return false;
  return message.content.some((block: unknown) => {
    if (!block || typeof block !== "object") return false;
    const type = (block as { type?: unknown }).type;
    return type === "tool_use" || type === "toolCall";
  });
}

export function formatAutoCompactStatus(ctx: {
  getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  model?: { contextWindow?: number };
}): string {
  const status = getAutoCompactRuntimeStatus(ctx);
  const percent = status.percent ?? 0;
  return [
    "Auto-compact status:",
    `  Current tokens: ~${Math.round(status.tokens / 1000)}K`,
    `  Limit: ${Math.round(status.autoCompactLimit / 1000)}K (${status.config.autoCompactPercent}% of ${Math.round(status.contextWindow / 1000)}K)`,
    `  Usage: ${percent.toFixed(1)}%`,
    `  Keep recent: ${Math.round(status.keepRecentTokens / 1000)}K (${status.config.keepRecentPercent}%)`,
    `  Strategy: ${STRATEGY_LABELS[status.config.strategy]}`,
    `  Pending compaction: ${status.pendingCompaction}`,
    `  Truncation this turn: ${status.truncationAppliedThisTurn}`,
  ].join("\n");
}

export default function autoCompactExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    pendingCompaction = false;
    truncationAppliedThisTurn = false;
    lastEstimatedTokens = 0;

    await restoreAutoCompactSettings();

    if (event.reason === "resume" || event.reason === "fork") {
      const usage = ctx.getContextUsage?.();
      if (usage && usage.tokens !== null) {
        lastEstimatedTokens = usage.tokens;
        updateCachedLimitsFromContext(ctx as { model?: { contextWindow?: number } }, usage.contextWindow);
        if (usage.tokens >= cachedAutoCompactLimit) {
          triggerAutoCompact(pi, ctx, "session-resume");
        }
      }
    }
  });

  pi.on("turn_start", async (_event, ctx) => {
    truncationAppliedThisTurn = false;
    await restoreAutoCompactSettings();
    const tokens = getTokenUsage(ctx);

    if (tokens >= cachedAutoCompactLimit) {
      triggerAutoCompact(pi, ctx, "pre-turn", "Focus on preserving task context and recent work.");
    }
  });

  pi.on("context", async (event, ctx) => {
    const messages = event.messages as AgentMessage[];
    const estimatedTokens = estimateTotalTokens(messages);
    lastEstimatedTokens = estimatedTokens;
    updateCachedLimitsFromContext(ctx as { model?: { contextWindow?: number } });

    if (estimatedTokens > cachedAutoCompactLimit && !pendingCompaction) {
      const newMessages = applyTruncationStrategy(messages, cachedKeepRecentTokens, config.strategy);
      if (newMessages) {
        truncationAppliedThisTurn = true;
        setImmediate(() => {
          triggerAutoCompact(
            pi,
            ctx,
            "emergency",
            "Emergency context truncation was applied. Generate a comprehensive summary.",
          );
        });
        return { messages: newMessages };
      }
    }
    return;
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!assistantMessageHasToolCalls(event.message as AgentMessage)) return;

    const tokens = getTokenUsage(ctx);
    if (tokens >= cachedAutoCompactLimit && !pendingCompaction) {
      triggerAutoCompact(
        pi,
        ctx,
        "mid-turn",
        "Mid-turn compaction: preserve current task context and tool call results.",
      );
    }
  });

  pi.on("model_select", async (event) => {
    updateCachedLimitsFromContext({ model: { contextWindow: event.model?.contextWindow ?? 200000 } });
  });
}
