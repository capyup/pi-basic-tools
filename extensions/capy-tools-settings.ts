import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  AUTO_COMPACT_PRESETS,
  DEFAULT_AUTO_COMPACT_CONFIG,
  KEEP_RECENT_PRESETS,
  STRATEGY_LABELS,
  getCapyToolsSettings,
  loadLanguageLabel,
  parseLanguage,
  restoreCapyToolsSettings,
  updateCapyToolsSettings,
  type CompactionStrategy,
} from "./capy-tools-config.ts";
import { formatAutoCompactStatus, persistAutoCompactConfig } from "./auto-compact.ts";

function formatSettingsSummary(): string {
  const settings = getCapyToolsSettings();
  return [
    `Working message language: ${loadLanguageLabel(settings.workingMessage.language)}`,
    `Auto-compact threshold: ${settings.autoCompact.autoCompactPercent}%`,
    `Keep recent budget:     ${settings.autoCompact.keepRecentPercent}%`,
    `Strategy:               ${STRATEGY_LABELS[settings.autoCompact.strategy]}`,
  ].join("\n");
}

async function setWorkingMessageLanguage(ctx: ExtensionContext, languageText: string): Promise<boolean> {
  const language = parseLanguage(languageText);
  if (!language) {
    ctx.ui.notify("Use English, Chinese, Japanese, Korean, or the short codes en, zh, ja, ko.", "warning");
    return false;
  }

  await updateCapyToolsSettings((settings) => ({ ...settings, workingMessage: { language } }));
  ctx.ui.notify(`Capy Tools language set to ${loadLanguageLabel(language)}.`, "info");
  return true;
}

async function openSettingsMenu(ctx: ExtensionContext): Promise<void> {
  await restoreCapyToolsSettings();

  while (true) {
    const settings = getCapyToolsSettings();
    const choice = await ctx.ui.select(
      `Capy Tools settings\n\n${formatSettingsSummary()}\n\nWhat would you like to change?`,
      [
        `Working message language [${loadLanguageLabel(settings.workingMessage.language)}]`,
        `Auto-compact threshold [${settings.autoCompact.autoCompactPercent}%]`,
        `Keep recent budget [${settings.autoCompact.keepRecentPercent}%]`,
        `Compaction strategy [${settings.autoCompact.strategy}]`,
        "Auto-compact status",
        "Reset auto-compact defaults",
        "Done",
      ],
    );

    if (!choice || choice === "Done") return;

    if (choice.startsWith("Working message language")) {
      const picked = await ctx.ui.select(
        "Working message language",
        ["English", "Chinese", "Japanese", "Korean"].map((label) =>
          label === loadLanguageLabel(settings.workingMessage.language) ? `${label} ✓` : label,
        ),
      );
      if (picked) await setWorkingMessageLanguage(ctx, picked.replace(/\s+✓$/, ""));
      continue;
    }

    if (choice.startsWith("Auto-compact threshold")) {
      const picked = await ctx.ui.select(
        "Auto-compact threshold (% of context window)",
        AUTO_COMPACT_PRESETS.map((preset) => `${preset}%${preset === settings.autoCompact.autoCompactPercent ? " ✓" : ""}`),
      );
      if (picked) {
        const autoCompactPercent = parseInt(picked, 10);
        if (!Number.isNaN(autoCompactPercent)) {
          await persistAutoCompactConfig({ autoCompactPercent });
          ctx.ui.notify(`Auto-compact threshold set to ${autoCompactPercent}%.`, "info");
        }
      }
      continue;
    }

    if (choice.startsWith("Keep recent budget")) {
      const picked = await ctx.ui.select(
        "Keep recent budget (% of context window to preserve)",
        KEEP_RECENT_PRESETS.map((preset) => `${preset}%${preset === settings.autoCompact.keepRecentPercent ? " ✓" : ""}`),
      );
      if (picked) {
        const keepRecentPercent = parseInt(picked, 10);
        if (!Number.isNaN(keepRecentPercent)) {
          await persistAutoCompactConfig({ keepRecentPercent });
          ctx.ui.notify(`Keep recent budget set to ${keepRecentPercent}%.`, "info");
        }
      }
      continue;
    }

    if (choice.startsWith("Compaction strategy")) {
      const strategies = Object.entries(STRATEGY_LABELS) as Array<[CompactionStrategy, string]>;
      const picked = await ctx.ui.select(
        "Compaction strategy",
        strategies.map(([key, label]) => `${label}${key === settings.autoCompact.strategy ? " ✓" : ""}`),
      );
      if (picked) {
        const entry = strategies.find(([, label]) => picked.startsWith(label));
        if (entry) {
          await persistAutoCompactConfig({ strategy: entry[0] });
          ctx.ui.notify(`Compaction strategy set to ${entry[1]}.`, "info");
        }
      }
      continue;
    }

    if (choice === "Auto-compact status") {
      ctx.ui.notify(formatAutoCompactStatus(ctx), "info");
      continue;
    }

    if (choice === "Reset auto-compact defaults") {
      const ok = await ctx.ui.confirm(
        "Reset auto-compact defaults?",
        "This resets only the auto-compact section. Working-message language is preserved.",
      );
      if (ok) {
        await persistAutoCompactConfig({ ...DEFAULT_AUTO_COMPACT_CONFIG });
        ctx.ui.notify("Auto-compact settings reset to defaults.", "info");
      }
    }
  }
}

export default function capyToolsSettingsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("capy-tools-settings", {
    description: "Open the Capy Tools settings panel.",
    getArgumentCompletions: (prefix: string) => {
      const values = ["settings", "status", "reset-auto-compact", "en", "zh", "ja", "ko", "English", "Chinese", "Japanese", "Korean"];
      return values.filter((value) => value.toLowerCase().startsWith(prefix.toLowerCase())).map((value) => ({ value }));
    },
    handler: async (args, ctx) => {
      await restoreCapyToolsSettings();
      const trimmed = args.trim();

      if (!trimmed || trimmed === "settings") {
        await openSettingsMenu(ctx);
        return;
      }

      if (trimmed === "status" || trimmed === "auto-compact status") {
        ctx.ui.notify(formatAutoCompactStatus(ctx), "info");
        return;
      }

      if (trimmed === "reset-auto-compact" || trimmed === "auto-compact reset") {
        await persistAutoCompactConfig({ ...DEFAULT_AUTO_COMPACT_CONFIG });
        ctx.ui.notify("Auto-compact settings reset to defaults.", "info");
        return;
      }

      if (await setWorkingMessageLanguage(ctx, trimmed)) return;

      ctx.ui.notify("Usage: /capy-tools-settings [settings|status|reset-auto-compact|en|zh|ja|ko]", "warning");
    },
  });
}
