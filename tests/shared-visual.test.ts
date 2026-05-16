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
    const roles: VisualRole[] = [
      "inspect",
      "search",
      "compare",
      "write",
      "run",
      "network",
      "plan",
      "ask",
      "verify",
      "default",
    ];
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
      width: 200,
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
      width: 200,
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
    const longText =
      "ocr-large-pdf.sh /Users/lucas/Dropbox/Lectures/MICRO.101.微观经济学基础/参考文档/CCER历年试题(1996-2013)与答案(1996-2012).pdf";
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
