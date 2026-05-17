import { describe, expect, test, beforeEach } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Container } from "@earendil-works/pi-tui";
import { createExtensionHost } from "./extension-host.ts";
import todoExtension from "../extensions/todo/index.ts";
import { __resetState, applyTaskMutation, getState, replaceState } from "../extensions/todo/state.ts";
import { replayFromBranch } from "../extensions/todo/replay.ts";
import { renderTodoCall, renderTodoResult } from "../extensions/todo/render.ts";
import { renderGroupedToolCall, resetBasicToolGroupingForTests } from "../extensions/basic-tool-grouping.ts";
import type { TaskMutationParams } from "../extensions/todo/types.ts";

const repoRoot = new URL("..", import.meta.url).pathname;

const plainTheme = {
  fg(_color: string, text: string): string {
    return text;
  },
  bold(text: string): string {
    return text;
  },
  strikethrough(text: string): string {
    return text;
  },
};

function renderComponent(component: { render: (width: number) => string[] } | undefined): string {
  if (!component) return "";
  if (component instanceof Container) return "";
  // Strip the trailing whitespace pi-tui Text components add to pad up to
  // the render width; tests assert on logical content, not padding.
  return component
    .render(80)
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n");
}

function newCtx(toolCallId: string, executionStarted = true) {
  return { toolCallId, executionStarted, expanded: false, invalidate() {} };
}

beforeEach(() => {
  __resetState();
  resetBasicToolGroupingForTests();
});

describe("todo reducer", () => {
  test("create + update + complete flow", () => {
    const c = applyTaskMutation(getState(), "create", { subject: "Write the report" });
    expect(c.op.kind).toBe("create");
    replaceState(c.state);
    expect(c.state.tasks).toHaveLength(1);
    expect(c.state.tasks[0]).toMatchObject({ id: 1, subject: "Write the report", status: "pending" });

    const u = applyTaskMutation(getState(), "update", { id: 1, status: "in_progress", activeForm: "writing the report" });
    expect(u.op.kind).toBe("update");
    if (u.op.kind === "update") {
      expect(u.op.fromStatus).toBe("pending");
      expect(u.op.toStatus).toBe("in_progress");
    }
    replaceState(u.state);
    expect(u.state.tasks[0].status).toBe("in_progress");
    expect(u.state.tasks[0].activeForm).toBe("writing the report");

    const d = applyTaskMutation(getState(), "update", { id: 1, status: "completed" });
    replaceState(d.state);
    expect(d.state.tasks[0].status).toBe("completed");
  });

  test("rejects illegal transitions", () => {
    const c = applyTaskMutation(getState(), "create", { subject: "Done early" });
    replaceState(c.state);
    const done = applyTaskMutation(getState(), "update", { id: 1, status: "completed" });
    replaceState(done.state);
    const reopen = applyTaskMutation(getState(), "update", { id: 1, status: "in_progress" });
    expect(reopen.op.kind).toBe("error");
  });

  test("delete tombstones without losing references", () => {
    replaceState(applyTaskMutation(getState(), "create", { subject: "A" }).state);
    replaceState(applyTaskMutation(getState(), "create", { subject: "B", blockedBy: [1] }).state);
    const del = applyTaskMutation(getState(), "delete", { id: 1 });
    expect(del.op.kind).toBe("delete");
    replaceState(del.state);
    // The tombstone stays in the array so historic blockedBy still resolves.
    expect(getState().tasks.find((t) => t.id === 1)?.status).toBe("deleted");
  });

  test("rejects update with no mutable fields", () => {
    replaceState(applyTaskMutation(getState(), "create", { subject: "Solo" }).state);
    const noop = applyTaskMutation(getState(), "update", { id: 1 });
    expect(noop.op.kind).toBe("error");
  });

  test("detects blockedBy cycles", () => {
    replaceState(applyTaskMutation(getState(), "create", { subject: "A" }).state);
    replaceState(applyTaskMutation(getState(), "create", { subject: "B", blockedBy: [1] }).state);
    // 1 already blocks B; making 1 also blocked by B would form a cycle.
    const cyc = applyTaskMutation(getState(), "update", { id: 1, addBlockedBy: [2] });
    expect(cyc.op.kind).toBe("error");
  });
});

