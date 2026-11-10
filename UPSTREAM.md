# Upstream lineage

The 20 packages under `packages/` were copied wholesale from the opencode upstream to build dsterm, a DeepSeek Web terminal client.

- Upstream repository: https://github.com/sst/opencode
- Branch: `dev`
- Base commit: `a8091a2ea0339424457bf73cfda9a37d0a2d97a3`
  (2026-10-30, `fix(app): add top inset to recently closed menu search (#60652)`)
- Copy date: 2026-10-31
- Reference tag: `opencode-upstream-a8091a2` (points at the import commit; use `git diff opencode-upstream-a8091a2 -- packages/tui` to compare later changes)

## Copied scope

`packages/` (sources otherwise unchanged): tui, client, core, ai, protocol, schema, plugin, plugin-browser, codemode, httpapi-codegen, http-recorder, server, cli, script, theme, ui, util, latex, merman, simulation

Root configuration (merged from upstream): package.json (workspaces.catalog with 64 entries + 18 patchedDependencies), tsconfig.json, patches/

> Note: `git diff` against the base commit shows zero content differences for the cli, server, and script packages (they were downloaded via the earlier `da87c475` commit).

## Known deviations from upstream

1. `bunfig.toml` adds `linker = "hoisted"` to fix an `RGBA instanceof` crash caused by duplicate `@opentui/core` instances under isolated installs (the TUI crashed on startup)
2. `workspaces` is narrowed to `packages/*` (upstream uses the full 32-package graph)
3. `trustedDependencies` keeps only esbuild, node-pty, and protobufjs
4. Upstream `bun.lock` was not copied; dependencies were re-resolved locally against npmmirror
5. `packages/sdk` and `packages/service` are dsterm-owned placeholders (not created yet; git does not track empty directories)
