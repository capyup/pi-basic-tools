import { describe, expect, test } from "bun:test";

import {
  DEFAULT_AUTO_COMPACT_CONFIG,
  normalizeAutoCompactConfig,
  normalizeCapyToolsSettings,
  normalizeWorkingMessageSettings,
} from "../extensions/capy-tools-config.ts";

describe("Capy Tools config", () => {
  test("normalizes legacy working-message language stored at top level", () => {
    const settings = normalizeCapyToolsSettings({ language: "zh" });
    expect(settings.workingMessage.language).toBe("zh");
    expect(settings.autoCompact).toEqual(DEFAULT_AUTO_COMPACT_CONFIG);
  });

  test("normalizes unified working-message and auto-compact settings", () => {
    const settings = normalizeCapyToolsSettings({
      workingMessage: { language: "Japanese" },
      autoCompact: {
        autoCompactPercent: 80,
        autoCompactTokenLimit: 0,
        keepRecentPercent: 20,
        strategy: "keep-bookends",
      },
    });

    expect(settings).toEqual({
      workingMessage: { language: "ja" },
      autoCompact: {
        autoCompactPercent: 80,
        autoCompactTokenLimit: 0,
        keepRecentPercent: 20,
        strategy: "keep-bookends",
      },
    });
  });

  test("falls back safely for invalid language and strategy values", () => {
    expect(normalizeWorkingMessageSettings({ language: "Martian" }).language).toBe("en");
    expect(normalizeAutoCompactConfig({ strategy: "delete-everything" }).strategy).toBe("keep-recent");
  });
});
