import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { canGroupTool, renderGroupedToolCall, renderGroupedToolResult, summarizeToolCall } from "./basic-tool-grouping.ts";
import { Type } from "@sinclair/typebox";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoMapSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to summarize (default: current working directory)" })),
  depth: Type.Optional(Type.Number({ description: "Directory depth for the structure summary (default 3, max 6)" })),
  maxFiles: Type.Optional(Type.Number({ description: "Maximum representative files to include (default 80, max 250)" })),
  maxRecent: Type.Optional(Type.Number({ description: "Maximum recent/status files to include (default 20, max 80)" })),
});

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  ".next",
  ".nuxt",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
  ".turbo",
  ".pytest_cache",
]);

const IMPORTANT_ROOT_FILES = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "pnpm-workspace.yaml",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "tsconfig.json",
  "vite.config.ts",
  "next.config.js",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "Gemfile",
  "Makefile",
  "justfile",
  "docker-compose.yml",
  "Dockerfile",
];

const CONFIG_PATTERNS = [/^eslint\.config\./, /^prettier\.config\./, /^biome\.json/, /^vitest\.config\./, /^jest\.config\./, /^tailwind\.config\./];

const EXT_LANG: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript React",
  ".js": "JavaScript",
  ".jsx": "JavaScript React",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".cpp": "C++",
  ".cc": "C++",
  ".c": "C",
  ".h": "C/C++",
  ".hpp": "C++",
  ".md": "Markdown",
  ".json": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".toml": "TOML",
};

type GitInfo = {
  root?: string;
  branch?: string;
  status: string[];
  tracked: string[];
  untracked: string[];
  recent: string[];
};

type FileInfo = {
  path: string;
  ext: string;
  size: number;
  mtime: number;
};

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value ?? NaN)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}

function safeKeyHint(keybinding: string, description: string): string {
  try {
    return keyHint(keybinding, description);
  } catch {
    return `(${description})`;
  }
}

function fallbackText(result: any): string {
  const content = result.content?.[0];
  return content?.type === "text" ? content.text : "";
}

function renderRepoMapResult(result: any, { expanded, isPartial }: { expanded?: boolean; isPartial?: boolean }, theme: any) {
  if (isPartial) return new Text(theme.fg("warning", "Mapping repository..."), 0, 0);

  const details = result.details as { root?: string; fileCount?: number; git?: GitInfo } | undefined;
  if (!details) return new Text(theme.fg("accent", "Map project"), 0, 0);

  const name = basename(details.root || "project");
  const hint = safeKeyHint("app.tools.expand", "to expand");
  return new Text(theme.fg("accent", `Map ${name}`) + theme.fg("muted", `\n${hint}`), 0, 0);
}

function runGit(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) return undefined;
  return result.stdout.trimEnd();
}

function splitNul(text: string | undefined): string[] {
  return text ? text.split("\0").filter(Boolean) : [];
}

function findProjectRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git")) || existsSync(join(current, "package.json")) || existsSync(join(current, "Cargo.toml")) || existsSync(join(current, "go.mod")) || existsSync(join(current, "pyproject.toml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function getGitInfo(root: string): GitInfo {
  const gitRoot = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot) return { status: [], tracked: [], untracked: [], recent: [] };

  const branch = runGit(gitRoot, ["branch", "--show-current"]);
  const status = (runGit(gitRoot, ["status", "--short"]) ?? "").split("\n").filter(Boolean);
  const tracked = splitNul(runGit(gitRoot, ["ls-files", "-z"]));
  const untracked = splitNul(runGit(gitRoot, ["ls-files", "-z", "--others", "--exclude-standard"]));
  const recentRaw = runGit(gitRoot, ["log", "--name-only", "--pretty=format:", "-n", "20"]);
  const recent = [...new Set((recentRaw ?? "").split("\n").map((line) => line.trim()).filter(Boolean))];

  return { root: gitRoot, branch: branch || undefined, status, tracked, untracked, recent };
}

function walkFiles(root: string, maxDepth: number, maxFiles = 5000): FileInfo[] {
  const out: FileInfo[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length > 0 && out.length < maxFiles) {
    const item = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") {
        if (entry.name !== ".env.example") continue;
      }
      const full = join(item.dir, entry.name);
      const rel = relative(root, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name) && item.depth < maxDepth) stack.push({ dir: full, depth: item.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stats = statSync(full);
        out.push({ path: rel, ext: extname(entry.name).toLowerCase(), size: stats.size, mtime: stats.mtimeMs });
      } catch {
        // Ignore vanished files.
      }
      if (out.length >= maxFiles) break;
    }
  }

  return out;
}

function fileInfosFromGit(root: string, paths: string[]): FileInfo[] {
  const files: FileInfo[] = [];
  for (const rel of paths) {
    const full = join(root, rel);
    try {
      const stats = statSync(full);
      if (stats.isFile()) files.push({ path: rel.replace(/\\/g, "/"), ext: extname(rel).toLowerCase(), size: stats.size, mtime: stats.mtimeMs });
    } catch {
      // Deleted or inaccessible; skip for structure statistics.
    }
  }
  return files;
}

function summarizeLanguages(files: FileInfo[]): string[] {
  const counts = new Map<string, { files: number; bytes: number }>();
  for (const file of files) {
    const lang = EXT_LANG[file.ext] ?? (file.ext ? file.ext.slice(1).toUpperCase() : "No extension");
    const current = counts.get(lang) ?? { files: 0, bytes: 0 };
    current.files++;
    current.bytes += file.size;
    counts.set(lang, current);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].files - a[1].files || b[1].bytes - a[1].bytes)
    .slice(0, 10)
    .map(([lang, data]) => `${lang}: ${data.files} files`);
}

