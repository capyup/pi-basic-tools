/**
 * pi-basic-tools fork of @juicesharp/rpiv-todo (MIT, juicesharp).
 *
 * Combined state module: live state cell, pure reducer, selectors,
 * transition invariants, and cycle/inverse-edge helpers for the task-graph.
 * Upstream split these across `state/state.ts`, `state-reducer.ts`,
 * `selectors.ts`, `invariants.ts`, `task-graph.ts`, `store.ts`; merging
 * them keeps the fork compact since pi-basic-tools doesn't need the
 * deeper-import seams that upstream's monorepo callers relied on.
 */

import type { Task, TaskAction, TaskMutationParams, TaskStatus } from "./types.ts";

export interface TaskState {
	tasks: Task[];
	nextId: number;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

// ---------------------------------------------------------------------------
// Live state cell — single mutation seam.
// ---------------------------------------------------------------------------

let state: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };

export function getState(): TaskState {
	return state;
}

export function getTodos(): readonly Task[] {
	return state.tasks;
}

export function getNextId(): number {
	return state.nextId;
}

export function replaceState(next: TaskState): void {
	state = next;
}

export function commitState(next: TaskState): void {
	state = next;
}

export function __resetState(): void {
	state = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

// ---------------------------------------------------------------------------
// Transition invariants.
// ---------------------------------------------------------------------------

export const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
	pending: new Set(["in_progress", "completed", "deleted"]),
	in_progress: new Set(["pending", "completed", "deleted"]),
	completed: new Set(["deleted"]),
	deleted: new Set(),
};

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].has(to);
}

// ---------------------------------------------------------------------------
// Task-graph helpers.
// ---------------------------------------------------------------------------

export function detectCycle(taskList: readonly Task[], taskId: number, newBlockedBy: readonly number[]): boolean {
	const edges = new Map<number, number[]>();
	for (const t of taskList) {
		if (t.id === taskId) {
			const merged = new Set([...(t.blockedBy ?? []), ...newBlockedBy]);
			edges.set(t.id, [...merged]);
		} else {
			edges.set(t.id, t.blockedBy ? [...t.blockedBy] : []);
		}
	}
	const visiting = new Set<number>();
	const visited = new Set<number>();
	const hasCycleFrom = (node: number): boolean => {
		if (visiting.has(node)) return true;
		if (visited.has(node)) return false;
		visiting.add(node);
		for (const nb of edges.get(node) ?? []) {
			if (hasCycleFrom(nb)) return true;
		}
		visiting.delete(node);
		visited.add(node);
		return false;
	};
	for (const node of edges.keys()) {
		if (hasCycleFrom(node)) return true;
	}
	return false;
}

export function deriveBlocks(taskList: readonly Task[]): Map<number, number[]> {
	const blocks = new Map<number, number[]>();
	for (const t of taskList) {
		for (const dep of t.blockedBy ?? []) {
			const arr = blocks.get(dep) ?? [];
			arr.push(t.id);
			blocks.set(dep, arr);
		}
	}
	return blocks;
}

// ---------------------------------------------------------------------------
// Selectors — pure of `TaskState`.
// ---------------------------------------------------------------------------

export function selectVisibleTasks(state: TaskState): readonly Task[] {
	return state.tasks.filter((t) => t.status !== "deleted");
}

export interface TasksByStatus {
	pending: readonly Task[];
	inProgress: readonly Task[];
	completed: readonly Task[];
}

export function selectTasksByStatus(state: TaskState): TasksByStatus {
	const visible = selectVisibleTasks(state);
	return {
		pending: visible.filter((t) => t.status === "pending"),
		inProgress: visible.filter((t) => t.status === "in_progress"),
		completed: visible.filter((t) => t.status === "completed"),
	};
}

export interface TodoCounts {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
}

export function selectTodoCounts(state: TaskState): TodoCounts {
	const groups = selectTasksByStatus(state);
	return {
		total: groups.pending.length + groups.inProgress.length + groups.completed.length,
		pending: groups.pending.length,
		inProgress: groups.inProgress.length,
		completed: groups.completed.length,
	};
}

export function selectShowTaskIds(state: TaskState): boolean {
	return selectVisibleTasks(state).some((t) => t.blockedBy && t.blockedBy.length > 0);
}

export function selectTaskSubjectById(state: TaskState, id: number): string | undefined {
	return state.tasks.find((t) => t.id === id)?.subject;
}

export function selectHasActive(state: TaskState): boolean {
	return selectVisibleTasks(state).some((t) => t.status === "in_progress" || t.status === "pending");
}

export interface OverlayLayout {
	visible: readonly Task[];
	hiddenCompleted: number;
	truncatedTail: number;
}