describe("todo replay", () => {
  test("replayFromBranch reconstructs from the last todo result", () => {
    const branch = [
      { type: "message", message: { role: "user", text: "hi" } },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          details: { action: "create", params: { subject: "T1" }, tasks: [{ id: 1, subject: "T1", status: "pending" }], nextId: 2 },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          details: { action: "update", params: { id: 1, status: "in_progress" }, tasks: [{ id: 1, subject: "T1", status: "in_progress" }], nextId: 2 },
        },
      },
    ];
    const state = replayFromBranch({ sessionManager: { getBranch: () => branch } });
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]).toMatchObject({ id: 1, status: "in_progress" });
    expect(state.nextId).toBe(2);
  });

  test("replayFromBranch returns EMPTY_STATE when no todo result is found", () => {
    const state = replayFromBranch({ sessionManager: { getBranch: () => [] } });
    expect(state.tasks).toHaveLength(0);
    expect(state.nextId).toBe(1);
  });
});

describe("todo render — per-call single-line + grouping", () => {
  test("create renders as a single `Added <subject>` line", () => {
    const ctx = newCtx("c1");
    const call = renderComponent(renderTodoCall({ action: "create", subject: "Draft the README" }, plainTheme, ctx, getState()));
    // Running call (no result yet) uses the warning \u25d0 marker; once the
     // result arrives the marker shifts to \u2022 (see Task 5 hierarchy rules).
    expect(call.split("\n")).toEqual(["\u25d0 Added Draft the README"]);
  });

  test("update→in_progress renders as `Started <subject>` with status detail after result", () => {
    replaceState(applyTaskMutation(getState(), "create", { subject: "Plan the rewrite" }).state);
    const ctx = newCtx("u1");
    const args: TaskMutationParams & { action: "update" } = { action: "update", id: 1, status: "in_progress", activeForm: "planning" };
    const call = renderComponent(renderTodoCall(args, plainTheme, ctx, getState()));
    expect(call).toContain("Started Plan the rewrite");

    const result = renderComponent(renderTodoResult(
      args,
      { details: { action: "update", params: args, tasks: [{ id: 1, subject: "Plan the rewrite", status: "in_progress", activeForm: "planning" }], nextId: 2 } },
      { expanded: false, isPartial: false },
      plainTheme,
      ctx,
      getState(),
    ));
    expect(result).toBe(""); // result component is empty; the call component picks up the detail
    const callAfterResult = renderComponent(renderTodoCall(args, plainTheme, ctx, getState()));
    expect(callAfterResult).toContain("#1 \u2192 in progress");
  });

  test("consecutive todo calls collapse into `Tracked N todos` group header", () => {
    const ctx1 = newCtx("c1");
    const ctx2 = newCtx("c2");
    const ctx3 = newCtx("c3");

    renderComponent(renderTodoCall({ action: "create", subject: "Task one" }, plainTheme, ctx1, getState()));
    replaceState(applyTaskMutation(getState(), "create", { subject: "Task one" }).state);
    renderComponent(renderTodoCall({ action: "create", subject: "Task two" }, plainTheme, ctx2, getState()));
    replaceState(applyTaskMutation(getState(), "create", { subject: "Task two" }).state);
    const grouped = renderComponent(renderTodoCall({ action: "create", subject: "Task three" }, plainTheme, ctx3, getState()));

    expect(grouped).toContain("Tracked 3 todos");
    expect(grouped).toContain("Added Task one");
    expect(grouped).toContain("Added Task two");
    expect(grouped).toContain("Added Task three");

    // None of the upstream rpiv-todo per-call decoration leaks into the new
    // grouped layout (no `todo +` prefix, no `○ pending` status echo row,
    // no `├─/└─` tree connectors).
    expect(grouped).not.toContain("todo +");
    expect(grouped).not.toContain("\u25cb pending");
    expect(grouped).not.toContain("\u251c\u2500");
    expect(grouped).not.toContain("\u2514\u2500");
  });

  test("a todo call absorbed into a mixed tool group stops rendering as a standalone row", () => {
    replaceState(applyTaskMutation(getState(), "create", { subject: "Fix non-fast backup path" }).state);
    const ctx1 = newCtx("t1");
    const ctx2 = newCtx("b1");
    const args: TaskMutationParams & { action: "update" } = { action: "update", id: 1, status: "in_progress" };

    const first = renderTodoCall(args, plainTheme, ctx1, getState());
    expect(renderComponent(first)).toContain("Started Fix non-fast backup path");

    const grouped = renderComponent(renderGroupedToolCall("bash", { command: "ssh ubuntu@example 'set -e'" }, plainTheme, ctx2));
    expect(grouped).toContain("Used 2 tools");
    expect(grouped).toContain("Started Fix non-fast backup path");
    expect(grouped).toContain("Ran ssh ubuntu@example 'set -e'");

    expect(renderComponent(first)).toBe("");
  });

  test("standalone render (no grouping context) emits the verb inline", () => {
    const standalone = renderComponent(renderTodoCall({ action: "create", subject: "Solo task" }, plainTheme, {}, getState()));
    expect(standalone).toBe("Added Solo task");
  });

  test("standalone fallback renders verb/subject in muted (not accent)", () => {
    const tagging = {
      fg(color: string, text: string) { return `<${color}>${text}</${color}>`; },
      bold(text: string) { return text; },
    } as any;

    const callOutput = renderTodoCall(
      { action: "create", subject: "Draft the README" } as any,
      tagging,
      undefined,
      getState(),
    );
    const callText = renderComponent(callOutput);
    expect(callText).toContain("<muted>");
    expect(callText).not.toContain("<accent>");

    const resultOutput = renderTodoResult(
      { action: "create", subject: "Draft the README" } as any,
      { content: [{ type: "text", text: "" }], details: { action: "create", params: { subject: "Draft the README" }, tasks: [{ id: 1, subject: "Draft the README", status: "pending" }], nextId: 2 } } as any,
      { expanded: false, isPartial: false } as any,
      tagging,
      undefined,
      getState(),
    );
    const resultText = renderComponent(resultOutput);
    expect(resultText).toContain("<muted>");
    expect(resultText).not.toContain("<accent>");
  });
});

