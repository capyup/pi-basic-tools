import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createEditToolDefinition, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool, createWriteToolDefinition, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { canGroupTool, installBasicToolGrouping, renderGroupedToolCall, renderGroupedToolResult, summarizeToolCall } from "./basic-tool-grouping.ts";

const DEFAULT_BUILTINS = new Set(["read", "bash", "edit", "write"]);
const SEARCH_BUILTINS = ["grep", "find", "ls"] as const;

function safeKeyHint(keybinding: string, description: string): string {
  try {
    return keyHint(keybinding, description);
  } catch {
    return `(${description})`;
  }
}

function fallbackText(result: any): string {
  const content = result.content?.[0];
  return content?.type === "text" ? content.text : "";
}

function countNonEmptyLines(text: string): number {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

function plural(noun: string, count: number): string {
  if (count === 1) return noun;
  if (noun === "match") return "matches";
  if (noun === "entry") return "entries";
  return `${noun}s`;
}

function renderSearchResult(label: string, noun: string, result: any, { expanded, isPartial }: { expanded?: boolean; isPartial?: boolean }, theme: any) {
  if (isPartial) return new Text(theme.fg("warning", `${label}...`), 0, 0);

  const fullText = fallbackText(result);
  const count = countNonEmptyLines(fullText);
  const truncated = result.details?.truncation?.truncated || result.details?.matchLimitReached || result.details?.resultLimitReached || result.details?.entryLimitReached;
  const hint = safeKeyHint("app.tools.expand", "to expand");
  const summary = count === 0 || /no matches|no files|empty/i.test(fullText) ? `No ${plural(noun, 2)}` : `${label === "grep" ? "Search" : label === "find" ? "Find" : "List"} results`;
  return new Text(theme.fg("accent", summary) + theme.fg("dim", `${truncated ? "\ntruncated" : ""}\n${hint}`), 0, 0);
}

function registerCompactBuiltInRenderers(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const read = createReadTool(cwd);
  const bash = createBashTool(cwd);
  const edit = createEditToolDefinition(cwd);
  const write = createWriteToolDefinition(cwd);
  const grep = createGrepTool(cwd);
  const find = createFindTool(cwd);
  const ls = createLsTool(cwd);

  pi.registerTool({
    name: "read",
    label: read.label,
    description: read.description,
    promptSnippet: read.promptSnippet,
    promptGuidelines: read.promptGuidelines,
    parameters: read.parameters,
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderGroupedToolCall("read", args, theme, context, summarizeToolCall("read", args));
    },
    renderResult(result, options, theme, context) {
      if (!canGroupTool(context)) return new Text(theme.fg("accent", "Read file"), 0, 0);
      return renderGroupedToolResult("read", result, options, theme, context);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createReadTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    name: "bash",
    label: bash.label,
    description: bash.description,
    promptSnippet: bash.promptSnippet,
    promptGuidelines: bash.promptGuidelines,
    parameters: bash.parameters,
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderGroupedToolCall("bash", args, theme, context, summarizeToolCall("bash", args));
    },
    renderResult(result, options, theme, context) {
      if (!canGroupTool(context)) return new Text(theme.fg(result?.isError ? "error" : "accent", "Ran command"), 0, 0);
      return renderGroupedToolResult("bash", result, options, theme, context);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createBashTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    name: "edit",
    label: edit.label,
    description: edit.description,
    promptSnippet: edit.promptSnippet,
    promptGuidelines: edit.promptGuidelines,
    parameters: edit.parameters,
    renderShell: "self",
    renderCall(args, theme, context) {
      return edit.renderCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return edit.renderResult(result, options, theme, context);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createEditTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    name: "write",
    label: write.label,
    description: write.description,
    promptSnippet: write.promptSnippet,
    promptGuidelines: write.promptGuidelines,
    parameters: write.parameters,
    renderShell: "self",
    renderCall(args, theme, context) {
      return write.renderCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return write.renderResult(result, options, theme, context);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createWriteTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    name: "grep",
    label: grep.label,
    description: grep.description,
    promptSnippet: grep.promptSnippet,
    promptGuidelines: grep.promptGuidelines,
    parameters: grep.parameters,
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderGroupedToolCall("grep", args, theme, context, summarizeToolCall("grep", args));
    },
    renderResult(result, options, theme, context) {
      if (options.expanded || !canGroupTool(context)) return renderSearchResult("grep", "match", result, options, theme);
      return renderGroupedToolResult("grep", result, options, theme, context);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createGrepTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    name: "find",
    label: find.label,
    description: find.description,
    promptSnippet: find.promptSnippet,
    promptGuidelines: find.promptGuidelines,
    parameters: find.parameters,
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderGroupedToolCall("find", args, theme, context, summarizeToolCall("find", args));
    },
    renderResult(result, options, theme, context) {
      if (options.expanded || !canGroupTool(context)) return renderSearchResult("find", "path", result, options, theme);
      return renderGroupedToolResult("find", result, options, theme, context);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createFindTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    name: "ls",
    label: ls.label,
    description: ls.description,
    promptSnippet: ls.promptSnippet,
    promptGuidelines: ls.promptGuidelines,
    parameters: ls.parameters,
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderGroupedToolCall("ls", args, theme, context, summarizeToolCall("ls", args));
    },
    renderResult(result, options, theme, context) {
      if (options.expanded || !canGroupTool(context)) return renderSearchResult("ls", "entry", result, options, theme);
      return renderGroupedToolResult("ls", result, options, theme, context);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return createLsTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
    },
  });
}

function enableSearchBuiltins(pi: ExtensionAPI) {
  const activeTools = pi.getActiveTools();

  // Respect explicit no-builtin/no-tools sessions: only augment the normal default tool set.
  if (!activeTools.some((name) => DEFAULT_BUILTINS.has(name))) return;

  const availableBuiltins = new Set(
    pi
      .getAllTools()
      .filter((tool) => tool.sourceInfo.source === "builtin")
      .map((tool) => tool.name),
  );

  const nextTools = [...activeTools];
  for (const name of SEARCH_BUILTINS) {
    if (availableBuiltins.has(name) && !nextTools.includes(name)) {
      nextTools.push(name);
    }
  }

  if (nextTools.length !== activeTools.length) {
    pi.setActiveTools(nextTools);
  }
}

export default function enableBuiltinSearchExtension(pi: ExtensionAPI) {
  installBasicToolGrouping(pi);
  registerCompactBuiltInRenderers(pi);
  pi.on("session_start", () => enableSearchBuiltins(pi));
  pi.on("resources_discover", () => enableSearchBuiltins(pi));
}