/**
 * Overlay layout decision. Drop completed tasks first on overflow, then
 * truncate the non-completed tail. `budget` is the body-slot count (caller
 * passes `MAX_WIDGET_LINES - 1` to reserve the heading row); on overflow
 * the selector reserves one more slot internally for the summary row.
 */
export function selectOverlayLayout(state: TaskState, budget: number): OverlayLayout {
	const all = selectVisibleTasks(state);
	if (all.length <= budget) {
		return { visible: all, hiddenCompleted: 0, truncatedTail: 0 };
	}
	const innerBudget = budget - 1;
	const nonCompleted = all.filter((t) => t.status !== "completed");
	const totalCompleted = all.length - nonCompleted.length;
	if (nonCompleted.length <= innerBudget) {
		const kept = new Set<Task>(nonCompleted);
		for (const t of all) {
			if (kept.size >= innerBudget) break;
			if (t.status === "completed") kept.add(t);
		}
		const visible = all.filter((t) => kept.has(t));
		const shownCompleted = visible.filter((t) => t.status === "completed").length;
		return { visible, hiddenCompleted: totalCompleted - shownCompleted, truncatedTail: 0 };
	}
	const visible = nonCompleted.slice(0, innerBudget);
	const truncatedTail = nonCompleted.length - innerBudget;
	return { visible, hiddenCompleted: totalCompleted, truncatedTail };
}

// ---------------------------------------------------------------------------
// Reducer outcomes.
// ---------------------------------------------------------------------------

export type Op =
	| { kind: "create"; taskId: number }
	| { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus }
	| { kind: "delete"; id: number; subject: string }
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

/**
 * Pure reducer: (state, action, params) → (state, op). Mirrors upstream's
 * `applyTaskMutation` byte-for-byte (minus the formatting which lives in
 * `render.ts`) so that replay of sessions persisted under rpiv-todo
 * reconstructs identical state.
 */
export function applyTaskMutation(state: TaskState, action: TaskAction, params: TaskMutationParams): ApplyResult {
	switch (action) {
		case "create": {
			if (!params.subject?.trim()) {
				return errorResult(state, "subject required for create");
			}
			if (params.blockedBy?.length) {
				for (const dep of params.blockedBy) {
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `blockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `blockedBy: #${dep} is deleted`);
				}
			}
			const newTask: Task = {
				id: state.nextId,
				subject: params.subject,
				status: "pending",
			};
			if (params.description) newTask.description = params.description;
			if (params.activeForm) newTask.activeForm = params.activeForm;
			if (params.blockedBy?.length) newTask.blockedBy = [...params.blockedBy];
			if (params.owner) newTask.owner = params.owner;
			if (params.metadata) newTask.metadata = { ...params.metadata };

			const newTasks = [...state.tasks, newTask];
			return {
				state: { tasks: newTasks, nextId: state.nextId + 1 },
				op: { kind: "create", taskId: newTask.id },
			};
		}

		case "update": {
			if (params.id === undefined) return errorResult(state, "id required for update");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];

			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				(params.addBlockedBy && params.addBlockedBy.length > 0) ||
				(params.removeBlockedBy && params.removeBlockedBy.length > 0);
			if (!hasMutation) return errorResult(state, "update requires at least one mutable field");

			let newStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) {
					return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
				}
				newStatus = params.status;
			}

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const toRemove = new Set(params.removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			if (params.addBlockedBy?.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `addBlockedBy: #${dep} is deleted`);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) {
					return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
				}
			}

			let newMetadata = current.metadata;
			if (params.metadata !== undefined) {
				const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = { ...current, status: newStatus };
			if (params.subject !== undefined) updated.subject = params.subject;
			if (params.description !== undefined) updated.description = params.description;
			if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
			if (params.owner !== undefined) updated.owner = params.owner;
			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;
			if (newMetadata === undefined) delete updated.metadata;
			else updated.metadata = newMetadata;

			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "update", id: updated.id, fromStatus: current.status, toStatus: newStatus },
			};
		}

		case "list": {
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					...(params.status !== undefined ? { statusFilter: params.status } : {}),
				},
			};
		}

		case "get": {
			if (params.id === undefined) return errorResult(state, "id required for get");
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}

		case "delete": {
			if (params.id === undefined) return errorResult(state, "id required for delete");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];
			if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
			const updated: Task = { ...current, status: "deleted" };
			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "delete", id: updated.id, subject: updated.subject },
			};
		}

		case "clear": {
			const count = state.tasks.length;
			return {
				state: { tasks: [], nextId: 1 },
				op: { kind: "clear", count },
			};
		}
	}
}
