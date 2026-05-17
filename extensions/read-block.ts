import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { canGroupTool, renderGroupedToolCall, renderGroupedToolResult, summarizeToolCall } from "./basic-tool-grouping.ts";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { capRange, chooseBlock, clamp, detectMode, findAnchorLine, formatLines, splitLines } from "./block-utils.ts";

const readBlockSchema = Type.Object({
  path: Type.String({ description: "File to read from (relative or absolute)" }),
  line: Type.Optional(Type.Number({ description: "1-indexed anchor line. Required unless symbol is provided." })),
  symbol: Type.Optional(Type.String({ description: "Symbol or markdown heading text to locate when line is not provided" })),
  mode: Type.Optional(Type.String({ description: "Block detection mode: auto, markdown, indentation, or window (default auto)" })),
  context: Type.Optional(Type.Number({ description: "Extra lines before and after the detected block (default 0, max 20)" })),
  maxLines: Type.Optional(Type.Number({ description: "Maximum lines returned to the model (default 120, max 1000)" })),
});

type ReadBlockDetails = {
  path: string;
  displayPath: string;
  anchorLine: number;
  blockStart: number;
  blockEnd: number;
  outputStart: number;
  outputEnd: number;
  reason: string;
  truncated: boolean;
  lineCount: number;
  fileName: string;
  outputLineCount: number;
  blockLineCount: number;
};

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

function renderReadBlockResult(result: any, { expanded, isPartial }: { expanded?: boolean; isPartial?: boolean }, theme: any) {
  if (isPartial) return new Text(theme.fg("warning", "Reading block..."), 0, 0);

  const details = result.details as ReadBlockDetails | undefined;
  if (!details) return new Text(theme.fg("accent", "Read block"), 0, 0);

  const hint = safeKeyHint("app.tools.expand", "to expand");
  return new Text(theme.fg("accent", `Read ${details.displayPath}:${details.outputStart}-${details.outputEnd}`) + theme.fg("muted", `\n${hint}`), 0, 0);
}

export default function readBlockExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read_block",
    label: "read_block",
    description:
      "Read one semantic block around a specific line or symbol: markdown section, brace block, CSS rule, or indentation block. This is for targeted inspection, not sequential file scanning.",
    promptSnippet: "Read one enclosing code, CSS, or Markdown block around a specific line or symbol",
    promptGuidelines: [
      "Use read_block only after repo_map, grep, find, or symbol_outline identifies a specific relevant symbol or line.",
      "Do not call read_block repeatedly on many nearby lines in the same file; that is inefficient sliding-window scanning.",
      "If you need adjacent regions or broad context from one file, use read with offset/limit or read the whole file when reasonable.",
      "Use symbol_outline first when you need to discover a file's readable blocks, CSS rules, or Markdown sections, then read only the chosen anchors.",
      "Use read for exact ranges or full files; use read_block for one enclosing function/class/CSS rule/section.",
    ],
    parameters: readBlockSchema,
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderGroupedToolCall("read_block", args, theme, context, summarizeToolCall("read_block", args));
    },
    renderResult(result, options, theme, context) {
      if (options.expanded || !canGroupTool(context)) return renderReadBlockResult(result, options, theme);
      return renderGroupedToolResult("read_block", result, options, theme, context);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.path);
      const mode = detectMode(filePath, params.mode);
      const maxLines = clamp(params.maxLines, 120, 1, 1000);
      const context = clamp(params.context, 0, 0, 20);
      const lines = splitLines(await readFile(filePath, "utf8"));
      const anchor = findAnchorLine(lines, params.symbol, params.line);
      const range = chooseBlock(filePath, lines, anchor.index, mode, maxLines);
      const capped = capRange(range, anchor.index, context, maxLines, lines.length);
      const header = [
        `File: ${params.path}`,
        `Anchor: L${anchor.index + 1} (${anchor.reason})`,
        `Block: L${range.start + 1}-L${range.end + 1} (${range.reason})`,
      ];
      if (capped.truncated) header.push(`Truncated: showing L${capped.start + 1}-L${capped.end + 1} of L${capped.originalStart + 1}-L${capped.originalEnd + 1}`);

      const outputLineCount = capped.end - capped.start + 1;

      return {
        content: [{ type: "text" as const, text: `${header.join("\n")}\n\n${formatLines(lines, capped.start, capped.end)}` }],
        details: {
          path: filePath,
          displayPath: params.path,
          anchorLine: anchor.index + 1,
          blockStart: range.start + 1,
          blockEnd: range.end + 1,
          outputStart: capped.start + 1,
          outputEnd: capped.end + 1,
          reason: range.reason,
          truncated: capped.truncated,
          lineCount: lines.length,
          fileName: basename(filePath),
          outputLineCount,
          blockLineCount: range.end - range.start + 1,
        } satisfies ReadBlockDetails,
      };
    },
  });
}
