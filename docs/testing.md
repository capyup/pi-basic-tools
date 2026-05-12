# Testing pi-basic-tools

This project intentionally uses a strict, real-dependency test suite. The default test command does not skip network, filesystem, Git, or external CLI behavior. If a required dependency is unavailable, the test should fail so the failure is visible.

## Commands

```bash
npm install
npm test
npm run test:build
npm run check
```

- `npm test` runs `bun test` across `tests/**/*.test.ts`.
- `npm run test:build` bundles every enabled extension entrypoint with Bun and leaves pi core packages external.
- `npm run check` runs the build check and then the test suite.

## Required Local Dependencies

- Bun on `PATH`; tests use `bun:test` and TypeScript files directly.
- Node/npm for dependency installation and lockfile maintenance.
- Git on `PATH`; `repo_map` tests initialize a real temporary repository and require real `git` commands.
- Internet access to `https://example.com/` and `https://sourcegraph.com/.api/graphql`; `fetch` and `sourcegraph` tests call live services.
- MarkItDown available through one of the production lookup paths used by `fetch`: `~/.local/bin/markitdown`, `markitdown`, `python3 -m markitdown`, or `python -m markitdown`.
- Python 3.10+ when MarkItDown is installed through Python tooling.

Recommended MarkItDown setup:

```bash
pipx install 'markitdown[all]'
markitdown --version
```

## Package Scope and Peer Dependencies

Pi moved from the old `@mariozechner/*` npm scope to `@earendil-works/*`. Version `0.74.0` is the first release under the new scope, and the old packages are deprecated but kept for reproducibility. See the pi migration note: https://pi.dev/news/2026/5/7/pi-has-a-new-home

Pi package docs recommend listing pi core imports as `peerDependencies` with a `"*"` range and not bundling them. This package therefore keeps these as peers and dev dependencies for local tests:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `@sinclair/typebox`

Reference: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md

## Coverage Map

| Area | Tests | Real dependencies exercised |
| --- | --- | --- |
| Package wiring | `tests/package-wiring.test.ts` | package manifest, extension files, npm lockfile contents |
| `repo_map` | `tests/repo-map-read-block.test.ts` | real `git init`, `git add`, manifest parsing, filesystem walking |
| `read_block` | `tests/repo-map-read-block.test.ts` | real file reads, TypeScript brace blocks, Markdown sections, invalid inputs |
| `question` | `tests/ui-tools.test.ts` | extension UI dialog contract for select/input/cancel results |
| `questionnaire` | `tests/ui-tools.test.ts` | real questionnaire component logic and `@earendil-works/pi-tui` keyboard handling |
| `fetch` | `tests/network-tools.test.ts` | live HTTP fetch, project-local `.pi/fetch`, real MarkItDown conversion, metadata files |
| `sourcegraph` | `tests/network-tools.test.ts` | live Sourcegraph GraphQL API |
| `enable-builtin-search` | `tests/repo-map-read-block.test.ts` | extension event handling and active-tool state transitions |

The tests use a small in-process extension host to register and execute pi tools. It is a test harness for the extension API surface, not a substitute for the production dependencies: filesystem, Git, network, MarkItDown, Sourcegraph, and `@earendil-works/*` packages are all used for real.

## Research Summary

Public agent-testing guidance consistently recommends layered testing: deterministic component/tool tests first, integration tests for workflows, and production/evaluation feedback loops for LLM behavior. For this package, the right default is tool-level and integration-style checks because the extensions are deterministic tools; exact code assertions are cheaper and more stable than LLM-as-judge evaluation. Source: https://blog.appxlab.io/2026/04/08/how-to-test-ai-agents/

For JavaScript/TypeScript projects, current runners such as Vitest document the standard pattern of committed test files plus a package script that runs the suite once in CI/local checks. This project uses Bun's built-in runner instead of adding Vitest because Bun is already available locally and runs TypeScript ESM tests directly. Reference: https://main.vitest.dev/guide/

## Recommended Workflow

1. Add or update a focused test before changing an extension's behavior.
2. Cover both the happy path and the failure path that should not mutate state or should surface a clear error.
3. Use real temp directories and real CLI/network dependencies; do not add test skips for missing dependencies unless a future maintainer explicitly changes the strict policy.
4. Run `npm test` while iterating, then `npm run check` before publishing or installing through pi.
5. When a real bug is found, keep the failing test as a regression test and document any new runtime requirement in `README.md` or this file.
