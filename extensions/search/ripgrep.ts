import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const RIPGREP_VERSION = "15.1.0";

const PLATFORM = {
  "arm64-darwin": { platform: "aarch64-apple-darwin", extension: "tar.gz" },
  "arm64-linux": { platform: "aarch64-unknown-linux-gnu", extension: "tar.gz" },
  "x64-darwin": { platform: "x86_64-apple-darwin", extension: "tar.gz" },
  "x64-linux": { platform: "x86_64-unknown-linux-musl", extension: "tar.gz" },
  "arm64-win32": { platform: "aarch64-pc-windows-msvc", extension: "zip" },
  "ia32-win32": { platform: "i686-pc-windows-msvc", extension: "zip" },
  "x64-win32": { platform: "x86_64-pc-windows-msvc", extension: "zip" },
} as const;

let ripgrepPathPromise: Promise<string> | undefined;

export async function exists(filepath: string): Promise<boolean> {
  try {
    await access(filepath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runCommand(command: string, args: string[], cwd: string, signal?: AbortSignal) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: ripgrepEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const appendChunk = (target: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
      const current = target === "stdout" ? stdout : stderr;
      if (current.length + text.length > OUTPUT_LIMIT_BYTES) {
        child.kill();
        finish(() =>
          reject(
            new Error(
              `${command} output exceeded ${OUTPUT_LIMIT_BYTES} bytes; narrow the search and run the command again.`,
            ),
          ),
        );
        return;
      }

      if (target === "stdout") stdout += text;
      else stderr += text;
    };

    const onAbort = () => {
      child.kill();
      finish(() => reject(new Error("Operation aborted")));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => appendChunk("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendChunk("stderr", chunk));
    child.on("error", (error: Error) => finish(() => reject(error)));
    child.on("close", (code: number | null) => finish(() => resolve({ stdout, stderr, exitCode: code ?? 0 })));
  });
}

export function ripgrepEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.RIPGREP_CONFIG_PATH;
  return env;
}

async function findOnPath(): Promise<string | undefined> {
  const locator = process.platform === "win32" ? "where" : "which";
  const result = await runCommand(locator, [process.platform === "win32" ? "rg.exe" : "rg"], process.cwd()).catch(
    () => undefined,
  );
  if (!result || result.exitCode !== 0) return undefined;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function bundledTargetPath(): string {
  return path.join(getAgentDir(), "pi-basic-tools", "bin", process.platform === "win32" ? "rg.exe" : "rg");
}

async function extractRipgrepArchive(archive: string, target: string, config: (typeof PLATFORM)[keyof typeof PLATFORM]) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-basic-tools-rg-"));
  try {
    if (config.extension === "zip") {
      const shell = (await findExecutable(["powershell.exe", "pwsh.exe"])) ?? "powershell.exe";
      const result = await runCommand(shell, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${tempRoot.replaceAll("'", "''")}' -Force`,
      ], process.cwd());
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "failed to extract ripgrep archive");
    } else {
      const result = await runCommand("tar", ["-xzf", archive, "-C", tempRoot], process.cwd());
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "failed to extract ripgrep archive");
    }

    const executable = path.join(
      tempRoot,
      `ripgrep-${RIPGREP_VERSION}-${config.platform}`,
      process.platform === "win32" ? "rg.exe" : "rg",
    );
    if (!(await exists(executable))) {
      throw new Error(`ripgrep archive did not contain executable: ${executable}`);
    }

    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(executable, target);
    if (process.platform !== "win32") await chmod(target, 0o755);
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function findExecutable(names: string[]): Promise<string | undefined> {
  for (const name of names) {
    const locator = process.platform === "win32" ? "where" : "which";
    const result = await runCommand(locator, [name], process.cwd()).catch(() => undefined);
    if (result?.exitCode === 0) {
      const match = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (match) return match;
    }
  }
  return undefined;
}

async function downloadRipgrep(target: string): Promise<string> {
  const platformKey = `${process.arch}-${process.platform}` as keyof typeof PLATFORM;
  const config = PLATFORM[platformKey];
  if (!config) throw new Error(`unsupported platform for ripgrep: ${platformKey}`);

  const filename = `ripgrep-${RIPGREP_VERSION}-${config.platform}.${config.extension}`;
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${filename}`;
  const archive = path.join(path.dirname(target), filename);

  await mkdir(path.dirname(target), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to download ripgrep from ${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error(`failed to download ripgrep from ${url}: empty response`);

  await writeFile(archive, bytes);
  try {
    await extractRipgrepArchive(archive, target, config);
  } finally {
    await rm(archive, { force: true }).catch(() => undefined);
  }
  return target;
}

export async function resolveRipgrepPath(): Promise<string> {
  ripgrepPathPromise ??= (async () => {
    const configured = [
      process.env.PI_BASIC_TOOLS_RG,
      process.env.PI_OPENCODE_RG,
      process.env.RG_PATH,
      process.env.OPENCODE_RG_PATH,
    ].filter((value): value is string => Boolean(value));

    for (const candidate of configured) {
      if (await exists(candidate)) return candidate;
    }

    const system = await findOnPath();
    if (system) return system;

    const home = homedir();
    const bundledCandidates = [
      path.join(home, ".opencode", "bin", process.platform === "win32" ? "rg.exe" : "rg"),
      path.join(home, ".local", "share", "opencode", "bin", process.platform === "win32" ? "rg.exe" : "rg"),
      bundledTargetPath(),
    ];

    for (const candidate of bundledCandidates) {
      if (await exists(candidate)) return candidate;
    }

    return downloadRipgrep(bundledTargetPath());
  })();
  return ripgrepPathPromise;
}

export async function readPathKind(filepath: string): Promise<"file" | "directory" | undefined> {
  const info = await stat(filepath).catch(() => undefined);
  if (!info) return undefined;
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return undefined;
}

export async function assertDirectory(directory: string) {
  const kind = await readPathKind(directory);
  if (!kind) throw new Error(`No such file or directory: '${directory}'`);
  if (kind !== "directory") throw new Error(`Not a directory: '${directory}'`);
}

export async function safeMtime(filepath: string): Promise<number> {
  return (await stat(filepath).catch(() => undefined))?.mtime.getTime() ?? 0;
}
