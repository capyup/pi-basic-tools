/**
 * pi-basic-tools fork of @juicesharp/rpiv-todo (MIT, juicesharp).
 *
 * Persistent todo overlay widget mounted above the editor.
 *
 * Visual language is rewritten to match the rest of pi-basic-tools: a
 * compact header line (`Todos N/M` styled like `Used N tools` /
 * `Thinking N steps`) followed by `• <glyph> <subject>` rows. The original
 * `├─/└─` tree-branch connectors are dropped because we use `•` as the row
 * marker (consistent with basic-tool-grouping); the optional `│` and `└`
 * connectors are reserved for continuation/elaboration on a single step,
 * exactly like thinking-steps.
 *
 * Lifecycle is preserved from upstream: register-once via setWidget's
 * factory form, register/invalidate idempotent on session_start, auto-hide
 * when the visible task set is empty, collapse-not-scroll at 12 lines, and
 * the "completed tasks remain until the next agent_start" affordance.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import {
  selectHasActive,
  selectOverlayLayout,
  selectShowTaskIds,
  selectTodoCounts,
  getState,
} from "./state.ts";
import { formatStatusLabel, type Task, type TaskStatus } from "./types.ts";

const WIDGET_KEY = "pi-basic-tools-todos";
const MAX_WIDGET_LINES = 12;

/**
 * Status glyph used in overlay rows. Differs from the upstream renderer's
 * STATUS_GLYPH table only in that the overlay uses `\u2713` for completed
 * (the success check, same as `Used N tools` finished rows) and `\u2717`
 * for deleted in the error palette — the overlay never actually renders a
 * deleted row but the table stays exhaustive.
 */
function overlayStatusGlyph(status: TaskStatus, theme: Theme): string {
  switch (status) {
    case "pending":
      return theme.fg("muted", "\u25cb");
    case "in_progress":
      return theme.fg("warning", "\u25d0");
    case "completed":
      return theme.fg("success", "\u2713");
    case "deleted":
      return theme.fg("error", "\u2717");
  }
}

function formatOverlayTaskLine(t: Task, theme: Theme, showId: boolean): string {
  const glyph = overlayStatusGlyph(t.status, theme);
  const subjectColor = t.status === "completed" || t.status === "deleted" ? "muted" : "text";
  let subject = theme.fg(subjectColor, t.subject);
  if (t.status === "completed" || t.status === "deleted") {
    subject = theme.strikethrough(subject);
  }
  let line = glyph;
  if (showId) line += ` ${theme.fg("accent", `#${t.id}`)}`;
  line += ` ${subject}`;
  if (t.status === "in_progress" && t.activeForm) {
    line += ` ${theme.fg("muted", `\u00b7 ${t.activeForm}`)}`;
  }
  if (t.blockedBy && t.blockedBy.length > 0) {
    line += ` ${theme.fg("muted", `\u26d3 ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
  }
  return line;
}

export class TodoOverlay {
  private uiCtx: ExtensionUIContext | undefined;
  private widgetRegistered = false;
  private tui: TUI | undefined;
  private completedTaskIdsPendingHide = new Set<number>();
  private hiddenCompletedTaskIds = new Set<number>();
  private lastNextId: number | undefined;

