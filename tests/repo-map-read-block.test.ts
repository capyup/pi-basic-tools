import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import repoMapExtension from "../extensions/repo-map.ts";
import readBlockExtension from "../extensions/read-block.ts";
import { builtinTool, createExtensionHost, withTempDir } from "./extension-host.ts";

function runRequired(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

describe("repo_map", () => {
  test("summarizes a real git repository with manifests, languages, status, and recent files", async () => {
    await withTempDir(async (dir) => {
      runRequired("git", ["init"], dir);
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module", scripts: { test: "bun test" } }, null, 2), "utf8");
      await writeFile(join(dir, "README.md"), "# Fixture\n", "utf8");
      await writeFile(join(dir, "src", "main.ts"), "export function hello() {\n  return 'world';\n}\n", "utf8");
      runRequired("git", ["add", "package.json", "README.md", "src/main.ts"], dir);

      const host = createExtensionHost({ cwd: dir });
      repoMapExtension(host.api as any);
      const result = await host.runTool("repo_map", { path: ".", depth: 3, maxFiles: 50, maxRecent: 10 });
      const text = result.content[0].text;

      expect(text).toContain("# repo_map:");
      expect(text).toContain(`Root: ${dir}`);
      expect(text).toContain("Git:");
      expect(text).toContain("package: fixture");
      expect(text).toContain("TypeScript: 1 files");
      expect(text).toContain("README.md");
      expect(text).toContain("src/main.ts");
      expect(result.details.root).toBe(dir);
      expect(result.details.git.tracked).toContain("src/main.ts");
      expect(result.details.status.some((line: string) => line.includes("src/main.ts"))).toBe(true);
    });
  });
});

describe("read_block", () => {
  test("reads the enclosing TypeScript function by symbol", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "sample.ts");
      await writeFile(
        file,
        "export function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  const value = 2;\n  return value;\n}\n\nexport const gamma = 3;\n",
        "utf8",
      );

      const host = createExtensionHost({ cwd: dir });
      readBlockExtension(host.api as any);
      const result = await host.runTool("read_block", { path: "sample.ts", symbol: "beta", context: 0 });
      const text = result.content[0].text;

      expect(text).toContain("Anchor: L5 (declaration 'beta')");
      expect(text).toContain("Block: L5-L8 (brace block)");
      expect(text).toContain("L5: export function beta() {");
      expect(text).toContain("L7:   return value;");
      expect(text).not.toContain("alpha()");
      expect(result.details.blockStart).toBe(5);
      expect(result.details.blockEnd).toBe(8);
    });
  });

  test("defaults to a nine-line window around the anchor in long blocks", async () => {
    await withTempDir(async (dir) => {
      const body = Array.from({ length: 15 }, (_, index) => `  const value${index + 1} = ${index + 1};`);
      body[7] = "  const target = 8;";
      await writeFile(join(dir, "long.ts"), ["export function longBlock() {", ...body, "}", ""].join("\n"), "utf8");

      const host = createExtensionHost({ cwd: dir });
      readBlockExtension(host.api as any);
      const result = await host.runTool("read_block", { path: "long.ts", symbol: "target" });
      const text = result.content[0].text;

      expect(text).toContain("Anchor: L9 (declaration 'target')");
      expect(text).toContain("Truncated: showing L5-L13");
      expect(text).toContain("L 5:   const value4 = 4;");
      expect(text).toContain("L 9:   const target = 8;");
      expect(text).toContain("L13:   const value12 = 12;");
      expect(text).not.toContain("L 4:   const value3 = 3;");
      expect(text).not.toContain("L14:   const value13 = 13;");
      expect(result.details.outputStart).toBe(5);
      expect(result.details.outputEnd).toBe(13);
    });
  });

  test("reads a Markdown section by heading", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "notes.md"), "# Top\nintro\n\n## Target\nline a\nline b\n\n## Next\nline c\n", "utf8");
      const host = createExtensionHost({ cwd: dir });
      readBlockExtension(host.api as any);
      const result = await host.runTool("read_block", { path: "notes.md", symbol: "Target", mode: "auto" });
      const text = result.content[0].text;

      expect(text).toContain("Block: L4-L7 (markdown heading level 2)");
      expect(text).toContain("L4: ## Target");
      expect(text).toContain("L6: line b");
      expect(text).not.toContain("line c");
    });
  });

  test("rejects invalid mode and missing symbols", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "sample.ts"), "export const present = true;\n", "utf8");
      const host = createExtensionHost({ cwd: dir });
      readBlockExtension(host.api as any);

      await expect(host.runTool("read_block", { path: "sample.ts", symbol: "present", mode: "sideways" })).rejects.toThrow("mode must be one of");
      await expect(host.runTool("read_block", { path: "sample.ts", symbol: "missing" })).rejects.toThrow("Could not find symbol or text 'missing'");
      await expect(host.runTool("read_block", { path: "sample.ts", line: 20 })).rejects.toThrow("outside file range");
    });
  });
});

describe("enable-builtin-search", () => {
  test("adds grep/find/ls only when default builtins are active", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "sourcegraph"].map(builtinTool);

    const defaultHost = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(defaultHost.api as any);
    await defaultHost.emit("session_start");
    expect(defaultHost.activeTools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);

    const noBuiltinHost = createExtensionHost({ activeTools: ["sourcegraph"], allTools });
    enableBuiltinSearchExtension(noBuiltinHost.api as any);
    await noBuiltinHost.emit("resources_discover");
    expect(noBuiltinHost.activeTools).toEqual(["sourcegraph"]);
  });
});
