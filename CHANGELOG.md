# Changelog

## 0.8.0 (2026-05-17)

- **Fix stacked blank lines before grouped tool blocks**: A new `extensions/tool-execution-patch.ts` monkey-patches `ToolExecutionComponent.prototype.render` in `@earendil-works/pi-coding-agent`. Pi's wrapper unconditionally prepends `new Spacer(1)` to every tool execution, so when `basic-tool-grouping` marks earlier tools in a group as hidden, their inner renderer returns `[]` but the outer wrapper still emits one blank line — producing N-1 stacked blanks before an N-tool group block. The patch detects the visually-empty case (all rendered lines are whitespace or ANSI-only after CSI/SGR stripping) and collapses the component to `[]`. Tools with real content render unchanged. The patch is installed via the same ref-counted `session_start` / `session_shutdown` pattern used by thinking-steps' internal patch, and is unit-tested in `tests/tool-execution-patch.test.ts`.
- **Visual hierarchy carried over from 0.7.2**: The three-tier color rule (`warning`/`error` live → `muted` structure & detail), shape-based status markers (`◐` running, `!` error, `•` done), and todo discipline rules in the system prompt are bundled into this release.

## 0.7.2 (2026-05-16)

- **Unified visual hierarchy across in-message group renderers**: `thinking-steps`, `basic-tool-grouping`, and the todo standalone fallback now share one three-tier color rule. Tier 1 (live) is `warning` (running) or `error`; Tier 2 (structure) and Tier 3 (detail) settle to `muted`. A finished page is almost entirely muted, with `warning` ink only on the running group header and the running item marker. Concrete consequences: the `Thinking N steps` header now matches the `Ran N commands` / `Used N tools` headers in `muted`; role glyphs in thinking-steps lose their per-role color (shape carries the meaning); tool-item headline text is `muted` in every non-error state; active thinking-step text drops `accent` but keeps `bold`.
- **Shape-based markers signal state instead of text color**: tool items render `◐` (running, warning), `!` (error), `•` (done, muted). The static `◐` and the existing thinking `pulseGlyph` (`· • ● •`) share the same rounded-dot visual family so the two surfaces read consistently without coupling animation ticks.
- **Todo discipline injected into the system prompt**: a new `before_agent_start` handler in `extensions/todo/index.ts` contributes four discipline rules to every turn (use immediately for 3+ steps / multi-task lists / uncaptured instructions; skip for trivial requests; mark `in_progress` before starting and `completed` immediately when done — never batch; exactly one in_progress at a time). Mirrors the `work_checkpoint` pattern and co-exists with it cleanly.

## 0.7.1 (2026-05-16)

- **Thinking-steps renderer**: Forked from [`pi-thinking-steps`](https://github.com/fluxgear/pi-thinking-steps) (MIT, fluxgear) and integrated as a passive renderer under `extensions/thinking-steps/`. Pi's `AssistantMessageComponent` is patched at `session_start` so chain-of-thought blocks render as `Thinking N steps` headers followed by `• <icon> <summary>` rows that share the `accent`/`muted`/`warning`/`error` color palette and `• … │ … └` connector vocabulary used by `enable-builtin-search`'s compact tool grouping. The active step is highlighted in warning color while the model is streaming.
- **Invisible control surface**: The renderer is intentionally invisible to end users. No slash command, no keyboard shortcut, no status bar entry, and no persistence file. The renderer is locked to `summary` mode every session; users do not need to know the extension exists.
- **Header alignment with basic-tool grouping**: The `Thinking N steps` header drops the upstream `┐ Thinking Steps · Summary` banner and the `├─/└─` tree-branch connectors so the thinking block reads like another `Used 4 tools` / `Ran 5 commands` / `Explored 3 targets` action block in the UI. When summary mode shows fewer than the total step count, the header still reports the true total (matching how `Used N tools` always reports the real group size).
- **Todo tool**: Forked from [`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo) (MIT, juicesharp) into `extensions/todo/`. The LLM-facing `todo` tool keeps upstream's `create / update / list / get / delete / clear` actions, 4-state machine (`pending → in_progress → completed`, plus `deleted` tombstone), `blockedBy` dependency graph with cycle detection, and `TaskDetails` envelope shape so sessions persisted under `@juicesharp/rpiv-todo` replay correctly.
- **Todo per-call rendering**: Todo calls flow through `basic-tool-grouping` so a planning burst collapses into a single `Tracked N todos` header followed by single-line `• Added <subject>` / `• Started <subject>` / `• Done <subject>` rows, with the result detail appended inline (`· #3 → in progress`). The upstream `todo +` prefix, per-call `○ pending` echo row, and `├─/└─` connectors are gone.
- **Todo above-editor overlay**: The persistent widget is restyled to a compact `Todos N/M` header followed by `• ○`/`• ◐`/`• ✓` rows that share the basic-tool palette; completed subjects are dimmed and struck through, the `in_progress` row carries `· <activeForm>` and the active heading uses `accent` when work is in flight. Collapse-not-scroll at 12 lines and the "completed tasks linger until the next agent turn" affordance are preserved from upstream.
- **Todo passive surface**: No `/todos` slash command, no keyboard shortcut, no `~/.config/rpiv-todo/config.json` overrides, and the optional `@juicesharp/rpiv-i18n` peer dep is dropped — the extension is English-only and renders identically across users.

## 0.6.0 (2026-05-15)

- **Codex-style compact rendering**: Each tool now renders as a concise headline (`Explored`, `Ran`, `Edited`, `Fetched`) with an optional child detail line, matching the Codex CLI visual language.
- **No truncation**: Tool detail lines fill the full terminal width instead of being prematurely truncated.
- **No duplicate rows**: `renderResult` updates status and returns empty; only the call row remains visible.
- **Detail preservation**: Streaming updates with incomplete args no longer overwrite existing pattern/path/target via `mergeSummary`.
- **TUI capture harness**: Added `scripts/capture-pi-tui.py` with `npm run test:tui-capture` and `test:tui-capture:current` for real terminal validation.
- **Work checkpoints**: Added `work_checkpoint`, a self-reminder tool that tells the agent to write a short progress summary and next-step note after a group of basic tool calls or between work segments.

## 0.5.0 (2026-05-15)

- `ask_user`, `ask_question`, `ask_questionnaire` tools.
- `exec_command` + `write_stdin` persistent terminal sessions.
- `apply_patch` Codex-style patch tool.
