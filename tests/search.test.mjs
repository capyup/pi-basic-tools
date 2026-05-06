import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function normalizeOutputPath(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

async function resolveRg() {
  const candidates = [process.env.PI_BASIC_TOOLS_RG, process.env.RG_PATH, process.env.OPENCODE_RG_PATH].filter(Boolean);
  if (candidates.length > 0) return candidates[0];

  const locator = process.platform === "win32" ? "where" : "which";
  const result = await run(locator, [process.platform === "win32" ? "rg.exe" : "rg"]);
  if (result.code !== 0) return undefined;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-basic-tools-search-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".hidden"), { recursive: true });
  await mkdir(path.join(root, ".git"), { recursive: true });

  await writeFile(path.join(root, "src", "newer.ts"), "const value = 'target-ts';\n", "utf8");
  await writeFile(path.join(root, "src", "app.js"), "const value = 'target-js';\n", "utf8");
  await writeFile(path.join(root, ".hidden", "secret.ts"), "const value = 'target-hidden';\n", "utf8");
  await writeFile(path.join(root, ".git", "config.ts"), "const value = 'target-git';\n", "utf8");
  await writeFile(path.join(root, ".ripgreprc"), "--glob=!*", "utf8");

  return root;
}

test("package registers the OpenCode-style search extension", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.ok(packageJson.pi.extensions.includes("./extensions/search.ts"));
  assert.ok(!packageJson.pi.extensions.includes("./extensions/enable-builtin-search.ts"));
});

test("search extension exposes glob and grep without activating builtin find or ls", async () => {
  const source = await readFile(path.join(repoRoot, "extensions", "search.ts"), "utf8");
  assert.match(source, /name:\s*"glob"/);
  assert.match(source, /name:\s*"grep"/);
  assert.match(source, /REMOVED_BUILTIN_SEARCH_TOOLS\s*=\s*new Set\(\["find", "ls"\]\)/);
  assert.doesNotMatch(source, /SEARCH_BUILTINS\s*=\s*\["grep", "find", "ls"\]/);
});

test("glob defaults skip dot paths while ignoring ripgrep config", async (t) => {
  const rg = await resolveRg();
  if (!rg) {
    t.skip("ripgrep is not installed");
    return;
  }

  const root = await createFixture();
  try {
    const result = await run(
      rg,
      ["--no-config", "--files", "--glob=**/*.ts", "."],
      { cwd: root, env: { ...process.env, RIPGREP_CONFIG_PATH: path.join(root, ".ripgreprc") } },
    );

    assert.equal(result.code, 0, result.stderr);
    const files = result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(normalizeOutputPath);

    assert.ok(files.includes("src/newer.ts"));
    assert.ok(!files.includes(".hidden/secret.ts"));
    assert.ok(!files.includes("src/app.js"));
    assert.ok(!files.includes(".git/config.ts"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("glob searches dot paths when the dot directory is the explicit target", async (t) => {
  const rg = await resolveRg();
  if (!rg) {
    t.skip("ripgrep is not installed");
    return;
  }

  const root = await createFixture();
  try {
    const result = await run(
      rg,
      ["--no-config", "--files", "--hidden", "--glob=**/*.ts", "."],
      { cwd: path.join(root, ".hidden"), env: { ...process.env, RIPGREP_CONFIG_PATH: path.join(root, ".ripgreprc") } },
    );

    assert.equal(result.code, 0, result.stderr);
    const files = result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(normalizeOutputPath);

    assert.deepEqual(files, ["secret.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grep defaults skip dot paths and honors include filtering", async (t) => {
  const rg = await resolveRg();
  if (!rg) {
    t.skip("ripgrep is not installed");
    return;
  }

  const root = await createFixture();
  try {
    const result = await run(
      rg,
      [
        "--no-config",
        "--json",
        "--no-messages",
        "--glob=**/*.ts",
        "--",
        "target",
        ".",
      ],
      { cwd: root, env: { ...process.env, RIPGREP_CONFIG_PATH: path.join(root, ".ripgreprc") } },
    );

    assert.equal(result.code, 0, result.stderr);
    const matches = result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "match")
      .map((event) => ({
        path: normalizeOutputPath(event.data.path.text),
        line: event.data.line_number,
        text: event.data.lines.text,
      }));

    const paths = matches.map((match) => match.path);
    assert.ok(paths.includes("src/newer.ts"));
    assert.ok(!paths.includes(".hidden/secret.ts"));
    assert.ok(!paths.includes("src/app.js"));
    assert.ok(!paths.includes(".git/config.ts"));
    assert.ok(matches.every((match) => match.line === 1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grep searches dot paths when the dot file or directory is the explicit target", async (t) => {
  const rg = await resolveRg();
  if (!rg) {
    t.skip("ripgrep is not installed");
    return;
  }

  const root = await createFixture();
  try {
    const directoryResult = await run(
      rg,
      ["--no-config", "--json", "--hidden", "--no-messages", "--glob=**/*.ts", "--", "target", "."],
      { cwd: path.join(root, ".hidden"), env: { ...process.env, RIPGREP_CONFIG_PATH: path.join(root, ".ripgreprc") } },
    );
    assert.equal(directoryResult.code, 0, directoryResult.stderr);
    assert.ok(directoryResult.stdout.includes("target-hidden"));

    const fileResult = await run(
      rg,
      ["--no-config", "--json", "--hidden", "--no-messages", "--", "target", ".hidden/secret.ts"],
      { cwd: root, env: { ...process.env, RIPGREP_CONFIG_PATH: path.join(root, ".ripgreprc") } },
    );
    assert.equal(fileResult.code, 0, fileResult.stderr);
    assert.ok(fileResult.stdout.includes("target-hidden"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
