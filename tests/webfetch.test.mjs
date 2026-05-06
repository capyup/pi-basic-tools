import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package registers OpenCode-style webfetch instead of fetch", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.ok(packageJson.pi.extensions.includes("./extensions/webfetch.ts"));
  assert.ok(!packageJson.pi.extensions.includes("./extensions/fetch.ts"));
  assert.equal(packageJson.dependencies.turndown, "^7.2.4");
});

test("webfetch returns content directly and does not write fetch artifacts", async () => {
  const source = await readFile(path.join(repoRoot, "extensions", "webfetch.ts"), "utf8");

  assert.match(source, /name:\s*"webfetch"/);
  assert.match(source, /new TurndownService/);
  assert.match(source, /type:\s*"image"/);
  assert.doesNotMatch(source, /writeFile|mkdir|markitdown|\.pi\/fetch|meta\.json|content\.md|response\.<ext>/i);
});

test("webfetch keeps OpenCode response limits and request headers", async () => {
  const source = await readFile(path.join(repoRoot, "extensions", "webfetch.ts"), "utf8");

  assert.match(source, /5 \* 1024 \* 1024/);
  assert.match(source, /DEFAULT_TIMEOUT_SECONDS = 30/);
  assert.match(source, /MAX_TIMEOUT_SECONDS = 120/);
  assert.match(source, /Accept: acceptHeaderFor\(format\)/);
  assert.match(source, /cf-mitigated/);
  assert.match(source, /buildHeaders\(format, "opencode"\)/);
});