describe("todo extension wiring", () => {
  test("registers the `todo` tool with the upstream-compatible schema", async () => {
    const host = createExtensionHost();
    todoExtension(host.api as any);
    const tool = host.getTool("todo");
    expect(tool.label).toBe("Todo");
    expect(tool.description).toContain("pending");
    expect(tool.description).toContain("in_progress");
    expect(tool.parameters).toBeDefined();
    // Schema must accept all 6 actions for replay compatibility.
    expect(JSON.stringify(tool.parameters)).toContain("create");
    expect(JSON.stringify(tool.parameters)).toContain("clear");
  });

  test("execute() commits state and returns the upstream-compatible envelope", async () => {
    const host = createExtensionHost();
    todoExtension(host.api as any);
    const created = await host.runTool("todo", { action: "create", subject: "T" });
    expect(created.details.action).toBe("create");
    expect(created.details.tasks[0]).toMatchObject({ id: 1, subject: "T", status: "pending" });
    expect(created.content[0].text).toBe("Created #1: T (pending)");
  });

  test("is a passive surface — no /todos slash command, no rpiv-i18n bridge", async () => {
    const indexSource = await readFile(join(repoRoot, "extensions/todo/index.ts"), "utf8");
    expect(indexSource).not.toContain("registerCommand");
    expect(indexSource).not.toContain("registerShortcut");
    // Upstream rpiv-todo registered a `/todos` slash command that opened
    // a list overlay; the fork drops it. Match the command-registration
    // shape rather than the literal string so this file's own JSDoc can
    // still mention `/todos` when explaining what we removed.
    expect(indexSource).not.toMatch(/registerCommand\([^)]*todos/);
    // No actual import or runtime reference to the upstream i18n bridge.
    // The literal `rpiv-i18n` may still appear in JSDoc explaining what
    // the fork dropped, so match the import shape instead.
    expect(indexSource).not.toMatch(/from\s+["'][^"']*rpiv-i18n/);
    expect(indexSource).not.toMatch(/require\(["'][^"']*rpiv-i18n/);
  });

  test("injects a todo discipline section into each agent turn", async () => {
    const host = createExtensionHost();
    todoExtension(host.api as any);
    const handlers = host.handlers.get("before_agent_start") ?? [];
    expect(handlers.length).toBe(1);

    const result = await (handlers[0] as any)({});
    expect(result.systemPrompt).toContain("Todo discipline:");
    expect(result.systemPrompt).toContain("3+ steps");
    expect(result.systemPrompt).toContain("multi-task list");
    expect(result.systemPrompt).toContain("not yet captured");
    expect(result.systemPrompt).toContain("Skip it for single trivial requests");
    expect(result.systemPrompt).toContain("purely conversational");
    expect(result.systemPrompt).toContain("mark it `in_progress`");
    expect(result.systemPrompt).toContain("mark it `completed`");
    expect(result.systemPrompt).toContain("never batch completions");
    expect(result.systemPrompt).toContain("Exactly one task is `in_progress` at a time");
  });
});
