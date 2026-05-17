import { renderThinkingStepsLines, ThinkingStepsComponent, clearThinkingMergeRegistry } from "../extensions/thinking-steps/render.ts";
import { deriveThinkingSteps } from "../extensions/thinking-steps/parse.ts";
import { setCurrentThinkingScopeKey, setThinkingStepsMode, clearActiveThinkingState } from "../extensions/thinking-steps/state.ts";
import type { ThinkingSourceBlock, ThinkingThemeLike } from "../extensions/thinking-steps/types.ts";

const theme: ThinkingThemeLike = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function makeBlocks(...texts: string[]): ThinkingSourceBlock[] {
  return texts.map((text, index) => ({ contentIndex: index, text }));
}

function show(title: string, lines: string[]) {
  console.log(`\n=== ${title} ===`);
  for (const line of lines) console.log(line);
}

const sample = makeBlocks(
  "First I need to inspect the renderer implementation to see how it draws steps.",
  "Then I'll compare visibility toggling between the new and old renderer.",
  "Finally I'll verify that the refresh path still fires after a mode change.",
);

const steps3 = deriveThinkingSteps(sample);
show("Summary mode · 3 thoughts (done)", renderThinkingStepsLines(theme, 80, {
  mode: "summary",
  steps: steps3,
  isActive: false,
}));

show("Summary mode · 3 thoughts (active on step 1)", renderThinkingStepsLines(theme, 80, {
  mode: "summary",
  steps: steps3,
  activeStepId: steps3[0]?.id,
  isActive: true,
}));

const single = deriveThinkingSteps(makeBlocks("Inspect the renderer."));
show("Summary mode · single step (count omitted)", renderThinkingStepsLines(theme, 80, {
  mode: "summary",
  steps: single,
  isActive: false,
}));

const long = makeBlocks(
  "Inspect server config.",
  "Search the redis cluster for stale keys.",
  "Compare new vs old auth flow.",
  "Verify integration tests pass.",
  "Write the migration script.",
  "Plan the rollout sequence.",
  "Inspect logs after deploy.",
);
const stepsLong = deriveThinkingSteps(long);
show(`Summary mode · ${stepsLong.length} thoughts → shows latest 5`, renderThinkingStepsLines(theme, 80, {
  mode: "summary",
  steps: stepsLong,
  isActive: false,
}));

show("Collapsed mode · active pulse", renderThinkingStepsLines(theme, 80, {
  mode: "collapsed",
  steps: single,
  activeStepId: single[0]?.id,
  isActive: true,
  nowMs: 0,
}));

show("Expanded mode · 2 steps with body", renderThinkingStepsLines(theme, 80, {
  mode: "expanded",
  steps: deriveThinkingSteps(makeBlocks(
    "Inspect renderer implementation.\nWe need to read the file.",
    "Compare visibility toggling.\nLook at the old and new path.",
  )),
  isActive: false,
}));

// Merge probe: two ThinkingStepsComponent instances with the same messageTimestamp
clearThinkingMergeRegistry();
setCurrentThinkingScopeKey("probe");
setThinkingStepsMode("summary", "probe");
clearActiveThinkingState(undefined, "probe");
const ts = 9999;
const c1 = new ThinkingStepsComponent(theme, ts, [{ contentIndex: 0, text: "Inspect Users/lucas." }], "probe");
const c2 = new ThinkingStepsComponent(theme, ts, [{ contentIndex: 2, text: "Verify file size and pages." }], "probe");
console.log(`\n=== Same-message merge · c1 renders both, c2 renders [] ===`);
console.log("--- c1 ---");
for (const line of c1.render(80)) console.log(line);
console.log("--- c2 ---");
const c2Lines = c2.render(80);
console.log(c2Lines.length === 0 ? "(empty — merged into c1)" : c2Lines.join("\n"));
