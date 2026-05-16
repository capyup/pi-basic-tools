import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderThinkingStepsLines, ThinkingStepsComponent } from "../extensions/thinking-steps/render.ts";
import { deriveThinkingSteps } from "../extensions/thinking-steps/parse.ts";
import {
  setCurrentThinkingScopeKey,
  setThinkingStepsMode,
  setActiveThinkingState,
  clearActiveThinkingState,
} from "../extensions/thinking-steps/state.ts";
import type { ThinkingSourceBlock, ThinkingThemeLike } from "../extensions/thinking-steps/types.ts";

const repoRoot = new URL("..", import.meta.url).pathname;

// A width-accurate theme returns the raw text so `visibleWidth` from
// pi-tui keeps reporting the real visible width.  Real Pi themes wrap text
// in ANSI escapes that are stripped before width math; a tagging stub would
// not be stripped and would push lines into bogus wraps.
const widthSafeTheme: ThinkingThemeLike = {
  fg(_color, text) {
    return text;
  },
  bold(text) {
    return text;
  },
};

// A tagging theme is only used for color-assertion tests where the input is
// short enough to fit on a single line so no width math is involved.
const taggingTheme: ThinkingThemeLike = {
  fg(color, text) {
    return `<${color}>${text}</${color}>`;
  },
  bold(text) {
    return `<b>${text}</b>`;
  },
};

function makeBlocks(...texts: string[]): ThinkingSourceBlock[] {
  return texts.map((text, index) => ({ contentIndex: index, text }));
}



const sampleBlocks = makeBlocks(
  "First I need to inspect the renderer implementation to see how it draws steps.",
  "Then I'll compare visibility toggling between the new and old renderer.",
  "Finally I'll verify that the refresh path still fires after a mode change.",
);

