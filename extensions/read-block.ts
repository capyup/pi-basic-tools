import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

const readBlockSchema = Type.Object({
  path: Type.String({ description: "File to read from (relative or absolute)" }),
  line: Type.Optional(Type.Number({ description: "1-indexed anchor line. Required unless symbol is provided." })),
  symbol: Type.Optional(Type.String({ description: "Symbol or markdown heading text to locate when line is not provided" })),
  mode: Type.Optional(Type.String({ description: "Block detection mode: auto, markdown, indentation, or window (default auto)" })),
  context: Type.Optional(Type.Number({ description: "Extra lines before and after the detected block (default 0, max 20)" })),
  maxLines: Type.Optional(Type.Number({ description: "Maximum lines returned (default 9, max 1000)" })),
});

type Mode = "auto" | "markdown" | "indentation" | "window";

type BlockRange = {
  start: number;
  end: number;
  reason: string;
};

const DECLARATION_PATTERNS = [
  /^\s*(export\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)\b/,
  /^\s*(export\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/,
  /^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/,
  /^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)\b/,
  /^\s*(export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/,
  /^\s*(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\b/,
  /^\s*def\s+([A-Za-z_][\w]*)\b/,
  /^\s*class\s+([A-Za-z_][\w]*)\b/,
  /^\s*(pub\s+)?(async\s+)?fn\s+([A-Za-z_][\w]*)\b/,
  /^\s*(pub\s+)?(struct|enum|trait|impl)\s+([A-Za-z_][\w]*)\b/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\b/,
];

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value ?? NaN)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indentOf(line: string): number {
  let indent = 0;
  for (const ch of line) {
    if (ch === " ") indent += 1;
    else if (ch === "\t") indent += 4;
    else break;
  }
  return indent;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function isComment(line: string): boolean {
  return /^\s*(\/\/|#|--|\*)/.test(line);
}

function looksLikeBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return /[{:]\s*$/.test(trimmed) || DECLARATION_PATTERNS.some((pattern) => pattern.test(line));
}

function countBraceDelta(line: string): number {
  let delta = 0;
  let quote: string | null = null;
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") delta++;
    else if (ch === "}") delta--;
  }
  return delta;
}

function declarationName(line: string): string | undefined {
  for (const pattern of DECLARATION_PATTERNS) {
    const match = line.match(pattern);
    if (!match) continue;
    return match[match.length - 1];
  }
  return undefined;
}

function findAnchorLine(lines: string[], symbol?: string, line?: number): { index: number; reason: string } {
  if (line !== undefined) {
    const idx = Math.floor(line) - 1;
    if (idx < 0 || idx >= lines.length) throw new Error(`line ${line} is outside file range 1-${lines.length}`);
    return { index: idx, reason: `line ${line}` };
  }

  const needle = symbol?.trim();
  if (!needle) throw new Error("Provide either line or symbol.");

  const word = new RegExp(`\\b${escapeRegex(needle)}\\b`);
  for (let i = 0; i < lines.length; i++) {
    if (declarationName(lines[i]) === needle) return { index: i, reason: `declaration '${needle}'` };
  }
  for (let i = 0; i < lines.length; i++) {
    if (/^\s{0,3}#{1,6}\s+/.test(lines[i]) && lines[i].toLowerCase().includes(needle.toLowerCase())) {
      return { index: i, reason: `heading '${needle}'` };
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (word.test(lines[i])) return { index: i, reason: `symbol '${needle}'` };
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) return { index: i, reason: `text '${needle}'` };
  }

  throw new Error(`Could not find symbol or text '${needle}'`);
}

function markdownBlock(lines: string[], anchor: number): BlockRange {
  let start = anchor;
  let level = 7;

  for (let i = anchor; i >= 0; i--) {
    const match = lines[i].match(/^(#{1,6})\s+/);
    if (match) {
      start = i;
      level = match[1].length;
      break;
    }
  }

  let end = lines.length - 1;
  if (level <= 6) {
    for (let i = start + 1; i < lines.length; i++) {
      const match = lines[i].match(/^(#{1,6})\s+/);
      if (match && match[1].length <= level) {
        end = i - 1;
        break;
      }
    }
  }

  return { start, end, reason: level <= 6 ? `markdown heading level ${level}` : "markdown window" };
}

function braceBlock(lines: string[], start: number): BlockRange | undefined {
  let openSeen = false;
  let balance = 0;
  for (let i = start; i < lines.length; i++) {
    const delta = countBraceDelta(lines[i]);
    if (delta > 0) openSeen = true;
    balance += delta;
    if (openSeen && balance <= 0) {
      return { start, end: i, reason: "brace block" };
    }
    if (!openSeen && i > start + 8) return undefined;
  }
  return undefined;
}

function findParentStart(lines: string[], anchor: number): number {
  let current = anchor;
  while (current > 0 && isBlank(lines[current])) current--;
  const anchorIndent = indentOf(lines[current]);

  if (looksLikeBlockStart(lines[current])) return current;

  for (let i = current - 1; i >= 0; i--) {
    if (isBlank(lines[i]) || isComment(lines[i])) continue;
    const indent = indentOf(lines[i]);
    if (indent < anchorIndent && looksLikeBlockStart(lines[i])) return i;
    if (indent === 0 && anchorIndent === 0) return current;
  }

  return current;
}

function indentationBlock(lines: string[], anchor: number): BlockRange {
  const startCandidate = findParentStart(lines, anchor);
  const brace = braceBlock(lines, startCandidate);
  if (brace) return brace;

  const baseIndent = indentOf(lines[startCandidate]);
  let start = startCandidate;
  while (start > 0) {
    const prev = lines[start - 1];
    if (isBlank(prev) || isComment(prev)) {
      start--;
      continue;
    }
    if (indentOf(prev) < baseIndent) break;
    if (baseIndent === 0 && indentOf(prev) === 0 && looksLikeBlockStart(lines[startCandidate])) break;
    start--;
  }

  let end = startCandidate;
  for (let i = startCandidate + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) {
      end = i;
      continue;
    }
    const indent = indentOf(line);
    if (baseIndent === 0 && indent === 0 && looksLikeBlockStart(lines[startCandidate]) && i > startCandidate) break;
    if (indent < baseIndent) break;
    end = i;
  }

  return { start, end, reason: "indentation block" };
}

function windowBlock(lines: string[], anchor: number, maxLines: number): BlockRange {
  const radius = Math.max(10, Math.floor(maxLines / 2));
  return {
    start: Math.max(0, anchor - radius),
    end: Math.min(lines.length - 1, anchor + radius),
    reason: "window",
  };
}

function detectMode(filePath: string, requested?: string): Mode {
  const mode = (requested ?? "auto").toLowerCase();
  if (mode === "markdown" || mode === "indentation" || mode === "window" || mode === "auto") return mode;
  throw new Error("mode must be one of: auto, markdown, indentation, window");
}

function chooseBlock(filePath: string, lines: string[], anchor: number, mode: Mode, maxLines: number): BlockRange {
  const ext = extname(filePath).toLowerCase();
  if (mode === "markdown" || (mode === "auto" && (ext === ".md" || ext === ".mdx"))) return markdownBlock(lines, anchor);
  if (mode === "window") return windowBlock(lines, anchor, maxLines);
  return indentationBlock(lines, anchor);
}

function formatLines(lines: string[], start: number, end: number): string {
  const width = String(end + 1).length;
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    out.push(`L${String(i + 1).padStart(width, " ")}: ${lines[i] ?? ""}`);
  }
  return out.join("\n");
}

function capRange(range: BlockRange, anchor: number, context: number, maxLines: number, totalLines: number): BlockRange & { truncated: boolean; originalStart: number; originalEnd: number } {
  const originalStart = Math.max(0, range.start - context);
  const originalEnd = Math.min(totalLines - 1, range.end + context);
  const length = originalEnd - originalStart + 1;
  if (length <= maxLines) return { ...range, start: originalStart, end: originalEnd, truncated: false, originalStart, originalEnd };

  const before = Math.floor(maxLines / 2);
  let start = Math.max(originalStart, anchor - before);
  let end = start + maxLines - 1;
  if (end > originalEnd) {
    end = originalEnd;
    start = Math.max(originalStart, end - maxLines + 1);
  }
  return { ...range, start, end, truncated: true, originalStart, originalEnd };
}

export default function readBlockExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read_block",
    label: "read_block",
    description:
      "Read the semantic block around a line or symbol: markdown section, brace block, or indentation block. Use this when read offset/limit would include too much or too little context.",
    promptSnippet: "Read the enclosing code or markdown block around a line or symbol",
    promptGuidelines: [
      "Use read_block after repo_map, grep, or find identifies a relevant symbol or line.",
      "Use read for exact ranges or full files; use read_block for enclosing functions/classes/sections.",
    ],
    parameters: readBlockSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.path);
      const mode = detectMode(filePath, params.mode);
      const maxLines = clamp(params.maxLines, 9, 1, 1000);
      const context = clamp(params.context, 0, 0, 20);
      const text = normalizeToLF(await readFile(filePath, "utf8"));
      const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
      const anchor = findAnchorLine(lines, params.symbol, params.line);
      const range = chooseBlock(filePath, lines, anchor.index, mode, maxLines);
      const capped = capRange(range, anchor.index, context, maxLines, lines.length);
      const header = [
        `File: ${params.path}`,
        `Anchor: L${anchor.index + 1} (${anchor.reason})`,
        `Block: L${range.start + 1}-L${range.end + 1} (${range.reason})`,
      ];
      if (capped.truncated) header.push(`Truncated: showing L${capped.start + 1}-L${capped.end + 1} of L${capped.originalStart + 1}-L${capped.originalEnd + 1}`);

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
        },
      };
    },
  });
}
