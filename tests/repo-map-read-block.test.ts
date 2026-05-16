import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
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
    bg: (_name: string, text: string) => text,
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function taggingTheme() {
  return {
    bg: (color: string, text: string) => `<bg:${color}>${text}</bg:${color}>`,
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `<b>${text}</b>`,
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

      const tool = host.getTool("repo_map");
      expect(renderComponent(tool.renderCall({ path: "." }, plainTheme(), {}))).toBe("");
      const collapsed = renderComponent(tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme(), {}));
      expect(collapsed).toContain("Map pi-basic-tools-test-");
      expect(collapsed).toContain("(to expand)");
      expect(collapsed).not.toContain("src/main.ts");
      const expanded = renderComponent(tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme(), {}));
      expect(expanded).toContain("Map pi-basic-tools-test-");
      expect(expanded).not.toContain("src/main.ts");
      expect(result.content[0].text).toContain("src/main.ts");
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
      expect(collapsed).toBe("Read long.ts:1-17\n(to expand)");
      expect(collapsed).not.toContain("return value8");
      expect(collapsed).not.toContain("value1 = 1");
      expect(collapsed).not.toContain("value15 = 15");

      const expanded = renderComponent(tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme(), {}));
      expect(expanded).toContain("Read long.ts:1-17");
      expect(expanded).not.toContain("L 2:   const value1 = 1;");
      expect(result.content[0].text).toContain("L16:   const value15 = 15;");
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

  test("guidance discourages repeated adjacent block scanning", () => {
    const host = createExtensionHost();
    readBlockExtension(host.api as any);
    const tool = host.getTool("read_block");
    expect(tool.description).toContain("not sequential file scanning");
    expect(tool.promptGuidelines.join("\n")).toContain("Do not call read_block repeatedly on many nearby lines");
    expect(tool.promptGuidelines.join("\n")).toContain("use read with offset/limit");
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

      const tool = host.getTool("symbol_outline");
      expect(renderComponent(tool.renderCall({ path: "sample.ts" }, plainTheme(), {}))).toBe("");
      const collapsed = renderComponent(tool.renderResult(outline, { expanded: false, isPartial: false }, plainTheme(), {}));
      expect(collapsed).toBe("Outline sample.ts\n(to expand)");
      expect(collapsed).not.toContain("export function area");
      const expanded = renderComponent(tool.renderResult(outline, { expanded: true, isPartial: false }, plainTheme(), {}));
      expect(expanded).toContain("Outline sample.ts");
      expect(expanded).not.toContain("[2] L5-L7 function area (3 lines)");
      expect(outline.content[0].text).toContain("[2] L5-L7 function area (3 lines)");
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

  test("outlines CSS rules as readable blocks", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, "book.css"),
        [
          ":root {",
          "  --page: white;",
          "}",
          "",
          ".book-page {",
          "  color: black;",
          "}",
          "",
          "@media (max-width: 700px) {",
          "  .book-page {",
          "    padding: 1rem;",
          "  }",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      const host = createExtensionHost({ cwd: dir });
      symbolOutlineExtension(host.api as any);

      const result = await host.runTool("symbol_outline", { path: "book.css" });
      const text = result.content[0].text;

      expect(text).toContain("Blocks: 3");
      expect(text).toContain("css-rule :root");
      expect(text).toContain("css-rule .book-page");
      expect(text).toContain("css-rule @media (max-width: 700px)");
      expect(result.details.blocks.map((block: any) => block.name)).toEqual([":root", ".book-page", "@media (max-width: 700px)"]);
      expect(result.details.blocks[1].readBlock).toEqual({ path: "book.css", line: 5 });
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

    for (const name of ["grep", "find", "ls"]) {
      const tool = defaultHost.getTool(name);
      expect(renderComponent(tool.renderCall({}, plainTheme(), {}))).toBe("");
    }
    const grepResult = { content: [{ type: "text", text: "a.ts:1: match\nb.ts:2: match" }], details: {} };
    expect(renderComponent(defaultHost.getTool("grep").renderResult(grepResult, { expanded: false, isPartial: false }, plainTheme(), {}))).toBe("Search results\n(to expand)");
    expect(renderComponent(defaultHost.getTool("grep").renderResult(grepResult, { expanded: true, isPartial: false }, plainTheme(), {}))).not.toContain("a.ts:1: match");
    expect(grepResult.content[0].text).toContain("a.ts:1: match");

    const noBuiltinHost = createExtensionHost({ activeTools: ["sourcegraph"], allTools });
    enableBuiltinSearchExtension(noBuiltinHost.api as any);
    await noBuiltinHost.emit("resources_discover");
    expect(noBuiltinHost.activeTools).toEqual(["sourcegraph"]);
  });

  test("groups consecutive basic tool renderers and splits on non-basic tool boundaries", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "job"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const grep = host.getTool("grep");
    const find = host.getTool("find");
    const ls = host.getTool("ls");
    const headContext = { toolCallId: "grep-1", executionStarted: true, expanded: false, invalidate() {} };
    const findContext = { toolCallId: "find-1", executionStarted: true, expanded: false, invalidate() {} };

    await host.emit("message_update", { message: { content: [{ type: "toolCall", id: "grep-1", name: "grep", arguments: { pattern: "renderResult", path: "extensions" } }] } });
    await host.emit("message_update", {
      message: {
        content: [
          { type: "toolCall", id: "grep-1", name: "grep", arguments: { pattern: "renderResult", path: "extensions" } },
          { type: "toolCall", id: "find-1", name: "find", arguments: { pattern: "*.ts", path: "extensions" } },
        ],
      },
    });

    const supersededHead = renderComponent(grep.renderCall({ pattern: "renderResult", path: "extensions" }, plainTheme(), headContext));
    expect(supersededHead).toContain("Search");
    expect(supersededHead).toContain("renderResult");
    expect(supersededHead).not.toContain("TOOLS");

    const grouped = renderComponent(find.renderCall({ pattern: "*.ts", path: "extensions" }, plainTheme(), findContext));
    expect(grouped).toContain("Explored 2 targets");
    expect(grouped).toContain("Find");
    expect(grouped).toContain("*.ts");

    await host.emit("tool_execution_start", { toolName: "job", toolCallId: "job-1", args: {} });
    const nextGroup = renderComponent(ls.renderCall({ path: "." }, plainTheme(), { toolCallId: "ls-1", executionStarted: true, expanded: false, invalidate() {} }));
    expect(nextGroup).toContain("List");
    expect(nextGroup).not.toContain("grep");
  });

  test("keeps grouping across continuation lifecycle events inside one agent run", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const grep = host.getTool("grep");
    const find = host.getTool("find");
    const grepContext = { toolCallId: "grep-cont", executionStarted: true, expanded: false, invalidate() {} };
    const findContext = { toolCallId: "find-cont", executionStarted: true, expanded: false, invalidate() {} };

    renderComponent(grep.renderCall({ pattern: "alpha" }, plainTheme(), grepContext));
    await host.emit("turn_start", { turnIndex: 2 });
    await host.emit("agent_start", {});
    const grouped = renderComponent(find.renderCall({ pattern: "beta" }, plainTheme(), findContext));
    expect(grouped).toContain("Find");
    expect(grouped).toContain("beta");
  });

  test("does not duplicate tool names while streaming incomplete args", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const grep = host.getTool("grep");
    const rendered = renderComponent(grep.renderCall({}, plainTheme(), { toolCallId: "grep-empty", executionStarted: true, expanded: false, invalidate() {} }));
    expect(rendered).toContain("Search");
    expect(rendered).not.toContain("grep grep");
  });

  test("does not split groups when tool_execution_start lacks a recognizable tool name", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const grep = host.getTool("grep");
    const find = host.getTool("find");
    const firstContext = { toolCallId: "grep-one", executionStarted: true, expanded: false, invalidate() {} };
    const secondContext = { toolCallId: "find-two", executionStarted: true, expanded: false, invalidate() {} };

    renderComponent(grep.renderCall({ pattern: "alpha" }, plainTheme(), firstContext));
    await host.emit("tool_execution_start", { id: "find-two" });
    const grouped = renderComponent(find.renderCall({ pattern: "beta" }, plainTheme(), secondContext));

    expect(grouped).toContain("Find");
    expect(grouped).toContain("beta");
  });

  test("keeps an open group when partial message updates only include the latest tool call", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const grep = host.getTool("grep");
    const find = host.getTool("find");
    const firstContext = { toolCallId: "grep-partial", executionStarted: true, expanded: false, invalidate() {} };
    const secondContext = { toolCallId: "find-partial", executionStarted: true, expanded: false, invalidate() {} };

    renderComponent(grep.renderCall({ pattern: "alpha" }, plainTheme(), firstContext));
    await host.emit("message_update", { message: { content: [{ type: "toolCall", id: "find-partial", name: "find", arguments: { pattern: "beta" } }] } });
    const grouped = renderComponent(find.renderCall({ pattern: "beta" }, plainTheme(), secondContext));

    expect(grouped).toContain("Find");
    expect(grouped).toContain("beta");
  });

  test("renders a group from only one row when the latest call has a result", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const grep = host.getTool("grep");
    const context = { toolCallId: "grep-result", executionStarted: true, expanded: false, invalidate() {} };
    const call = renderComponent(grep.renderCall({ pattern: "alpha" }, plainTheme(), context));
    const result = renderComponent(grep.renderResult({ content: [{ type: "text", text: "file.ts:1: alpha" }] }, { expanded: false, isPartial: false }, plainTheme(), context));

    expect(call).toContain("Search");
    expect(call).toContain("alpha");
    expect(result).toBe("");
  });

  test("closes a group after assistant text so later tools do not include earlier calls", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const grep = host.getTool("grep");
    const find = host.getTool("find");
    renderComponent(grep.renderCall({ pattern: "old" }, plainTheme(), { toolCallId: "old-grep", executionStarted: true, expanded: false, invalidate() {} }));
    renderComponent(find.renderCall({ pattern: "old-find" }, plainTheme(), { toolCallId: "old-find", executionStarted: true, expanded: false, invalidate() {} }));

    await host.emit("message_update", { message: { content: [{ type: "text", text: "Done with the old sequence." }] } });

    const next = renderComponent(grep.renderCall({ pattern: "fresh" }, plainTheme(), { toolCallId: "fresh-grep", executionStarted: true, expanded: false, invalidate() {} }));
    expect(next).toContain("Search");
    expect(next).toContain("fresh");
    expect(next).not.toContain("old");
  });

  test("invalidates the previous visible row when a newer tool owns the group", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const grep = host.getTool("grep");
    const find = host.getTool("find");
    let invalidated = false;
    const firstContext = { toolCallId: "visible-grep", executionStarted: true, expanded: false, invalidate() { invalidated = true; } };
    const secondContext = { toolCallId: "visible-find", executionStarted: true, expanded: false, invalidate() {} };

    expect(renderComponent(grep.renderCall({ pattern: "alpha" }, plainTheme(), firstContext))).toContain("Search");
    const latest = renderComponent(find.renderCall({ pattern: "beta" }, plainTheme(), secondContext));

    expect(invalidated).toBe(true);
    expect(latest).toContain("Find");
    expect(latest).toContain("beta");
    const superseded = renderComponent(grep.renderCall({ pattern: "alpha" }, plainTheme(), firstContext));
    expect(superseded).toContain("Search");
    expect(superseded).toContain("alpha");
  });

  test("updates the Codex-style call row after the result arrives", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const bash = host.getTool("bash");
    let invalidated = false;
    const context = { toolCallId: "bash-result", executionStarted: true, expanded: false, invalidate() { invalidated = true; } };
    const component = bash.renderCall({ command: "echo codex-style" }, plainTheme(), context);
    expect(renderComponent(component)).toContain("Ran echo codex-style");

    const result = renderComponent(bash.renderResult({ content: [{ type: "text", text: "codex-style\n" }] }, { expanded: false, isPartial: false }, plainTheme(), context));

    expect(result).toBe("");
    expect(invalidated).toBe(false);
    // After the result arrives the detail is folded inline into the per-call
    // headline (`• Ran <cmd> · 1 output lines`), so we look for it there
    // rather than as a `└` child row.
    expect(renderComponent(component)).toContain("1 output lines");
    expect(renderComponent(component)).toContain("Ran echo codex-style");
  });

  test("summarizes grouped command tools with a natural Codex-style title", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const bash = host.getTool("bash");
    renderComponent(bash.renderCall({ command: "pwd" }, plainTheme(), { toolCallId: "bash-title-1", executionStarted: true, expanded: false, invalidate() {} }));
    const grouped = renderComponent(bash.renderCall({ command: "ls" }, plainTheme(), { toolCallId: "bash-title-2", executionStarted: true, expanded: false, invalidate() {} }));

    expect(grouped).toContain("Ran 2 commands");
    expect(grouped).toContain("Ran pwd");
    expect(grouped).toContain("Ran ls");
    expect(grouped).not.toContain("TOOLS");
  });

  test("limits Codex-style action continuation to four aligned guide lines and hides raw output details", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const bash = host.getTool("bash");
    const context = { toolCallId: "bash-many-lines", executionStarted: true, expanded: false, invalidate() {} };
    const component = bash.renderCall({ command: "printf many words that should wrap through the guide rail and then stop after four continuation rows" }, plainTheme(), context);
    const callLines = component.render(34);

    expect(callLines.filter((line) => line.startsWith("  │ ")).length).toBeLessThanOrEqual(4);
    expect(callLines.every((line) => line.startsWith("• ") || line.startsWith("◐ ") || line.startsWith("  │ "))).toBe(true);

    const output = Array.from({ length: 12 }, (_value, index) => `line-${index + 1}`).join("\n");
    renderComponent(bash.renderResult({ content: [{ type: "text", text: output }] }, { expanded: false, isPartial: false }, plainTheme(), context));
    const rendered = renderComponent(component);

    // Per-call render is single-line now; the "12 output lines" detail is rolled
    // into the headline via ` · ` and may wrap into the continuation rail. The
    // critical invariant is that raw output never reaches the per-call surface.
    expect(rendered).toContain("output lines");
    expect(rendered).not.toContain("line-1");
    expect(rendered).not.toContain("  └ ");
  });

  test("leaves edit and write renderers on the built-in preview path", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const edit = host.getTool("edit");
    const write = host.getTool("write");
    const editRendered = renderComponent(edit.renderCall(
      { path: "sample.ts", edits: [{ oldText: "old", newText: "new" }] },
      plainTheme(),
      { toolCallId: "edit-default", state: {}, cwd: process.cwd(), argsComplete: false, invalidate() {} },
    ));
    const writeRendered = renderComponent(write.renderCall(
      { path: "sample.ts", content: "hello\n" },
      plainTheme(),
      { toolCallId: "write-default", lastComponent: undefined, argsComplete: false, expanded: false, isPartial: false },
    ));

    expect(editRendered).toContain("edit");
    expect(writeRendered).toContain("write");
    expect(editRendered).not.toContain("• Edited");
    expect(writeRendered).not.toContain("• Edited");
  });

  test("preserves call details when later streaming updates have incomplete args", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const grep = host.getTool("grep");
    const context = { toolCallId: "merge-grep", executionStarted: true, expanded: false, invalidate() {} };
    renderComponent(grep.renderCall({ pattern: "kept-pattern" }, plainTheme(), context));
    await host.emit("message_update", { message: { content: [{ type: "toolCall", id: "merge-grep", name: "grep", arguments: {} }] } });
    const grouped = renderComponent(grep.renderCall({}, plainTheme(), context));

    expect(grouped).toContain("kept-pattern");
  });

  test("clips compact basic tool rows to the render width", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const bash = host.getTool("bash");
    const component = bash.renderCall(
      { command: "echo this-is-a-long-command-that-should-use-the-real-render-width-before-clipping" },
      plainTheme(),
      { toolCallId: "long-bash", executionStarted: true, expanded: false, invalidate() {} },
    );
    const [line] = component.render(48);

    expect(visibleWidth(line)).toBeLessThanOrEqual(48);
    expect(line).toContain("echo this-is-a-long-command");
  });

  test("bounds collapsed groups without earlier-call filler", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);
    const grep = host.getTool("grep");

    let latest = "";
    for (let index = 0; index < 20; index += 1) {
      latest = renderComponent(grep.renderCall({ pattern: `needle-${index}` }, plainTheme(), { toolCallId: `grep-${index}`, executionStarted: true, expanded: false, invalidate() {} }));
    }

    expect(latest).toContain("Search");
    expect(latest).toContain("needle-19");
    expect(latest).not.toContain("needle-0");
  });

  test("starts a fresh bounded group after the safety cap", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);
    const grep = host.getTool("grep");

    let latest = "";
    for (let index = 0; index < 13; index += 1) {
      latest = renderComponent(grep.renderCall({ pattern: `cap-${index}` }, plainTheme(), { toolCallId: `cap-grep-${index}`, executionStarted: true, expanded: false, invalidate() {} }));
    }

    expect(latest).toContain("Search");
    expect(latest).toContain("cap-12");
    expect(latest).not.toContain("cap-0");
  });

  test("treats work_checkpoint as a non-basic boundary outside grouped tools", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const workCheckpointExtension = (await import("../extensions/work-checkpoint.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "work_checkpoint"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);
    workCheckpointExtension(host.api as any);

    const grep = host.getTool("grep");
    const find = host.getTool("find");
    renderComponent(grep.renderCall({ pattern: "before-checkpoint" }, plainTheme(), { toolCallId: "checkpoint-grep", executionStarted: true, expanded: false, invalidate() {} }));

    await host.emit("tool_execution_start", { toolName: "work_checkpoint", toolCallId: "checkpoint", args: {} });
    const next = renderComponent(find.renderCall({ pattern: "after-checkpoint" }, plainTheme(), { toolCallId: "checkpoint-find", executionStarted: true, expanded: false, invalidate() {} }));

    expect(next).toContain("after-checkpoint");
    expect(next).not.toContain("before-checkpoint");
    expect(next).not.toContain("TOOLS");
  });

  test("compacts FFF plugin search results before their renderer can dump raw output", async () => {
    const { compactExternalBasicToolResult } = await import("../extensions/basic-tool-grouping.ts");

    const compacted = compactExternalBasicToolResult({
      toolName: "ffgrep",
      input: { pattern: "ExtensionAPI", path: "extensions/" },
      content: [{ type: "text", text: "extensions/index.ts\n 1: import ExtensionAPI\n\nextensions/fetch.ts\n 2: import ExtensionAPI" }],
      details: { totalMatched: 10, totalFiles: 4 },
    });

    expect(compacted?.content[0].text).toBe("Search ExtensionAPI in extensions/ · 10 results in 4 files");
    expect(compacted?.content[0].text).not.toContain("extensions/index.ts");
    expect((compacted?.details as any).compactedForDisplay).toBe(true);
  });

  test("skips optional FFF compatibility when those plugin tools are absent", async () => {
    const { compactExternalBasicToolResult } = await import("../extensions/basic-tool-grouping.ts");

    expect(compactExternalBasicToolResult({
      toolName: "grep",
      input: { pattern: "ExtensionAPI" },
      content: [{ type: "text", text: "extensions/index.ts:1: ExtensionAPI" }],
      details: { totalMatched: 1 },
    })).toBeUndefined();

    expect(compactExternalBasicToolResult({
      input: { pattern: "ExtensionAPI" },
      content: [{ type: "text", text: "missing toolName should be ignored" }],
    })).toBeUndefined();
  });

  test("done basic-tool item line renders headline text in muted (not accent)", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const bash = host.getTool("bash");
    const theme = taggingTheme();
    const context = { toolCallId: "bash-color", executionStarted: true, expanded: false, invalidate() {} };
    const component = bash.renderCall({ command: "git status" }, theme, context);
    bash.renderResult({ content: [{ type: "text", text: "" }] }, { expanded: false, isPartial: false }, theme, context);

    const rendered = renderComponent(component);
    expect(rendered).toMatch(/<muted>Ran git status[^<]*<\/muted>/);
    expect(rendered).not.toMatch(/<accent>Ran git status[^<]*<\/accent>/);
  });

  test("running basic-tool item uses warning ◐ marker with muted headline text", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const bash = host.getTool("bash");
    const theme = taggingTheme();
    const context = { toolCallId: "bash-running", executionStarted: true, expanded: false, invalidate() {} };
    const component = bash.renderCall({ command: "sleep 10" }, theme, context);
    const rendered = renderComponent(component);

    expect(rendered).toContain("<warning>◐</warning>");
    expect(rendered).toMatch(/<muted>Ran [^<]+<\/muted>/);
    expect(rendered).not.toContain("<accent>");
  });

  test("errored basic-tool item uses error ! marker and error-colored headline text", async () => {
    const enableBuiltinSearchExtension = (await import("../extensions/enable-builtin-search.ts")).default;
    const { resetBasicToolGroupingForTests } = await import("../extensions/basic-tool-grouping.ts");
    resetBasicToolGroupingForTests();

    const allTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map(builtinTool);
    const host = createExtensionHost({ activeTools: ["read", "bash", "edit", "write"], allTools });
    enableBuiltinSearchExtension(host.api as any);

    const bash = host.getTool("bash");
    const theme = taggingTheme();
    const context = { toolCallId: "bash-error", executionStarted: true, expanded: false, invalidate() {} };
    const component = bash.renderCall({ command: "false" }, theme, context);
    bash.renderResult({ content: [{ type: "text", text: "" }], isError: true }, { expanded: false, isPartial: false }, theme, context);

    const rendered = renderComponent(component);
    expect(rendered).toContain("<error>!</error>");
    expect(rendered).toMatch(/<error>Ran [^<]+<\/error>/);
  });
});
