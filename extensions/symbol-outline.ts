import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { chooseBlock, clamp, declarationName, detectMode, indentOf, splitLines, type Mode } from "./block-utils.ts";

type SymbolKind = "function" | "class" | "interface" | "type" | "enum" | "const" | "let" | "var" | "def" | "struct" | "trait" | "impl" | "heading" | "symbol";

type OutlineBlock = {
  index: number;
  kind: SymbolKind;
  name: string;
  signature: string;
  anchorLine: number;
  blockStart: number;
  blockEnd: number;
  lineCount: number;
  reason: string;
  readBlock: { path: string; line: number };
  headingLevel?: number;
};

const symbolOutlineSchema = Type.Object({
  path: Type.String({ description: "File to outline (relative or absolute)" }),
  mode: Type.Optional(Type.String({ description: "Block detection mode: auto, markdown, indentation, or window (default auto)" })),
  includeNested: Type.Optional(Type.Boolean({ description: "Include indented declarations such as methods or nested functions (default false)" })),
  maxBlocks: Type.Optional(Type.Number({ description: "Maximum blocks displayed in text output (default 120, max 500)" })),
  maxSignatureLength: Type.Optional(Type.Number({ description: "Maximum characters shown for each signature (default 140, max 240)" })),
});

function isMarkdownPath(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === ".md" || ext === ".mdx";
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactSignature(line: string, maxLength: number): string {
  return truncate(line.trim().replace(/\s+/g, " "), maxLength);
}

function headingInfo(line: string): { name: string; level: number } | undefined {
  const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (!match) return undefined;
  return { level: match[1].length, name: match[2].trim() };
}

function declarationKind(line: string): SymbolKind | undefined {
  const trimmed = line.trim();
  if (/^(export\s+)?(default\s+)?(async\s+)?function\b/.test(trimmed)) return "function";
  if (/^(export\s+)?(default\s+)?(abstract\s+)?class\b/.test(trimmed)) return "class";
  if (/^(export\s+)?interface\b/.test(trimmed)) return "interface";
  if (/^(export\s+)?type\b/.test(trimmed)) return "type";
  if (/^(export\s+)?enum\b/.test(trimmed)) return "enum";
  if (/^(export\s+)?const\b/.test(trimmed)) return "const";
  if (/^(export\s+)?let\b/.test(trimmed)) return "let";
  if (/^(export\s+)?var\b/.test(trimmed)) return "var";
  if (/^def\b/.test(trimmed)) return "def";
  if (/^class\b/.test(trimmed)) return "class";
  if (/^(pub\s+)?(async\s+)?fn\b/.test(trimmed)) return "function";
  if (/^(pub\s+)?struct\b/.test(trimmed)) return "struct";
  if (/^(pub\s+)?enum\b/.test(trimmed)) return "enum";
  if (/^(pub\s+)?trait\b/.test(trimmed)) return "trait";
  if (/^(pub\s+)?impl\b/.test(trimmed)) return "impl";
  if (/^func\b/.test(trimmed)) return "function";
  return undefined;
}

function shouldIncludeDeclaration(line: string, includeNested: boolean): boolean {
  if (includeNested) return true;
  return indentOf(line) === 0;
}

function buildOutlineBlocks(filePath: string, displayPath: string, lines: string[], mode: Mode, includeNested: boolean, maxSignatureLength: number): OutlineBlock[] {
  const markdown = mode === "markdown" || (mode === "auto" && isMarkdownPath(filePath));
  const blocks: OutlineBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    let kind: SymbolKind | undefined;
    let name: string | undefined;
    let headingLevel: number | undefined;

    if (markdown) {
      const heading = headingInfo(lines[i]);
      if (!heading) continue;
      kind = "heading";
      name = heading.name;
      headingLevel = heading.level;
    } else {
      name = declarationName(lines[i]);
      if (!name || !shouldIncludeDeclaration(lines[i], includeNested)) continue;
      kind = declarationKind(lines[i]) ?? "symbol";
    }

    const range = chooseBlock(filePath, lines, i, mode, 1000);
    blocks.push({
      index: blocks.length + 1,
      kind,
      name,
      signature: compactSignature(lines[i], maxSignatureLength),
      anchorLine: i + 1,
      blockStart: range.start + 1,
      blockEnd: range.end + 1,
      lineCount: range.end - range.start + 1,
      reason: range.reason,
      readBlock: { path: displayPath, line: i + 1 },
      ...(headingLevel ? { headingLevel } : {}),
    });
  }

  return blocks;
}

function formatBlock(block: OutlineBlock): string {
  const kind = block.kind === "heading" && block.headingLevel ? `heading h${block.headingLevel}` : block.kind;
  return [
    `[${block.index}] L${block.blockStart}-L${block.blockEnd} ${kind} ${block.name} (${block.lineCount} lines)`,
    `    ${block.signature}`,
    `    read_block: line=${block.anchorLine}`,
  ].join("\n");
}

export default function symbolOutlineExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "symbol_outline",
    label: "symbol_outline",
    description:
      "List the readable symbols or Markdown sections in a file with line anchors that can be passed directly to read_block.",
    promptSnippet: "Outline a file into readable blocks before choosing a read_block line anchor",
    promptGuidelines: [
      "Use symbol_outline before read_block when you need to discover a file's functions, classes, types, or Markdown sections.",
      "Use the returned read_block line anchor to read exactly the block you choose.",
      "Prefer includeNested=false for navigation; enable includeNested only when methods or nested declarations matter.",
    ],
    parameters: symbolOutlineSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.path);
      const mode = detectMode(filePath, params.mode);
      const includeNested = Boolean(params.includeNested);
      const maxBlocks = clamp(params.maxBlocks, 120, 1, 500);
      const maxSignatureLength = clamp(params.maxSignatureLength, 140, 40, 240);
      const lines = splitLines(await readFile(filePath, "utf8"));
      const blocks = buildOutlineBlocks(filePath, params.path, lines, mode, includeNested, maxSignatureLength);
      const visible = blocks.slice(0, maxBlocks);
      const header = [
        `File: ${params.path}`,
        `Lines: ${lines.length}`,
        `Blocks: ${blocks.length}${blocks.length > visible.length ? ` (showing first ${visible.length})` : ""}`,
      ];
      const body = visible.length > 0 ? visible.map(formatBlock).join("\n\n") : "No outline blocks found.";

      return {
        content: [{ type: "text" as const, text: `${header.join("\n")}\n\n${body}` }],
        details: {
          path: filePath,
          displayPath: params.path,
          fileName: basename(filePath),
          lineCount: lines.length,
          blockCount: blocks.length,
          displayedBlockCount: visible.length,
          truncated: blocks.length > visible.length,
          includeNested,
          mode,
          blocks,
        },
      };
    },
  });
}
