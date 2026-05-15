import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import repoMapExtension from "../extensions/repo-map.ts";
import readBlockExtension from "../extensions/read-block.ts";
import symbolOutlineExtension from "../extensions/symbol-outline.ts";
import { builtinTool, createExtensionHost, withTempDir } from "./extension-host.ts";

function runRequired(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function plainTheme() {
  return {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function renderComponent(component: { render: (width: number) => string[] }) {
  return component.render(200).map((line) => line.trimEnd()).join("\n");
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

  test("returns the semantic block while collapsed UI shows a one-line summary", async () => {
    await withTempDir(async (dir) => {
      const body = Array.from({ length: 15 }, (_, index) => `  const value${index + 1} = ${index + 1};`);
      body[8] = "  return value8;";
      await writeFile(join(dir, "long.ts"), ["export function longBlock() {", ...body, "}", ""].join("\n"), "utf8");

      const host = createExtensionHost({ cwd: dir });
      readBlockExtension(host.api as any);
      const result = await host.runTool("read_block", { path: "long.ts", line: 10 });
      const text = result.content[0].text;

      expect(text).toContain("Anchor: L10 (line 10)");
      expect(text).toContain("Block: L1-L17 (brace block)");
      expect(text).toContain("L 1: export function longBlock() {");
      expect(text).toContain("L10:   return value8;");
      expect(text).toContain("L17: }");
      expect(text).not.toContain("Truncated:");
      expect(result.details.outputStart).toBe(1);
      expect(result.details.outputEnd).toBe(17);
      expect(result.details.outputLineCount).toBe(17);

      const tool = host.getTool("read_block");
      const call = renderComponent(tool.renderCall({ path: "long.ts", line: 10 }, plainTheme(), {}));
      expect(call).toBe("");

      const collapsed = renderComponent(tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme(), {}));
      expect(collapsed).toBe("read block long.ts:1-17 (to expand)");
      expect(collapsed).not.toContain("return value8");
      expect(collapsed).not.toContain("value1 = 1");
      expect(collapsed).not.toContain("value15 = 15");

      const expanded = renderComponent(tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme(), {}));
      expect(expanded).toContain("L 2:   const value1 = 1;");
      expect(expanded).toContain("L16:   const value15 = 15;");
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

describe("symbol_outline", () => {
  test("outlines top-level TypeScript symbols with read_block line anchors", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, "sample.ts"),
        [
          "export interface Shape {",
          "  kind: string;",
          "}",
          "",
          "export function area() {",
          "  return 1;",
          "}",
          "",
          "function helper() {",
          "  const nested = 1;",
          "  return nested;",
          "}",
          "",
          "export const gamma = 3;",
          "",
        ].join("\n"),
        "utf8",
      );

      const host = createExtensionHost({ cwd: dir });
      symbolOutlineExtension(host.api as any);
      readBlockExtension(host.api as any);

      const outline = await host.runTool("symbol_outline", { path: "sample.ts" });
      const text = outline.content[0].text;

      expect(text).toContain("File: sample.ts");
      expect(text).toContain("Blocks: 4");
      expect(text).toContain("[1] L1-L3 interface Shape (3 lines)");
      expect(text).toContain("read_block: line=1");
      expect(text).toContain("[2] L5-L7 function area (3 lines)");
      expect(text).toContain("read_block: line=5");
      expect(text).toContain("[4] L13-L14 const gamma (2 lines)");
      expect(text).not.toContain("nested");
      expect(outline.details.blocks.map((block: any) => block.name)).toEqual(["Shape", "area", "helper", "gamma"]);
      expect(outline.details.blocks[1].readBlock).toEqual({ path: "sample.ts", line: 5 });

      const area = await host.runTool("read_block", outline.details.blocks[1].readBlock);
      expect(area.content[0].text).toContain("Block: L5-L7 (brace block)");
      expect(area.content[0].text).toContain("L5: export function area() {");
    });
  });

  test("recognizes default exported declarations", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "defaults.ts"), "export default function run() {\n  return true;\n}\n\nexport default class Runner {\n}\n", "utf8");
      const host = createExtensionHost({ cwd: dir });
      symbolOutlineExtension(host.api as any);
      readBlockExtension(host.api as any);

      const outline = await host.runTool("symbol_outline", { path: "defaults.ts" });
      expect(outline.details.blocks.map((block: any) => block.name)).toEqual(["run", "Runner"]);
      expect(outline.content[0].text).toContain("[1] L1-L3 function run (3 lines)");
      expect(outline.content[0].text).toContain("[2] L5-L6 class Runner (2 lines)");

      const run = await host.runTool("read_block", { path: "defaults.ts", symbol: "run" });
      expect(run.content[0].text).toContain("Anchor: L1 (declaration 'run')");
    });
  });

  test("outlines Markdown headings as readable sections", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "notes.md"), "# Top\nintro\n\n## Target\nline a\n### Child\nline b\n\n## Next\nline c\n", "utf8");
      const host = createExtensionHost({ cwd: dir });
      symbolOutlineExtension(host.api as any);

      const result = await host.runTool("symbol_outline", { path: "notes.md" });
      const text = result.content[0].text;

      expect(text).toContain("Blocks: 4");
      expect(text).toContain("[1] L1-L10 heading h1 Top (10 lines)");
      expect(text).toContain("[2] L4-L8 heading h2 Target (5 lines)");
      expect(text).toContain("[3] L6-L8 heading h3 Child (3 lines)");
      expect(text).toContain("[4] L9-L10 heading h2 Next (2 lines)");
      expect(result.details.blocks[1]).toMatchObject({ kind: "heading", name: "Target", headingLevel: 2, anchorLine: 4, blockStart: 4, blockEnd: 8 });
    });
  });

  test("can include nested declarations on demand", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, "nested.ts"),
        [
          "export function outer() {",
          "  function inner() {",
          "    return 1;",
          "  }",
          "  const localValue = inner();",
          "  return localValue;",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      const host = createExtensionHost({ cwd: dir });
      symbolOutlineExtension(host.api as any);

      const topLevel = await host.runTool("symbol_outline", { path: "nested.ts" });
      expect(topLevel.details.blocks.map((block: any) => block.name)).toEqual(["outer"]);
      expect(topLevel.content[0].text).not.toContain("inner");

      const nested = await host.runTool("symbol_outline", { path: "nested.ts", includeNested: true });
      expect(nested.details.blocks.map((block: any) => block.name)).toEqual(["outer", "inner", "localValue"]);
      expect(nested.content[0].text).toContain("read_block: line=2");
      expect(nested.content[0].text).toContain("read_block: line=5");
    });
  });

  test("limits displayed blocks without dropping structured details", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "many.ts"), "export const one = 1;\nexport const two = 2;\nexport const three = 3;\n", "utf8");
      const host = createExtensionHost({ cwd: dir });
      symbolOutlineExtension(host.api as any);

      const result = await host.runTool("symbol_outline", { path: "many.ts", maxBlocks: 2 });
      const text = result.content[0].text;

      expect(text).toContain("Blocks: 3 (showing first 2)");
      expect(text).toContain("[1] L1-L1 const one (1 lines)");
      expect(text).toContain("[2] L2-L2 const two (1 lines)");
      expect(text).not.toContain("three");
      expect(result.details.blockCount).toBe(3);
      expect(result.details.displayedBlockCount).toBe(2);
      expect(result.details.truncated).toBe(true);
      expect(result.details.blocks[2].name).toBe("three");
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