describe("thinking-steps parse + render", () => {
  test("derives one step per paragraph", () => {
    const steps = deriveThinkingSteps(sampleBlocks);
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps[0]?.summary.length).toBeGreaterThan(0);
  });

  test("is a passive renderer with no user-facing controls", async () => {
    const indexSource = await readFile(join(repoRoot, "extensions/thinking-steps/index.ts"), "utf8");

    // Adding a slash command or shortcut would expose user-facing controls
    // that we explicitly do not want for the renderer.
    expect(indexSource).not.toContain("registerCommand");
    expect(indexSource).not.toContain("registerShortcut");
    // We also do not want a persistence file, a status bar entry, or any
    // user notifications.
    expect(indexSource).not.toContain("setStatus");
    expect(indexSource).not.toContain("ui.notify");
    expect(indexSource).not.toContain("./persistence.ts");
    expect(indexSource).not.toContain("setHiddenThinkingLabel");
  });

  test("summary mode renders a Codex-style header + bullet rows", () => {
    const steps = deriveThinkingSteps(sampleBlocks);
    const lines = renderThinkingStepsLines(widthSafeTheme, 200, {
      mode: "summary",
      steps,
      isActive: false,
    });
    expect(lines.length).toBeGreaterThan(1);

    const header = lines[0] ?? "";
    expect(header).toContain("Thinking");
    expect(header).toMatch(/\d+ steps?/);

    // Each step's first line leads with the `• ` bullet marker used by the
    // pi-basic-tools compact tool grouping renderer.  Continuation lines may
    // start with the alignment indent we use to wrap long summaries.
    const stepRows = lines.slice(1).filter((line) => line.startsWith("\u2022 "));
    expect(stepRows.length).toBe(Math.min(steps.length, 5));

    for (const line of lines) {
      // Tree-branch connectors from the upstream renderer must not appear.
      expect(line).not.toContain("├─");
      expect(line).not.toContain("└─");
      // The banner row from the upstream renderer is gone.
      expect(line).not.toContain("Thinking Steps · Summary");
      expect(line).not.toContain("Thinking Steps · Expanded");
    }
  });

  test("collapsed mode renders a single Thinking · summary line with a pulse glyph when active", () => {
    const steps = deriveThinkingSteps([
      { contentIndex: 0, text: "Inspect renderer." },
    ]);
    const lines = renderThinkingStepsLines(widthSafeTheme, 200, {
      mode: "collapsed",
      steps,
      isActive: true,
      activeStepId: steps[0]?.id,
      nowMs: 0,
    });
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const text = lines[0] ?? "";
    expect(text.startsWith("Thinking \u00b7")).toBe(true);
    // The trailing pulse glyph belongs to the current animation frame, which
    // is one of `·`, `•`, `●`.
    expect(/[\u00b7\u2022\u25cf]\s*$/u.test(text)).toBe(true);
  });

  test("expanded mode emits | continuation connectors and a final \u2514 corner", () => {
    const steps = deriveThinkingSteps([
      { contentIndex: 0, text: "Inspect renderer implementation.\nWe need to read the file." },
      { contentIndex: 1, text: "Compare visibility toggling.\nLook at the old and new path." },
    ]);
    const lines = renderThinkingStepsLines(widthSafeTheme, 200, {
      mode: "expanded",
      steps,
      isActive: false,
    });
    expect(lines.some((line) => line.startsWith("  \u2502 "))).toBe(true);
    // The last body line uses the └ corner so the block visually closes.
    expect(lines.some((line) => line.startsWith("  \u2514 "))).toBe(true);
  });

  test("active thinking step uses warning marker + muted text + bold (no accent)", () => {
    const blocks = makeBlocks("Investigating the renderer right now to find the bug.");
    const steps = deriveThinkingSteps(blocks);
    const activeId = steps[0]!.id;
    const lines = renderThinkingStepsLines(taggingTheme, 200, {
      mode: "summary",
      steps,
      activeStepId: activeId,
      isActive: true,
    });
    const stepRow = lines.find((line) => line.includes("<warning>•</warning>")) ?? "";
    expect(stepRow).toMatch(/<warning>•<\/warning>/);
    expect(stepRow).toMatch(/<b><muted>[^<]*<\/muted><\/b>/);
    expect(stepRow).not.toMatch(/<accent>[^<]+<\/accent>/);
  });

  test("done Thinking summary header uses muted color (not accent)", () => {
    const steps = deriveThinkingSteps(sampleBlocks);
    const lines = renderThinkingStepsLines(taggingTheme, 200, {
      mode: "summary",
      steps,
      activeStepId: undefined,
      isActive: false,
    });
    expect(lines[0]).toContain("<muted>Thinking</muted>");
    expect(lines[0]).not.toContain("<accent>Thinking</accent>");
  });

  test("active Thinking summary header stays warning", () => {
    const steps = deriveThinkingSteps(sampleBlocks);
    const lines = renderThinkingStepsLines(taggingTheme, 200, {
      mode: "summary",
      steps,
      activeStepId: steps[0]!.id,
      isActive: true,
    });
    expect(lines[0]).toContain("<warning>Thinking</warning>");
  });

  test("done collapsed Thinking label uses muted (not accent)", () => {
    const steps = deriveThinkingSteps(sampleBlocks);
    const lines = renderThinkingStepsLines(taggingTheme, 200, {
      mode: "collapsed",
      steps,
      activeStepId: undefined,
      isActive: false,
      nowMs: 0,
    });
    expect(lines[0]).toContain("<muted>Thinking</muted>");
    expect(lines[0]).not.toContain("<accent>Thinking</accent>");
  });

  test("role glyphs render in muted color regardless of role", () => {
    const blocks = makeBlocks(
      "I need to compare the new and old renderers carefully.",
      "Let me inspect the existing implementation to understand it.",
      "I'll verify the fix works against a real capture.",
    );
    const steps = deriveThinkingSteps(blocks);
    const lines = renderThinkingStepsLines(taggingTheme, 200, {
      mode: "summary",
      steps,
      activeStepId: undefined,
      isActive: false,
    });
    const stepRows = lines.filter((line) => line.includes("<muted>•</muted>"));
    expect(stepRows.length).toBeGreaterThanOrEqual(3);
    const NON_MUTED_GLYPH = /<(warning|accent|success|error|mdLink)>[◫⌕↔✓✎◇!·]<\/(warning|accent|success|error|mdLink)>/;
    for (const row of stepRows) {
      expect(row).not.toMatch(NON_MUTED_GLYPH);
    }
  });

  test("uses warning color for the marker of the active step", () => {
    const steps = deriveThinkingSteps(sampleBlocks);
    const lines = renderThinkingStepsLines(taggingTheme, 200, {
      mode: "summary",
      steps,
      isActive: true,
      activeStepId: steps[0]?.id,
    });
    // The first row tagged with the warning marker is the active step.
    const activeRow = lines.find((line) => line.includes("<warning>\u2022</warning>"));
    expect(activeRow).toBeDefined();
  });

  test("ThinkingStepsComponent honours the scope mode", () => {
    const scopeKey = "test-scope";
    setCurrentThinkingScopeKey(scopeKey);
    setThinkingStepsMode("summary", scopeKey);
    clearActiveThinkingState(undefined, scopeKey);

    const component = new ThinkingStepsComponent(widthSafeTheme, 42, sampleBlocks, scopeKey);
    const summaryLines = component.render(200);
    expect(summaryLines.length).toBeGreaterThan(1);

    setThinkingStepsMode("collapsed", scopeKey);
    setActiveThinkingState({ active: true, messageTimestamp: 42, contentIndex: 0 }, scopeKey);
    component.invalidate();
    const collapsedLines = component.render(200);
    expect(collapsedLines.length).toBeGreaterThanOrEqual(1);
    expect(collapsedLines[0] ?? "").toMatch(/^Thinking \u00b7/);

    clearActiveThinkingState(undefined, scopeKey);
  });
});
