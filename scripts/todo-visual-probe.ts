/**
 * Visual probe — prints the actual grouped + standalone + overlay output
 * for a representative todo sequence. Run with:
 *   bun run scripts/todo-visual-probe.ts
 */

import { __resetState, applyTaskMutation, getState, replaceState, selectVisibleTasks } from "../extensions/todo/state.ts";
import { renderTodoCall, renderTodoResult } from "../extensions/todo/render.ts";
import { resetBasicToolGroupingForTests } from "../extensions/basic-tool-grouping.ts";

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, "");

const plainTheme = {
  fg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  strikethrough: (t: string) => t,
};

function render(component: any, width = 80): string {
  if (!component || typeof component.render !== "function") return "";
  return component
    .render(width)
    .map((line: string) => strip(line.replace(/\s+$/u, "")))
    .join("\n");
}

function ctx(toolCallId: string, expanded = false) {
  return { toolCallId, executionStarted: true, expanded, invalidate() {} };
}

function envelope(action: string, params: any) {
  return {
    details: { action, params, tasks: getState().tasks, nextId: getState().nextId },
    isError: false,
  };
}

// --------------------------------------------------------------------
// Sequence: agent plans 3 tasks, then starts and finishes #1, then starts #2.
// --------------------------------------------------------------------

__resetState();
resetBasicToolGroupingForTests();

const calls = [
  { action: "create", subject: "Read upstream rpiv-todo source" },
  { action: "create", subject: "Sketch a compact action-block render" },
  { action: "create", subject: "Restyle the above-editor overlay" },
  { action: "update", id: 1, status: "in_progress", activeForm: "reading upstream" },
  { action: "update", id: 1, status: "completed" },
  { action: "update", id: 2, status: "in_progress", activeForm: "sketching render" },
];

let last: any;
for (let i = 0; i < calls.length; i++) {
  const args = calls[i] as any;
  const callCtx = ctx(`c${i + 1}`);
  last = renderTodoCall(args, plainTheme, callCtx, getState());
  const reduced = applyTaskMutation(getState(), args.action, args);
  replaceState(reduced.state);
  renderTodoResult(args, envelope(args.action, args), { expanded: false, isPartial: false }, plainTheme, callCtx, getState());
}

console.log("=== Per-call grouping (5+ consecutive todo calls) ===");
console.log(render(last, 80));

// --------------------------------------------------------------------
// Standalone (no grouping context) — what e.g. a transcript paste renders as.
// --------------------------------------------------------------------

const single = renderTodoCall({ action: "create", subject: "Standalone task" } as any, plainTheme, {}, getState());
console.log("\n=== Standalone create (no grouping context) ===");
console.log(render(single, 80));

// --------------------------------------------------------------------
// Overlay — what the user actually sees above the editor.
// --------------------------------------------------------------------

const { TodoOverlay } = await import("../extensions/todo/overlay.ts");
const overlay = new TodoOverlay() as any;
const widgets: Array<[string, any]> = [];
overlay.setUICtx({
  setWidget(key: string, payload: any) {
    widgets.push([key, payload]);
  },
});
overlay.update();

if (widgets.length) {
  const [, factory] = widgets[widgets.length - 1];
  if (typeof factory === "function") {
    const widget = factory({ requestRender() {} }, plainTheme);
    const lines = widget.render(80).map((s: string) => strip(s.replace(/\s+$/u, "")));
    console.log("\n=== Above-editor overlay (after sequence) ===");
    for (const line of lines) console.log(line);
  } else {
    console.log("\n(overlay payload was not a factory)");
  }
} else {
  console.log("\n(no overlay registered — visible task set was empty)");
}

console.log(`\nState: ${selectVisibleTasks(getState()).length} visible tasks`);