  setUICtx(ctx: ExtensionUIContext): void {
    // Identity-compare so repeat session_start handlers are idempotent.
    // On identity change (e.g. after /reload) invalidate so update()
    // re-registers the widget against the fresh UI context.
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
    }
  }

  update(): void {
    if (!this.uiCtx) return;
    const snapshot = this.getSnapshot();
    const visible = this.selectOverlayTasks(snapshot);

    if (visible.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget(WIDGET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      return;
    }

    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          return {
            render: (width: number) => this.renderWidget(theme, width),
            invalidate: () => {
              this.widgetRegistered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  resetCompletedDisplayState(): void {
    this.completedTaskIdsPendingHide.clear();
    this.hiddenCompletedTaskIds.clear();
    this.lastNextId = undefined;
  }

  hideCompletedTasksFromPreviousTurn(): void {
    if (this.completedTaskIdsPendingHide.size === 0) return;
    for (const taskId of this.completedTaskIdsPendingHide) {
      this.hiddenCompletedTaskIds.add(taskId);
    }
    this.completedTaskIdsPendingHide.clear();
    this.tui?.requestRender();
  }

  private getSnapshot() {
    const state = getState();
    // After /clear or branch fork, nextId may regress; reset so completed
    // tasks from the previous timeline don't stay hidden in the new one.
    if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
      this.resetCompletedDisplayState();
    }
    this.lastNextId = state.nextId;
    const completedTaskIds = new Set(
      state.tasks.filter((task) => task.status === "completed").map((task) => task.id),
    );
    for (const taskId of this.completedTaskIdsPendingHide) {
      if (!completedTaskIds.has(taskId)) this.completedTaskIdsPendingHide.delete(taskId);
    }
    for (const taskId of this.hiddenCompletedTaskIds) {
      if (!completedTaskIds.has(taskId)) this.hiddenCompletedTaskIds.delete(taskId);
    }
    return { tasks: [...state.tasks], nextId: state.nextId };
  }

  private selectOverlayTasks(snapshot: ReturnType<TodoOverlay["getSnapshot"]>) {
    return snapshot.tasks.filter((task) => task.status !== "deleted" && !this.shouldHideCompletedTask(task));
  }

  private shouldHideCompletedTask(task: Task): boolean {
    return task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id);
  }

  /**
   * Render the widget body. Layout shape:
   *
   *   Todos 2/5
   *   • ○ first pending
   *   • ◐ second in-progress · activeForm
   *   • ○ third pending
   *   • ✓ fourth completed
   *   • +1 more (1 completed)              ← overflow summary, only if collapsed
   *
   * Heading color tracks whether anything is active (accent if so, muted
   * otherwise) — mirrors `Used N tools` adjusting between accent and muted
   * across the running/done lifecycle.
   */
  private renderWidget(theme: Theme, width: number): string[] {
    const snapshot = this.getSnapshot();
    const overlayTasks = this.selectOverlayTasks(snapshot);
    if (overlayTasks.length === 0) return [];

    const overlayState = { tasks: overlayTasks, nextId: snapshot.nextId };
    const truncate = (line: string): string => truncateToWidth(line, width, "\u2026");
    const counts = selectTodoCounts(overlayState);
    const hasActive = selectHasActive(overlayState);
    const showIds = selectShowTaskIds(overlayState);

    const headingColor = hasActive ? "accent" : "muted";
    const headingText = `Todos ${counts.completed}/${counts.total}`;
    const heading = truncate(theme.fg(headingColor, headingText));

    const lines: string[] = [heading];
    const layout = selectOverlayLayout(overlayState, MAX_WIDGET_LINES - 1);
    for (const task of layout.visible) {
      lines.push(truncate(`${theme.fg("muted", "\u2022")} ${formatOverlayTaskLine(task, theme, showIds)}`));
    }

    // Track which completed tasks were just shown so the next agent_start
    // can fade them out — preserves upstream's "completed tasks stay
    // visible until the next agent response" affordance.
    const newlyDisplayedCompletedTaskIds = overlayTasks
      .filter(
        (task) =>
          task.status === "completed" &&
          !this.completedTaskIdsPendingHide.has(task.id) &&
          !this.hiddenCompletedTaskIds.has(task.id),
      )
      .map((task) => task.id);
    for (const taskId of newlyDisplayedCompletedTaskIds) {
      this.completedTaskIdsPendingHide.add(taskId);
    }

    if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
      return lines;
    }

    const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
    const overflowParts: string[] = [];
    if (layout.hiddenCompleted > 0) overflowParts.push(`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`);
    if (layout.truncatedTail > 0) overflowParts.push(`${layout.truncatedTail} ${formatStatusLabel("pending")}`);
    const summary =
      overflowParts.length > 0 ? `+${totalHidden} more (${overflowParts.join(", ")})` : `+${totalHidden} more`;
    lines.push(truncate(`${theme.fg("muted", "\u2022")} ${theme.fg("muted", summary)}`));
    return lines;
  }

  dispose(): void {
    if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
    this.resetCompletedDisplayState();
  }
}
