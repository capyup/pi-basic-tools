import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const packageJsonPath = join(repoRoot, "package.json");

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("package wiring", () => {
  test("registers only the current pi-basic-tools extensions", async () => {
    const pkg = await readJson(packageJsonPath);
    expect(pkg.pi.extensions).toEqual([
      "./extensions/fetch.ts",
      "./extensions/enable-builtin-search.ts",
      "./extensions/repo-map.ts",
      "./extensions/read-block.ts",
      "./extensions/symbol-outline.ts",
      "./extensions/question.ts",
      "./extensions/questionnaire.ts",
      "./extensions/sourcegraph.ts",
    ]);

    for (const extension of pkg.pi.extensions) {
      expect(existsSync(join(repoRoot, extension))).toBe(true);
    }

    for (const removed of [
      "extensions/answer.ts",
      "extensions/basic-tools.ts",
      "extensions/basic-tools/question.ts",
      "extensions/basic-tools/settings.ts",
      "extensions/files.ts",
      "extensions/multi-edit.ts",
    ]) {
      expect(existsSync(join(repoRoot, removed))).toBe(false);
    }
  });

  test("uses the active @earendil-works pi package scope", async () => {
    const pkg = await readJson(packageJsonPath);
    expect(pkg.peerDependencies).toMatchObject({
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-tui": "*",
      "@sinclair/typebox": "*",
    });
    expect(pkg.devDependencies).toMatchObject({
      "@earendil-works/pi-ai": expect.any(String),
      "@earendil-works/pi-coding-agent": expect.any(String),
      "@earendil-works/pi-tui": expect.any(String),
    });

    const runtimeFiles = [
      packageJsonPath,
      join(repoRoot, "package-lock.json"),
      ...pkg.pi.extensions.map((extension: string) => join(repoRoot, extension)),
    ];
    const runtimeText = (await Promise.all(runtimeFiles.map((file) => readFile(file, "utf8").catch(() => "")))).join("\n");
    const oldPiScopeNeedle = "@mariozechner/" + "pi-";
    expect(runtimeText).not.toContain(oldPiScopeNeedle);
    expect(runtimeText).toContain("@earendil-works/pi-coding-agent");
  });
});
