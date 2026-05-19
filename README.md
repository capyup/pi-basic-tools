# Capy Tools

Capy Tools is a capybara-flavoured toolkit for pi. The npm package remains `@capyup/pi-basic-tools` for compatibility, but the plugin/repo brand is Capy Tools.

This package bundles a practical set of editing, fetch, web-reference, compact basic-tool UI, todo, proactive auto-compaction, working-message, and built-in search activation extensions split out from `pi-goodstuff`.

## Included extensions

- `fetch`
- `enable-builtin-search` (activates pi's built-in `grep`, `find`, and `ls` tools)
- `repo-map` (`repo_map` tool)
- `read-block` (`read_block` tool)
- `symbol-outline` (`symbol_outline` tool)
- `apply-patch` (`apply_patch` tool)
- `terminal-session` (`exec_command` and `write_stdin` tools)
- `ask-user` (`ask_user` tool)
- `ask-question` (`ask_question` tool)
- `ask-questionnaire` (`ask_questionnaire` tool)
- `sourcegraph`
- `recap` (`recap` tool)
- `thinking-steps` (passive renderer for chain-of-thought blocks; no user-facing controls)
- `todo` (forked task-tracking tool with a compact above-editor overlay; replays state across `/reload` and compaction)
- `auto-compact` (forked proactive pre-turn/mid-turn context compaction, configured through `/capy-tools-settings`)
- `working-message` (forked calm animal-life working-message renderer with a four-language `/capy-tools-settings` panel)

## Core helper tools

`repo_map` generates a compact project orientation map: root, git state, manifests, language mix, important files, directory clusters, and recent changes.

`read_block` reads the enclosing code or Markdown block around a line or symbol, so agents can inspect the right semantic unit without guessing offset/limit ranges.

`symbol_outline` lists a file's readable functions, classes, types, declarations, or Markdown sections with `read_block` line anchors, so agents can discover the right block before reading it.

`apply_patch` applies Codex-style patch text with `*** Begin Patch` / `*** End Patch` envelopes and `*** Add File`, `*** Update File`, `*** Move to`, and `*** Delete File` operations. This implementation intentionally stays close to Codex behavior: it accepts absolute paths, can overwrite add/move destinations, can delete files, creates missing parent directories for writes, and applies hunks sequentially. It is a direct extension-process filesystem writer, not pi's built-in `bash` approval flow; review paths carefully before using it, especially absolute paths and delete/move hunks. Delete is non-recursive and refuses directories.

`exec_command` starts a persistent terminal session for long-running or interactive commands and returns either an `exit_code` for finished commands or a `session_id` for commands that are still running.

`write_stdin` writes to, polls, or interrupts a running `exec_command` session; pass an empty `chars` string to poll fresh output and `"\u0003"` to send SIGINT. The first version is non-PTY, process-local, macOS-validated, and uses byte-based output limits through `max_output_bytes`; it is a direct extension-process shell runner rather than the built-in `bash` approval flow. Ctrl-C cleanup is cooperative, with abort-after-spawn escalating from SIGTERM to SIGKILL on macOS/POSIX; Windows process-tree cleanup is not validated in this package.

`ask_user` adds a simple free-form user prompt for cases where the agent needs an unstructured answer before continuing.

`ask_question` adds a small, session-friendly tool for asking the user a focused question with optional choices and free-text fallback.

`ask_questionnaire` adds a multi-question TUI for batching related questions with suggested options, recommended defaults, free-text answers, and a submit review screen.

`recap` is the user-facing narration channel. The tool takes a single `text: string` argument (8–12 words) and `renderCall` shows that prose to the user as one italic line; `renderResult` is empty, so the prose appears exactly once. The agent passes the sentence as a tool-call argument instead of emitting it as inline assistant text — this makes narration work the same way across providers whose models route prose into hidden thinking traces (Kimi, Gemini) and providers whose models emit prose inline (Claude). `recap` is intentionally absent from the `basic-tool-grouping` set, so a `recap` call cleanly separates a preamble line from the grouped `Used N tools` block that follows.

The extension contributes a `Recap discipline:` `before_agent_start` system-prompt fragment modelled after `Todo discipline:` and Codex CLI's preamble/progress-update guidance. Concretely:

- **Preamble before a batch** — call `recap({ text: "…" })` as the first tool in any parallel batch of related tool calls, with a forward-looking sentence (8–12 words) describing what the batch is about to do. The other tools run in parallel right after, in the same assistant message.
- **Progress update between segments** — in longer multi-phase tasks, call `recap({ text: "…" })` between work segments with a sentence that recaps what just finished and signals where the agent is heading next.
- **Combine** — one `recap` per batch, one per segment. Combine related work into a single preamble or progress update rather than calling `recap` per tool.
- **Skip when trivial** — skip `recap` for a single trivial action (one file read, one grep) where nothing is worth surfacing.
- **Tone** — light, friendly, and curious, like a coding partner handing off work.

The prompt uses invitational "discipline" language (no `must` / `Do not` / `---` divider mandates) and ships with concrete `recap({ text: "…" })` call examples, including a parallel-batch shape that pairs `recap` with another tool in the same message. The motivation: an earlier `work_checkpoint` design that mandated a `---` divider plus a structured checkpoint paragraph saw essentially zero agent-initiated calls; making the tool itself the visible narration channel (rather than a reminder to write prose) decouples user-visible narration from each model family's text-vs-thinking emission habits.

`thinking-steps` rewires Pi's built-in thinking renderer so chain-of-thought blocks use `├ `/`└ ` tree connectors with per-role glyphs (◫ inspect, ⌕ search, ✎ write, ▸ run, ↗ network, ◇ plan, ↔ compare, ✓ verify) and the same accent/muted color tokens as `enable-builtin-search`'s compact tool grouping. It is intentionally a passive renderer: no slash command, no shortcut, no status bar entry, and no persistence file. The renderer patches `AssistantMessageComponent` at session start, locks the view to `summary` mode (latest-N chronological steps), and releases the patch on session shutdown so Pi's native renderer comes back automatically. Multiple thinking blocks within one assistant message merge into a single `Thinking Steps · N thoughts` card. Forked from [pi-thinking-steps](https://github.com/fluxgear/pi-thinking-steps) (MIT, fluxgear); see `extensions/thinking-steps/LICENSE` for the original copyright notice.

`todo` is a single tool with the `create / update / list / get / delete / clear` actions used to track multi-step work — the agent marks tasks `in_progress` before starting, `completed` immediately after finishing, and uses `blockedBy` (with cycle detection) to express dependencies. State is replayed from the current branch on session start, compaction, and tree fork, so a `/reload` or branch switch preserves the task list. A persistent overlay above the editor shows a compact `Todos N/M` view (status glyphs, dimmed strikethrough on completed rows, `· <activeForm>` annotation on the in-progress row) that collapses overflow rather than scrolling. Forked from [`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo) (MIT, juicesharp); the per-call surface is rewritten to flow through this package's basic-tool grouping (`Tracked N todos` header + single-line `• Added <subject>` rows) and the optional `@juicesharp/rpiv-i18n` peer dep is dropped. See `extensions/todo/LICENSE` for the original copyright notice.

`auto-compact` proactively manages context window usage before Pi's built-in after-`agent_end` auto-compaction would normally run. It checks at `turn_start` before model requests, in the `context` event as an emergency truncation fallback, after assistant messages that contain tool calls (`turn_end`), and on resume/forked sessions that reopen above the threshold. When this extension triggers `ctx.compact()`, it sends a short follow-up user message after compaction finishes and the agent is idle, so the in-flight task resumes instead of silently stopping. Settings live under the unified `autoCompact` section in `~/.pi/agent/capy-tools.json`, are edited through `/capy-tools-settings`, and migrate from the old standalone `~/.pi/agent/auto-compact-settings.json` file. Forked from [pi-auto-compact](https://github.com/capyup/pi-auto-compact) (MIT, capyup).

`working-message` replaces pi's default spinner working message with short calm animal-life narration in one of four languages (English, Chinese, Japanese, Korean). Use `/capy-tools-settings` for all Capy Tools settings; today it exposes the working-message language picker and the auto-compact controls, persisted together in the unified config file `~/.pi/agent/capy-tools.json`. On first run it migrates the old standalone `~/.pi/agent/cat-whimsical.json` language value into the unified config. Pi's native `setWorkingMessage()` renders above extension widgets, so Capy Tools hides that native row during turns and mounts its own animated loader as an `aboveEditor` widget after `todo`; the visual order is `Todos ...` first, then the Capy Tools working message below it, then the editor. Forked from [pi-cat-whimsical](https://github.com/lulucatdev/pi-cat-whimsical) (MIT, lulucatdev); see `extensions/cat-whimsical/LICENSE` for the original copyright notice.

### Built-in search activation

`enable-builtin-search` activates pi's internal `grep`, `find`, and `ls` tools. It also installs compact group-aware renderers for common basic tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, and this package's file/navigation tools), so consecutive basic-tool calls collapse into a Codex-style action block like `Ran 3 commands` or `Explored 3 targets` and split again when a non-basic tool appears. Each tool row uses a tree connector (`├ `/`└ `) plus a role glyph; `write_stdin` polls and writes are aggregated onto the parent `exec_command` row's meta (e.g. `· 2 polls · 1 write`) instead of rendering as separate rows. Legacy custom `glob`, `grep`, and `list` implementations were removed so they cannot shadow pi's built-ins.

## Runtime requirements and dependencies

### Pi core package scope

Pi core packages have moved from `@mariozechner/*` to `@earendil-works/*`. This package imports and tests against the new scope (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui`) and keeps them as peer dependencies so pi supplies its own core runtime.

### Bundled in this package

### External tools you must provide

- `fetch` requires [MarkItDown](https://github.com/microsoft/markitdown) for Markdown conversion.
- Activated built-in `grep` and `find` use pi's managed `rg` and `fd` tools; install them on `PATH` or let pi download them when needed.
- MarkItDown upstream requires Python 3.10 or newer.
- Recommended installation method: `pipx`, so the `markitdown` CLI is available on `PATH` without modifying the package itself.

## Installation

Install the pi package:

```bash
pi install npm:@capyup/pi-basic-tools
```

Install `pipx` if it is not already available:

```bash
brew install pipx
```

Alternative `pipx` installation:

```bash
python3 -m pip install --user pipx
python3 -m pipx ensurepath
```

Install MarkItDown for the `fetch` tool:

```bash
pipx install 'markitdown[all]'
```

Verify that MarkItDown is available:

```bash
markitdown --version
```

If pi is already running, reload extensions after installing or updating dependencies:

```text
/reload
```

## Testing

The test suite is strict by default: it uses real filesystem operations, real `git`, live network calls to `example.com` and Sourcegraph, and the real MarkItDown CLI. Missing dependencies are expected to fail tests instead of being mocked or skipped.

```bash
npm install
npm test
npm run test:build
npm run check
```

For real TUI renderer validation, run the PTY capture harness. It launches an actual interactive `pi` instance, captures the terminal ANSI stream, writes a plain-text transcript under `.pi/tui-captures/`, and asserts that the grouped action block uses the Codex-style rows (`Explored 3 targets`, `Outline`, `Read`, and `Search`) without `grep grep` duplication:

```bash
npm run test:tui-capture
```

To validate the user's normal Pi loading path rather than the isolated local-extension setup, run:

```bash
npm run test:tui-capture:current
```

Test coverage includes `repo_map`, `read_block`, `symbol_outline`, `apply_patch`, `exec_command`, `write_stdin`, `ask_user`, `ask_question`, `ask_questionnaire`, `recap`, `fetch`, `sourcegraph`, Codex-style compact tool rendering, grouped basic-tool rendering, `enable-builtin-search`, TUI capture harness support, and package wiring. See [`docs/testing.md`](docs/testing.md) for the dependency checklist, public research summary, and recommended pi extension testing workflow.

## Update

Update this package inside pi:

```bash
pi update npm:@capyup/pi-basic-tools
```

If you need to update MarkItDown as well:

```bash
pipx upgrade markitdown
```

## Fetch storage and conversion

The `fetch` tool does not inline the fetched page body into the tool result. Instead, it stores artifacts under the current project's `.pi/fetch/` directory using a timestamp-plus-slug layout similar to task artifacts. It does not fall back to the global `~/.pi`; if you run it directly from your home directory, it refuses and asks you to work from a project directory.

```text
.pi/fetch/<timestamp>-<slug>/
  response.<ext>
  content.md
  meta.json
```

### Files written by `fetch`

- `response.<ext>`: raw fetched response saved byte-for-byte with an extension inferred from `Content-Type` or URL.
- `content.md`: Markdown generated by MarkItDown when conversion succeeds.
- `meta.json`: metadata for the fetch run, including URL, content type, byte size, saved paths, and MarkItDown command attempts.

### MarkItDown execution order

`fetch` attempts MarkItDown in this order:

1. `~/.local/bin/markitdown`
2. `markitdown`
3. `python3 -m markitdown`
4. `python -m markitdown`

If conversion fails, the raw response is still preserved and `meta.json` records the failed attempts.

### Expected workflow after `fetch`

The `fetch` result explicitly tells the agent which saved file to read next. It also reports a rough line count and token estimate for that recommended file so the model can decide whether to read it immediately.

After calling `fetch`, inspect the generated Markdown with `read`:

```text
read .pi/fetch/<timestamp>-<slug>/content.md
```

If Markdown conversion fails, `fetch` points `read` at the raw saved response instead. For binary responses it still preserves the file, but line and token estimates are omitted because they would not be meaningful.

If Markdown conversion fails, inspect either of these instead:

```text
read .pi/fetch/<timestamp>-<slug>/response.<ext>
read .pi/fetch/<timestamp>-<slug>/meta.json
```

## Future tool ideas

Good candidates for later Capy Tools additions:

- `diagnostics` / `check`: run project-aware lint/test/typecheck commands with structured, compressed results.
- `symbols`: LSP or Serena-backed `find_symbol`, `references`, and safe rename/replace helpers.
- Structured git write tools: guarded branch/commit helpers that never hide dirty worktree risk.
- Context utilities: inspect active tools, model context usage, and recent large tool outputs.

Browser automation, heavy web research, and semantic language-server workflows may be better as separate packages or MCP integrations instead of bloating this core package.

## Notes

- `fetch` keeps a 5 MB response-size guard.
- `fetch` saves binary responses safely; it does not force them through text decoding before writing them to disk.
- Legacy custom `glob`, `grep`, and `list` implementations are intentionally absent; pi's built-in `grep`, `find`, and `ls` are preferred.

## License

MIT
