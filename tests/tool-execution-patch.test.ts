import { describe, expect, test } from "bun:test";
import { isVisuallyEmptyLine, shouldHideRenderedLines } from "../extensions/tool-execution-patch.ts";

// Build a raw SGR sequence (ESC [ ... m) without putting the escape character
// directly in source. Bun source files normalize to NFC and stripping it via
// the regex is what the patch relies on at runtime.
const ESC = String.fromCharCode(0x1b);
const RED = `${ESC}[31m`;
const RESET = `${ESC}[0m`;

describe("isVisuallyEmptyLine", () => {
  test("returns true for the empty string", () => {
    expect(isVisuallyEmptyLine("")).toBe(true);
  });

  test("returns true for whitespace-only lines", () => {
    expect(isVisuallyEmptyLine("   ")).toBe(true);
    expect(isVisuallyEmptyLine("\t \t")).toBe(true);
  });

  test("returns true for ANSI-only lines with no glyphs", () => {
    expect(isVisuallyEmptyLine(`${RED}${RESET}`)).toBe(true);
    expect(isVisuallyEmptyLine(`${RED}   ${RESET}`)).toBe(true);
  });

  test("returns false when any visible character is present", () => {
    expect(isVisuallyEmptyLine("hello")).toBe(false);
    expect(isVisuallyEmptyLine(`${RED}x${RESET}`)).toBe(false);
    expect(isVisuallyEmptyLine("·")).toBe(false);
  });
});

describe("shouldHideRenderedLines", () => {
  test("returns false for an empty render result (component already invisible)", () => {
    expect(shouldHideRenderedLines([])).toBe(false);
  });

  test("returns true when every line is visually empty (the Spacer-only case)", () => {
    expect(shouldHideRenderedLines([""])).toBe(true);
    expect(shouldHideRenderedLines(["", ""])).toBe(true);
    expect(shouldHideRenderedLines([`${RED}${RESET}`, "   "])).toBe(true);
  });

  test("returns false as soon as any line has visible content", () => {
    expect(shouldHideRenderedLines(["", "Explored 3 targets"])).toBe(false);
    expect(shouldHideRenderedLines(["Used 9 tools", ""])).toBe(false);
    expect(shouldHideRenderedLines(["Map ."])).toBe(false);
  });
});
