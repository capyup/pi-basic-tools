import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Pi's ToolExecutionComponent unconditionally adds `new Spacer(1)` as its
// first child in its constructor (see
// node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js:42).
// When basic-tool-grouping marks earlier tools in a group as hidden, those
// tools' inner renderer components return `[]`, but the wrapping
// ToolExecutionComponent still renders its Spacer line, producing one stacked
// blank line per hidden tool. With N grouped tools the user sees N-1 blank
// lines before the visible group block.
//
// We patch `ToolExecutionComponent.prototype.render` so that when every
// rendered line is visually empty (no characters besides whitespace and ANSI
// escape sequences) the wrapping component disappears entirely. Tools that
// produce real content still render normally — only the Spacer-only case is
// suppressed.

const PI_TOOL_EXECUTION_MODULE = "dist/modes/interactive/components/tool-execution.js";
const PATCH_STATE_KEY = Symbol.for("pi-basic-tools.tool-execution-patch.state");
// Strip CSI / SGR ANSI escape sequences so colored-but-blank lines are still
// detected as visually empty.
const ANSI_RE = /\[[0-9;?]*[A-Za-z]/g;

interface ToolExecutionPrototype {
  render(width: number): string[];
}

interface ToolExecutionPatchState {
  refCount: number;
  cleanup?: () => void;
  installPromise?: Promise<() => void>;
}

function getPatchState(): ToolExecutionPatchState {
  const existing = (globalThis as Record<PropertyKey, unknown>)[PATCH_STATE_KEY];
  if (existing && typeof existing === "object") return existing as ToolExecutionPatchState;
  const created: ToolExecutionPatchState = { refCount: 0 };
  (globalThis as Record<PropertyKey, unknown>)[PATCH_STATE_KEY] = created;
  return created;
}

export function isVisuallyEmptyLine(line: string): boolean {
  return line.replace(ANSI_RE, "").trim().length === 0;
}

export function shouldHideRenderedLines(lines: readonly string[]): boolean {
  if (lines.length === 0) return false;
  for (const line of lines) {
    if (!isVisuallyEmptyLine(line)) return false;
  }
  return true;
}

function assertPatchableToolExecutionComponent(value: unknown): { prototype: ToolExecutionPrototype } {
  if (!value || (typeof value !== "function" && typeof value !== "object")) {
    throw new Error("ToolExecution patch failed: ToolExecutionComponent export is missing or invalid.");
  }
  const prototype = (value as { prototype?: unknown }).prototype;
  if (!prototype || typeof prototype !== "object") {
    throw new Error("ToolExecution patch failed: ToolExecutionComponent.prototype is missing.");
  }
  if (typeof (prototype as Record<string, unknown>).render !== "function") {
    throw new Error("ToolExecution patch failed: ToolExecutionComponent.prototype.render is not a function.");
  }
  return value as { prototype: ToolExecutionPrototype };
}

function getPackageRoot(packageName: string): string {
  let entryUrl: string;
  try {
    entryUrl = import.meta.resolve(packageName);
  } catch (error) {
    throw new Error(`ToolExecution patch failed: could not resolve ${packageName} package root.`, { cause: error });
  }
  try {
    const entryPath = fileURLToPath(entryUrl);
    return dirname(dirname(entryPath));
  } catch (error) {
    throw new Error(`ToolExecution patch failed: could not derive ${packageName} package root from ${entryUrl}.`, {
      cause: error,
    });
  }
}

async function importPiCodingAgentInternal<TModule>(relativePath: string): Promise<TModule> {
  const packageRoot = getPackageRoot("@earendil-works/pi-coding-agent");
  const moduleUrl = pathToFileURL(join(packageRoot, relativePath)).href;
  try {
    return (await import(moduleUrl)) as TModule;
  } catch (error) {
    throw new Error(
      `ToolExecution patch failed: could not import internal module "@earendil-works/pi-coding-agent/${relativePath}".`,
      { cause: error },
    );
  }
}

async function installPatch(): Promise<() => void> {
  const moduleExports = await importPiCodingAgentInternal<{ ToolExecutionComponent: unknown }>(
    PI_TOOL_EXECUTION_MODULE,
  );
  const ToolExecutionComponent = assertPatchableToolExecutionComponent(moduleExports.ToolExecutionComponent);
  const prototype = ToolExecutionComponent.prototype;
  const originalRender = prototype.render;

  const patchedRender = function patchedRender(this: ToolExecutionPrototype, width: number): string[] {
    const lines = originalRender.call(this, width);
    return shouldHideRenderedLines(lines) ? [] : lines;
  };

  prototype.render = patchedRender;

  return () => {
    if (prototype.render === patchedRender) {
      prototype.render = originalRender;
    }
  };
}

export async function retainToolExecutionPatch(): Promise<() => Promise<void>> {
  const state = getPatchState();
  state.refCount += 1;

  if (!state.cleanup) {
    const installPromise = state.installPromise ?? installPatch();
    if (!state.installPromise) state.installPromise = installPromise;
    try {
      state.cleanup = await installPromise;
    } catch (error) {
      state.refCount = Math.max(0, state.refCount - 1);
      throw error;
    } finally {
      if (state.installPromise === installPromise) state.installPromise = undefined;
    }
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    state.refCount = Math.max(0, state.refCount - 1);
    if (state.refCount > 0) return;
    const cleanup = state.cleanup;
    if (!cleanup) return;
    state.cleanup = undefined;
    try {
      cleanup();
    } catch (error) {
      state.cleanup = cleanup;
      state.refCount += 1;
      released = false;
      throw error;
    }
  };
}

