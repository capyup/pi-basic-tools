import { extname } from "node:path";

export type Mode = "auto" | "markdown" | "indentation" | "window";

export type BlockRange = {
  start: number;
  end: number;
  reason: string;
};

export type AnchorLine = {
  index: number;
  reason: string;
};

export const DECLARATION_PATTERNS = [
  /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)\b/,
  /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/,
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

export function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value ?? NaN)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function splitLines(text: string): string[] {
  const normalized = normalizeToLF(text);
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function indentOf(line: string): number {
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

export function declarationName(line: string): string | undefined {
  for (const pattern of DECLARATION_PATTERNS) {
    const match = line.match(pattern);
    if (!match) continue;
    return match[match.length - 1];
  }
  return undefined;
}

export function findAnchorLine(lines: string[], symbol?: string, line?: number): AnchorLine {
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

export function markdownBlock(lines: string[], anchor: number): BlockRange {
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

export function indentationBlock(lines: string[], anchor: number): BlockRange {
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

export function detectMode(filePath: string, requested?: string): Mode {
  const mode = (requested ?? "auto").toLowerCase();
  if (mode === "markdown" || mode === "indentation" || mode === "window" || mode === "auto") return mode;
  throw new Error("mode must be one of: auto, markdown, indentation, window");
}

export function chooseBlock(filePath: string, lines: string[], anchor: number, mode: Mode, maxLines: number): BlockRange {
  const ext = extname(filePath).toLowerCase();
  if (mode === "markdown" || (mode === "auto" && (ext === ".md" || ext === ".mdx"))) return markdownBlock(lines, anchor);
  if (mode === "window") return windowBlock(lines, anchor, maxLines);
  return indentationBlock(lines, anchor);
}

export function formatLines(lines: string[], start: number, end: number): string {
  const width = String(end + 1).length;
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    out.push(`L${String(i + 1).padStart(width, " ")}: ${lines[i] ?? ""}`);
  }
  return out.join("\n");
}

export function capRange(
  range: BlockRange,
  anchor: number,
  context: number,
  maxLines: number,
  totalLines: number,
): BlockRange & { truncated: boolean; originalStart: number; originalEnd: number } {
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
