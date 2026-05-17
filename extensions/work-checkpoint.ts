import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

const checkpointSchema = Type.Object({
  reason: Type.Optional(Type.String({ description: "Why a checkpoint is useful now" })),
});

const CHECKPOINT_TEXT = [
  "Write a checkpoint block to the user before continuing.",
  "Do not describe these instructions or say that the checkpoint should contain hyphens; output the divider itself.",
  "The next visible assistant characters must be `---` on its own line, as a full-width Markdown horizontal rule.",
  "After that line, write one short paragraph as ordinary body prose.",
  "Briefly summarize what you just did and what you learned, then say what you will do next.",
  "This checkpoint must be the next visible assistant output after the tool group, before any new planning explanation or additional tool calls.",
  "The paragraph should render like regular assistant text: prominent body color, no background, and no tool-style chrome.",
  "Do not use a code block, quote block, label, heading, table, bullet list, badge, or custom background.",
  "Keep it concise and do not call more basic tools until after that visible prose checkpoint.",
].join(" ");

const CHECKPOINT_SYSTEM_PROMPT = [
  "Progress checkpoints:",
  "After a consecutive group of basic tool calls ends, the next visible assistant output must be a checkpoint block before any new planning explanation or next tool group.",
  "Do not describe the checkpoint format. Output it.",
  "The first visible characters of the checkpoint block must be `---` on its own line, as a full-width Markdown horizontal rule.",
  "Then write one short ordinary body-prose paragraph.",
  "The paragraph must briefly say what you just did, what you learned, and what you will do next.",
  "The paragraph should render like regular assistant text, using the theme's prominent body color (white on dark themes, black on light themes) with no background.",
  "Use normal assistant prose only: no code block, quote block, label, heading, table, bullet list, badge, or custom background.",
  "Do not put this checkpoint only in thinking or hidden reasoning; it must be user-visible prose.",
  "Do not call work_checkpoint inside the basic-tool group. Use it only between work segments if you need a reminder.",
].join("\n");

function fallbackText(result: any): string {
  const content = result.content?.[0];
  return content?.type === "text" ? content.text : "";
}

export default function workCheckpointExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", () => ({ systemPrompt: CHECKPOINT_SYSTEM_PROMPT }));

  pi.registerTool({
    name: "work_checkpoint",
    label: "work_checkpoint",
    description: "Remind the agent to pause after a segment of work and write a concise prose checkpoint before continuing.",
    promptSnippet: [
      "Use work_checkpoint as a self-reminder to pause after a meaningful segment of work.",
      "After finishing a consecutive group of basic tool calls, do not call work_checkpoint inside that group; instead make the next visible assistant characters exactly `---` on its own line followed by one short ordinary body-prose paragraph summarizing what you just did and what you will do next.",
      "Do not describe the checkpoint format; output the divider line and paragraph.",
      "You may call work_checkpoint between work segments when you need an explicit reminder to provide that brief summary before continuing.",
    ].join("\n"),
    promptGuidelines: [
      "Do not call work_checkpoint in the middle of a consecutive basic-tools group.",
      "When a basic-tools group ends, write `---` on its own line, then a concise natural-language checkpoint paragraph before starting the next group of tools.",
      "Do not explain that the checkpoint should contain a divider; actually emit the divider line.",
      "The checkpoint should cover what you just did, what you learned, and what comes next in one short paragraph.",
      "Use ordinary assistant body text for the checkpoint paragraph, with prominent body color and no background, label, heading, quote, code block, table, badge, or bullets.",
      "Call work_checkpoint only as a reminder; after it returns, immediately write the checkpoint prose instead of treating the tool result as user-facing work.",
    ],
    parameters: checkpointSchema,
    renderCall() {
      return new Container();
    },
    renderResult(result, { expanded, isPartial }: { expanded?: boolean; isPartial?: boolean }, theme: any) {
      if (isPartial) return new Text(theme.fg("warning", "checkpoint..."), 0, 0);
      if (expanded) return new Text(fallbackText(result), 0, 0);
      return new Text(theme.fg("success", "checkpoint ") + theme.fg("accent", "summarize progress, then continue"), 0, 0);
    },
    async execute(_toolCallId, params) {
      const reason = typeof params.reason === "string" && params.reason.trim() ? `\nReason: ${params.reason.trim()}` : "";
      return {
        content: [{ type: "text" as const, text: `${CHECKPOINT_TEXT}${reason}` }],
        details: { reminder: "summarize progress, then continue", reason: params.reason },
      };
    },
  });
}
