/**
 * pi-basic-tools fork of @juicesharp/rpiv-todo (MIT, juicesharp).
 *
 * Types + TypeBox schema for the `todo` tool. The schema is byte-equivalent
 * to upstream so the LLM-facing parameter surface is unchanged and any
 * session that previously used rpiv-todo continues to replay correctly.
 *
 * User-facing strings (ERR_REQUIRES_INTERACTIVE, MSG_NO_TODOS) are dropped
 * because this fork removes the /todos slash command. Locale-aware status
 * labels are dropped because pi-basic-tools is English-only.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "@sinclair/typebox";

/**
 * Tool name "todo" is the persistence key for branch replay (filtering on
 * `toolResult.toolName === "todo"`). Renaming this would break replay of
 * sessions persisted under upstream rpiv-todo, so keep it pinned even if we
 * later add scoped variants.
 */
export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Persistence + replay snapshot. Every successful `todo` tool call returns
 * this shape under `details`; `replay.ts` reads the latest one from the
 * branch to reconstruct module state. Field order and field names are
 * pinned by cross-version replay compatibility.
 */
export interface TaskDetails {
	action: TaskAction;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
	error?: string;
}

export interface TaskMutationParams {
	[key: string]: unknown;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	id?: number;
	includeDeleted?: boolean;
}

export const TodoParamsSchema = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
	subject: Type.Optional(Type.String({ description: "Task subject line (required for create)" })),
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
		}),
	),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description: "Target status (update) or list filter (list)",
		}),
	),
	blockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Initial blockedBy ids (create only)",
		}),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to add to blockedBy (update only, additive merge)",
		}),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to remove from blockedBy (update only, additive merge)",
		}),
	),
	owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Arbitrary metadata; pass null value for a key to delete that key on update",
		}),
	),
	id: Type.Optional(
		Type.Number({
			description: "Task id (required for update, get, delete)",
		}),
	),
	includeDeleted: Type.Optional(
		Type.Boolean({
			description: "If true, list action returns deleted (tombstoned) tasks as well. Default: false.",
		}),
	),
});

export type TodoParams = Static<typeof TodoParamsSchema>;

/** Status label used by overlay heading + per-call render. English-only. */
export function formatStatusLabel(status: TaskStatus): string {
	switch (status) {
		case "pending":
			return "pending";
		case "in_progress":
			return "in progress";
		case "completed":
			return "completed";
		case "deleted":
			return "deleted";
	}
}
