# pi-basic-tools

Standalone basic tools for pi.

This package bundles a practical set of editing, file-navigation, web-fetching, web-reference, and OpenCode-style search extensions split out from `pi-goodstuff`.

## Included extensions

- `multi-edit`
- `files`
- `webfetch`
- `search` (OpenCode-style `glob` and `grep` tools backed by ripgrep)
- `basic-tools` (question, todo)
- `answer`
- `sourcegraph`

## Core helper tools

`basic-tools` adds small, session-friendly tools that make common agent workflows safer:

- `question`: ask the user a focused question with optional choices and free-text fallback.
- `todo`: maintain a lightweight per-session task list for short multi-step work. It is intentionally not a replacement for plan documents or Ralph loops.

### Tool toggles

Use `/basic-tools-settings` to toggle these tools without editing package files:

```text
/basic-tools-settings
/basic-tools-settings list
/basic-tools-settings enable todo
/basic-tools-settings disable all
```

Settings are stored in `~/.pi/agent/basic-tools-settings.json`. Startup/reload applies the settings, while explicit no-tools sessions are respected.

### OpenCode-style search

`search` registers local `glob` and `grep` tools with OpenCode-compatible parameters and result formatting. It does not activate pi's built-in `grep`, `find`, or `ls` tools.

- `glob(pattern, path?)`: finds files by glob pattern and returns matching absolute paths sorted by modification time.
- `grep(pattern, path?, include?)`: searches file contents with regular expressions and returns file paths plus line numbers sorted by modification time.

Both tools use `rg --no-config` and otherwise follow ripgrep's normal ignore behavior. By default, dot files and dot directories such as `.pi`, `.claude`, and `.git` are skipped. To search a dot file or dot directory, pass that path explicitly as the `path` target.

## Runtime requirements and dependencies

### Bundled in this package

`multi-edit` vendors the line-diff implementation from `diff@8.0.2` under `vendor/diff/`, so it does not require `node_modules` or a post-`pi update` `npm install` step.

### Runtime dependencies

- `webfetch` uses the package dependency `turndown` for HTML-to-Markdown conversion.
- The `glob` and `grep` tools use ripgrep. They first use configured or system `rg`, then common OpenCode `rg` locations, and finally download ripgrep into the pi agent directory when needed.

## Installation

Install the pi package:

```bash
pi install git:github.com/lulucatdev/pi-basic-tools
```

If pi is already running, reload extensions after installing or updating dependencies:

```text
/reload
```

## Testing

Run the repository checks with:

```bash
npm test
```

The test suite validates the package search-extension registration and the ripgrep argument behavior used by `glob` and `grep`.

## Update

Update this package inside pi:

```bash
pi update git:github.com/lulucatdev/pi-basic-tools
```

## WebFetch behavior

`webfetch` follows OpenCode's model: it is a read-only retrieval tool that returns fetched content directly to the model instead of creating `.pi/fetch` artifacts in the workspace.

- `format: "markdown"` is the default. HTML responses are converted to Markdown with `turndown`; non-HTML text is returned as-is.
- `format: "text"` extracts readable text from HTML and returns non-HTML text as-is.
- `format: "html"` returns the response body as HTML or raw text.
- Image responses are returned as inline image content for the model.
- Responses are limited to 5 MB, with a 30 second default timeout and a 120 second maximum timeout.

## Future tool ideas

Good candidates for later `pi-basic-tools` additions:

- `diagnostics` / `check`: run project-aware lint/test/typecheck commands with structured, compressed results.
- `repo_map`: summarize important files, symbols, and dependency edges for quick orientation.
- `symbols`: LSP or Serena-backed `find_symbol`, `references`, and safe rename/replace helpers.
- Structured git write tools: guarded branch/commit helpers that never hide dirty worktree risk.
- Context utilities: inspect active tools, model context usage, and recent large tool outputs.

Browser automation, heavy web research, and semantic language-server workflows may be better as separate packages or MCP integrations instead of bloating this core package.

## Notes

- `webfetch` keeps a 5 MB response-size guard and does not write fetched content to disk.
- Search now follows the OpenCode model for local `glob` and `grep`, while pi's built-in `find`, `ls`, and `grep` are not activated by this package.
- Default search skips dot files and dot directories; explicit dot-path targets opt into hidden content.

## License

MIT
