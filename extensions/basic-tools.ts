import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerQuestionTool } from "./basic-tools/question.ts";
import { applyToolSettings, registerBasicToolsSettingsCommand } from "./basic-tools/settings.ts";

export default function basicToolsExtension(pi: ExtensionAPI) {
  registerQuestionTool(pi);

  pi.on("session_start", () => applyToolSettings(pi));
  pi.on("resources_discover", () => applyToolSettings(pi));

  registerBasicToolsSettingsCommand(pi);
}
