import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fetchExtension from "./fetch.ts";
import enableBuiltinSearchExtension from "./enable-builtin-search.ts";
import repoMapExtension from "./repo-map.ts";
import readBlockExtension from "./read-block.ts";
import symbolOutlineExtension from "./symbol-outline.ts";
import applyPatchExtension from "./apply-patch.ts";
import terminalSessionExtension from "./terminal-session.ts";
import askUserExtension from "./ask-user.ts";
import askQuestionExtension from "./ask-question.ts";
import askQuestionnaireExtension from "./ask-questionnaire.ts";
import sourcegraphExtension from "./sourcegraph.ts";
import workCheckpointExtension from "./work-checkpoint.ts";
import thinkingStepsExtension from "./thinking-steps/index.ts";
import todoExtension from "./todo/index.ts";

export default function piBasicToolsExtension(pi: ExtensionAPI): void {
  // Load all tools through one entrypoint so shared renderer state is truly shared.
  enableBuiltinSearchExtension(pi);
  fetchExtension(pi);
  repoMapExtension(pi);
  readBlockExtension(pi);
  symbolOutlineExtension(pi);
  applyPatchExtension(pi);
  terminalSessionExtension(pi);
  askUserExtension(pi);
  askQuestionExtension(pi);
  askQuestionnaireExtension(pi);
  sourcegraphExtension(pi);
  workCheckpointExtension(pi);
  thinkingStepsExtension(pi);
  todoExtension(pi);
}