function summarizeDirectories(files: FileInfo[], depth: number): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < Math.min(parts.length, depth + 1); i++) {
      const dir = parts.slice(0, i).join("/");
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 30)
    .map(([dir, count]) => `${dir}/ (${count})`);
}

function findImportantFiles(root: string, files: FileInfo[], limit: number): string[] {
  const fileSet = new Set(files.map((file) => file.path));
  const important: string[] = [];

  for (const name of IMPORTANT_ROOT_FILES) {
    if (fileSet.has(name) || existsSync(join(root, name))) important.push(name);
  }

  for (const file of files) {
    const base = basename(file.path);
    if (CONFIG_PATTERNS.some((pattern) => pattern.test(base)) && !important.includes(file.path)) important.push(file.path);
  }

  const entryHints = files.filter((file) => /(^|\/)(src|app|pages|server|cmd|bin)\//.test(file.path)).slice(0, limit);
  for (const file of entryHints) {
    if (!important.includes(file.path)) important.push(file.path);
    if (important.length >= limit) break;
  }

  return important.slice(0, limit);
}

function readPackageSummary(root: string): string[] {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const lines = [`package: ${pkg.name ?? "(unnamed)"}${pkg.version ? `@${pkg.version}` : ""}`];
    if (pkg.type) lines.push(`type: ${pkg.type}`);
    if (pkg.scripts && typeof pkg.scripts === "object") {
      const scripts = Object.keys(pkg.scripts).slice(0, 12).map((name) => `${name}: ${pkg.scripts[name]}`);
      if (scripts.length > 0) lines.push(`scripts: ${scripts.join("; ")}`);
    }
    const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).slice(0, 20);
    if (deps.length > 0) lines.push(`deps: ${deps.join(", ")}${deps.length >= 20 ? ", ..." : ""}`);
    return lines;
  } catch {
    return ["package.json: present but could not parse"];
  }
}

function formatList(items: string[], empty = "(none)"): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : [`- ${empty}`];
}

export default function repoMapExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "repo_map",
    label: "repo_map",
    description:
      "Generate a compact project orientation map: root, git state, manifests, language mix, important files, directories, and recent changes. This is a synthesized context summary, not a shell command wrapper.",
    promptSnippet: "Summarize project structure, manifests, important files, and recent git activity",
    promptGuidelines: [
      "Use repo_map when starting work in an unfamiliar repository or after switching projects.",
      "Do not use repo_map for exact file contents; use read or read_block after repo_map identifies relevant files.",
    ],
    parameters: repoMapSchema,
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderGroupedToolCall("repo_map", args, theme, context, summarizeToolCall("repo_map", args));
    },
    renderResult(result, options, theme, context) {
      if (options.expanded || !canGroupTool(context)) return renderRepoMapResult(result, options, theme);
      return renderGroupedToolResult("repo_map", result, options, theme, context);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const requested = params.path ? resolve(ctx.cwd, params.path) : ctx.cwd;
      const rootCandidate = findProjectRoot(requested);
      const git = getGitInfo(rootCandidate);
      const root = git.root ?? rootCandidate;
      const depth = clamp(params.depth, 3, 1, 6);
      const maxFiles = clamp(params.maxFiles, 80, 20, 250);
      const maxRecent = clamp(params.maxRecent, 20, 0, 80);

      const trackedExisting = git.tracked.length > 0 ? fileInfosFromGit(root, git.tracked) : [];
      const files = trackedExisting.length > 0 ? trackedExisting : walkFiles(root, depth + 2);
      const important = findImportantFiles(root, files, maxFiles);
      const recentByGit = git.recent.filter((file) => existsSync(join(root, file))).slice(0, maxRecent);
      const recentByMtime = [...files].sort((a, b) => b.mtime - a.mtime).slice(0, maxRecent).map((file) => file.path);
      const recent = recentByGit.length > 0 ? recentByGit : recentByMtime;
      const dirty = git.status.slice(0, maxRecent);
      const packageSummary = readPackageSummary(root);
      const languages = summarizeLanguages(files);
      const directories = summarizeDirectories(files, depth);

      const lines: string[] = [];
      lines.push(`# repo_map: ${basename(root) || root}`);
      lines.push("");
      lines.push(`Root: ${root}`);
      if (git.root) lines.push(`Git: ${git.branch ? `branch ${git.branch}` : "repository detected"}`);
      else lines.push("Git: not detected");
      lines.push(`Files indexed: ${files.length}${trackedExisting.length > 0 ? " tracked files" : " filesystem files"}`);
      lines.push("");

      if (packageSummary.length > 0) {
        lines.push("## Manifest");
        lines.push(...packageSummary.map((line) => `- ${line}`));
        lines.push("");
      }

      lines.push("## Language Mix");
      lines.push(...formatList(languages));
      lines.push("");

      lines.push(`## Directories (top ${directories.length}, depth ${depth})`);
      lines.push(...formatList(directories));
      lines.push("");

      lines.push(`## Important Files (top ${important.length})`);
      lines.push(...formatList(important));
      lines.push("");

      lines.push(`## Git Status (top ${dirty.length})`);
      lines.push(...formatList(dirty));
      lines.push("");

      lines.push(`## Recent Files (top ${recent.length})`);
      lines.push(...formatList(recent));
      lines.push("");
      lines.push("Next: use read_block for a relevant symbol/block, or read for exact file contents.");

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          root,
          git,
          fileCount: files.length,
          languages,
          directories,
          importantFiles: important,
          status: dirty,
          recent,
        },
      };
    },
  });
}
