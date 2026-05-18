import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

// The recap tool is the channel for user-visible narration. Instead of asking
// the model to "write inline prose" — which depends on each provider's habit of
// emitting text vs thinking content — we accept the prose as a tool argument.
// The model only needs to know "to narrate to the user, call recap with text".
// We own the rendering.
//
// Empirically (see commit history and tests/message-shape-diagnostic.test.ts),
// Gemini and Kimi route nearly all their narration into hidden thinking
// traces; Claude tends to emit it as text. A tool-argument channel makes the
// narration uniform regardless of provider.

const recapSchema = Type.Object({
  text: Type.String({
    minLength: 1,
    description:
      "A short prose sentence (8-12 words) to share with the user. Forward-looking when used as a preamble before tool calls; recap-flavored when used between work segments. Tone: light, friendly, and curious — like a coding partner handing off work.",
  }),
});

const RECAP_SYSTEM_PROMPT = [
  "Recap discipline:",
  "Call the `recap` tool immediately before each batch of related tool calls. Pass `text` with a short forward-looking sentence (8-12 words) about what you are about to do. Place `recap` as the first tool in the parallel batch so it reads before the work.",
  "Call `recap` between work segments in longer multi-phase tasks. Pass `text` with a short sentence (8-12 words) recapping what just finished and where you are heading next.",
  "Combine related work into one `recap` call. One preamble per batch, one progress update per segment — never one `recap` per tool.",
  "Skip `recap` only for a single trivial action (one file read, one grep) where nothing is worth surfacing.",
  "Tone: light, friendly, and curious — like a coding partner handing off work.",
  "",
  "Example parallel batch (one assistant message, multiple tools fired together):",
  '  recap({ text: "Looking up where the renderer hooks into basic-tool grouping." })',
  '  grep({ pattern: "renderShell", path: "extensions/" })',
  '  read({ path: "extensions/basic-tool-grouping.ts" })',
  "",
  "More example `recap` calls:",
  '- `recap({ text: "Next, I\'ll patch the prompt and update the related tests." })`',
  '- `recap({ text: "Finished the renderer audit; moving on to the prompt rewrite." })`',
  '- `recap({ text: "Two extensions wired up. Now updating the tests to match." })`',
  '- `recap({ text: "Config and build script done — circling back to the README." })`',
].join("\n");

export default function recapExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", () => ({ systemPrompt: RECAP_SYSTEM_PROMPT }));

  pi.registerTool({
    name: "recap",
    label: "recap",
    description:
      "The user needs to know What is going on. Don't be too autistic! Send a short prose message (8-12 words) to the user. Call this as the first tool in any batch of related tool calls (forward-looking preamble), or between work segments in a longer task (recap + next step). The `text` argument is the message the user reads.",
    promptSnippet:
      "Call `recap({ text: '...' })` immediately before each batch of related tool calls (forward-looking preamble) and between work segments in longer tasks (recap + next step). One sentence, 8-12 words. Place `recap` first in the parallel batch.",
    promptGuidelines: [
      "Call `recap({ text })` immediately before each batch of related tool calls, and between work segments in longer multi-phase tasks.",
      "Place `recap` as the first tool in any parallel batch so the user reads the preamble before seeing the work.",
      "Keep `text` to 8-12 words, one sentence, light/friendly/curious tone.",
      "Combine related work into one `recap` call — one preamble per batch, one progress update per segment.",
      "Skip `recap` only for a single trivial action where nothing is worth surfacing.",
    ],
    parameters: recapSchema,
    renderShell: "self",
    renderCall(args: any, theme: any) {
      const text = typeof args?.text === "string" ? args.text.trim() : "";
      if (!text) return new Container();
      const styled = typeof theme?.italic === "function" ? theme.italic(text) : text;
      return new Text(styled, 1, 0);
    },
    renderResult() {
      // The visible prose comes from `renderCall(args.text)`. The result is a
      // pass-through; rendering it again would just duplicate the line.
      return new Container();
    },
    async execute(_toolCallId, params: { text: string }) {
      const text = String(params?.text ?? "").trim();
      return {
        content: [{ type: "text" as const, text }],
        details: { text },
      };
    },
  });
}
