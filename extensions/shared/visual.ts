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
  return {
    glyph: ROLE_GLYPHS[input.role] ?? ROLE_GLYPHS.default,
    color: ROLE_COLORS[input.role] ?? ROLE_COLORS.default,
  };
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
