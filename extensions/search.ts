import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import {
  assertDirectory,
  readPathKind,
  resolveRipgrepPath,
  ripgrepEnv,
  safeMtime,
} from "./search/ripgrep.ts";

const DEFAULT_BUILTINS = new Set(["read", "bash", "edit", "write"]);
const SEARCH_TOOLS = ["grep", "glob"] as const;
const REMOVED_BUILTIN_SEARCH_TOOLS = new Set(["find", "ls"]);
const LIMIT = 100;
const MAX_CAPTURED_MATCHES = 10_000;
const MAX_LINE_LENGTH = 2000;

const globSchema = Type.Object({
  pattern: Type.String({ description: "The glob pattern to match files against" }),
  path: Type.Optional(
    Type.String({
      description:
        'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
    }),
  ),
});

const grepSchema = Type.Object({
  pattern: Type.String({ description: "The regex pattern to search for in file contents" }),
  path: Type.Optional(Type.String({ description: "The directory to search in. Defaults to the current working directory." })),
  include: Type.Optional(Type.String({ description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")' })),
});

type GlobDetails = {
  count: number;
  truncated: boolean;
  searchPath: string;
};

type GrepDetails = {
  matches: number;
  truncated: boolean;
  searchPath: string;
};

type MatchRecord = {
  path: string;
  line: number;
  text: string;
  mtime: number;
};

type RipgrepMatchEvent = {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
  };
};

function normalizeRipgrepPath(filepath: string): string {
  return path.normalize(filepath.replace(/^\.[\\/]/, ""));
}

function resolveSearchPath(cwd: string, inputPath?: string): string {
  return path.resolve(cwd, inputPath || ".");
}

function targetsDotPath(inputPath?: string): boolean {
  if (!inputPath) return false;
  return inputPath
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .some((part) => part.startsWith("."));
}

function resultText(result: unknown): string | undefined {
  const candidate = result as { content?: Array<{ type?: string; text?: string }> };
  return candidate.content?.find((entry) => entry.type === "text")?.text;
}

function globSummary(result: unknown): string {
  const details = (result as { details?: Partial<GlobDetails> }).details ?? {};
  if (typeof details.count === "number") return `${details.count} results${details.truncated ? " [truncated]" : ""}`;
  return resultText(result)?.split("\n").find(Boolean) ?? "Done";
}

function grepSummary(result: unknown): string {
  const details = (result as { details?: Partial<GrepDetails> }).details ?? {};
  if (typeof details.matches === "number") return `${details.matches} results${details.truncated ? " [truncated]" : ""}`;
  return resultText(result)?.split("\n").find(Boolean) ?? "Done";
}

async function collectGlobFiles(searchPath: string, pattern: string, includeHidden: boolean, signal?: AbortSignal) {
  const rgPath = await resolveRipgrepPath();
  const args = ["--no-config", "--files"];
  if (includeHidden) args.push("--hidden");
  args.push(`--glob=${pattern}`, ".");

  return new Promise<{ files: string[]; truncated: boolean }>((resolve, reject) => {
    const child = spawn(rgPath, args, {
      cwd: searchPath,
      env: ripgrepEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const rl = createInterface({ input: child.stdout! });
    const files: string[] = [];
    const stderr: string[] = [];
    let truncated = false;
    let settled = false;
    let stoppedEarly = false;

    const cleanup = () => {
      rl.close();
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const stop = () => {
      stoppedEarly = true;
      if (!child.killed) child.kill();
    };

    const onAbort = () => {
      stop();
      finish(() => reject(new Error("Operation aborted")));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    rl.on("line", (line) => {
      if (!line) return;
      if (files.length >= LIMIT) {
        truncated = true;
        stop();
        return;
      }
      files.push(normalizeRipgrepPath(line));
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.join("").length < 8192) stderr.push(chunk.toString());
    });
    child.on("error", (error: Error) => finish(() => reject(error)));
    child.on("close", (code: number | null) => {
      if (!stoppedEarly && code !== 0 && code !== 1) {
        finish(() => reject(new Error(`ripgrep failed: ${stderr.join("").trim() || `exit code ${code ?? 0}`}`)));
        return;
      }
      finish(() => resolve({ files, truncated }));
    });
  });
}

async function collectGrepMatches(
  cwd: string,
  pattern: string,
  include: string | undefined,
  includeHidden: boolean,
  files: string[] | undefined,
  signal?: AbortSignal,
) {
  const rgPath = await resolveRipgrepPath();
  const args = ["--no-config", "--json"];
  if (includeHidden) args.push("--hidden");
  args.push("--no-messages");
  if (include) args.push(`--glob=${include}`);
  args.push("--", pattern, ...(files ?? ["."]));

  return new Promise<{ matches: Omit<MatchRecord, "mtime">[]; partial: boolean; capped: boolean }>((resolve, reject) => {
    const child = spawn(rgPath, args, {
      cwd,
      env: ripgrepEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const rl = createInterface({ input: child.stdout! });
    const matches: Omit<MatchRecord, "mtime">[] = [];
    const stderr: string[] = [];
    let settled = false;
    let capped = false;
    let stoppedEarly = false;

    const cleanup = () => {
      rl.close();
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const stop = () => {
      stoppedEarly = true;
      if (!child.killed) child.kill();
    };

    const onAbort = () => {
      stop();
      finish(() => reject(new Error("Operation aborted")));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    rl.on("line", (line) => {
      if (!line) return;
      if (matches.length >= MAX_CAPTURED_MATCHES) {
        capped = true;
        stop();
        return;
      }

      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch (error) {
        finish(() => reject(new Error("invalid ripgrep output", { cause: error })));
        stop();
        return;
      }

      const match = event as Partial<RipgrepMatchEvent>;
      if (match.type !== "match" || !match.data?.path?.text || !match.data.lines || !match.data.line_number) return;
      const rawPath = normalizeRipgrepPath(match.data.path.text);
      matches.push({
        path: path.resolve(cwd, rawPath),
        line: match.data.line_number,
        text: match.data.lines.text,
      });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.join("").length < 8192) stderr.push(chunk.toString());
    });
    child.on("error", (error: Error) => finish(() => reject(error)));
    child.on("close", (code: number | null) => {
      if (!stoppedEarly && code !== 0 && code !== 1 && code !== 2) {
        finish(() => reject(new Error(`ripgrep failed: ${stderr.join("").trim() || `exit code ${code ?? 0}`}`)));
        return;
      }
      if (!stoppedEarly && code === 2 && matches.length === 0) {
        finish(() => reject(new Error(`ripgrep failed: ${stderr.join("").trim() || "invalid search pattern or inaccessible path"}`)));
        return;
      }
      finish(() => resolve({ matches, partial: !stoppedEarly && code === 2, capped }));
    });
  });
}

async function withMtimes(rows: Omit<MatchRecord, "mtime">[]): Promise<MatchRecord[]> {
  const times = new Map<string, number>();
  await Promise.all(
    Array.from(new Set(rows.map((row) => row.path))).map(async (filePath) => {
      times.set(filePath, await safeMtime(filePath));
    }),
  );
  return rows.map((row) => ({ ...row, mtime: times.get(row.path) ?? 0 }));
}

function registerGlob(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "glob",
    label: "glob",
    description:
      "Search for files using glob patterns like '**/*.js' or 'src/**/*.ts'. Returns matching file paths sorted by modification time.",
    promptSnippet: "Find files by pattern matching.",
    promptGuidelines: [
      "Use this tool when you need to find files by name patterns.",
      "Supports glob patterns like '**/*.js' or 'src/**/*.ts'.",
      "Returns matching file paths sorted by modification time.",
      "By default, dot files and dot directories are skipped. To search one, set path to that dot file or dot directory explicitly.",
      "When you are doing an open-ended search that may require multiple rounds of globbing and grepping, prefer the task tool instead.",
    ],
    parameters: globSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const searchPath = resolveSearchPath(ctx.cwd, params.path);
      const kind = await readPathKind(searchPath);
      if (kind === "file") throw new Error(`glob path must be a directory: ${searchPath}`);
      await assertDirectory(searchPath);

      const { files, truncated } = await collectGlobFiles(searchPath, params.pattern, targetsDotPath(params.path), signal);
      const rows = await Promise.all(
        files.map(async (relativePath) => {
          const fullPath = path.resolve(searchPath, relativePath);
          return { path: fullPath, mtime: await safeMtime(fullPath) };
        }),
      );
      rows.sort((a, b) => b.mtime - a.mtime);

      const output: string[] = [];
      if (rows.length === 0) output.push("No files found");
      else {
        output.push(...rows.map((file) => file.path));
        if (truncated) {
          output.push("");
          output.push(
            `(Results are truncated: showing first ${LIMIT} results. Consider using a more specific path or pattern.)`,
          );
        }
      }

      return {
        content: [{ type: "text" as const, text: output.join("\n") }],
        details: { count: rows.length, truncated, searchPath } satisfies GlobDetails,
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("glob "))}${theme.fg("accent", args.pattern)}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      return new Text(theme.fg("success", globSummary(result)), 0, 0);
    },
  });
}

function registerGrep(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: "Fast content search across your codebase. Supports full regex syntax and file pattern filtering.",
    promptSnippet: "Search file contents using regular expressions.",
    promptGuidelines: [
      "Use this tool when you need to find files containing specific patterns.",
      "Use the include parameter to filter files by pattern, for example '*.js' or '*.{ts,tsx}'.",
      "Returns file paths and line numbers sorted by modification time.",
      "By default, dot files and dot directories are skipped. To search one, set path to that dot file or dot directory explicitly.",
      "If you need to identify or count every match within files, use bash with rg directly instead of this tool.",
      "When you are doing an open-ended search that may require multiple rounds of globbing and grepping, prefer the task tool instead.",
    ],
    parameters: grepSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!params.pattern) throw new Error("pattern is required");

      const target = resolveSearchPath(ctx.cwd, params.path);
      const kind = await readPathKind(target);
      if (!kind) throw new Error(`No such file or directory: '${target}'`);

      const cwd = kind === "directory" ? target : path.dirname(target);
      const files = kind === "directory" ? undefined : [path.relative(cwd, target)];
      const { matches: rawMatches, partial, capped } = await collectGrepMatches(
        cwd,
        params.pattern,
        params.include,
        targetsDotPath(params.path),
        files,
        signal,
      );

      const matches = await withMtimes(rawMatches);
      matches.sort((a, b) => b.mtime - a.mtime);

      const truncated = capped || matches.length > LIMIT;
      const visible = matches.slice(0, LIMIT);
      if (visible.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No files found" }],
          details: { matches: 0, truncated: false, searchPath: target } satisfies GrepDetails,
        };
      }

      const total = capped ? `${matches.length}+` : String(matches.length);
      const output = [`Found ${total} matches${truncated ? ` (showing first ${LIMIT})` : ""}`];
      let currentFile = "";
      for (const match of visible) {
        if (currentFile !== match.path) {
          if (currentFile) output.push("");
          currentFile = match.path;
          output.push(`${match.path}:`);
        }
        const text = match.text.length > MAX_LINE_LENGTH ? `${match.text.slice(0, MAX_LINE_LENGTH)}...` : match.text;
        output.push(`  Line ${match.line}: ${text}`);
      }

      if (truncated) {
        output.push("");
        output.push(
          capped
            ? `(Results truncated after ${matches.length} captured matches. Consider using a more specific path or pattern.)`
            : `(Results truncated: showing ${LIMIT} of ${matches.length} matches (${matches.length - LIMIT} hidden). Consider using a more specific path or pattern.)`,
        );
      }
      if (partial) {
        output.push("");
        output.push("(Some paths were inaccessible and skipped)");
      }

      return {
        content: [{ type: "text" as const, text: output.join("\n") }],
        details: {
          matches: matches.length,
          truncated,
          searchPath: target,
        } satisfies GrepDetails,
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("grep "))}${theme.fg("accent", args.pattern)}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
      return new Text(theme.fg("success", grepSummary(result)), 0, 0);
    },
  });
}

function activateOpenCodeSearchTools(pi: ExtensionAPI): void {
  const activeTools = pi.getActiveTools();
  if (!activeTools.some((name) => DEFAULT_BUILTINS.has(name))) return;

  const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
  const nextTools = activeTools.filter((name) => !REMOVED_BUILTIN_SEARCH_TOOLS.has(name));

  for (const name of SEARCH_TOOLS) {
    if (availableTools.has(name) && !nextTools.includes(name)) nextTools.push(name);
  }

  if (nextTools.length !== activeTools.length || nextTools.some((name, index) => name !== activeTools[index])) {
    pi.setActiveTools(nextTools);
  }
}

export default function searchExtension(pi: ExtensionAPI): void {
  registerGlob(pi);
  registerGrep(pi);
  pi.on("session_start", () => activateOpenCodeSearchTools(pi));
  pi.on("resources_discover", () => activateOpenCodeSearchTools(pi));
}
