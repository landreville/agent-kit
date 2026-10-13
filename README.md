# agent-kit

Plugins, skills, and instructions for AI agent harnesses — OpenCode, Claude
Code, and future harnesses. One home instead of per-project dotfiles.

## Layout

- `opencode/plugins/<name>/` — OpenCode v2 plugins, self-contained. The
  toolchain is per-plugin: some are plain ESM with zero runtime
  dependencies (litellm-models), others carry their own dependencies and
  test tooling declared in their directory (blotto-mode). Each has its
  own README.
- `claude/` — Claude Code plugins/skills (future).

## Current plugins

- `opencode/plugins/litellm-models` — fetches the model catalog for the
  `litellm` provider from a LiteLLM-compatible gateway at startup and on an
  interval, so client configs no longer hand-maintain model lists.
- `opencode/plugins/blotto-mode` — "auto mode": answers OpenCode
  permission requests on the user's behalf — deny-only hard rules, a
  session cache, an optional Laya tier, and an LLM judge — with anything
  undecided falling back to the normal prompt. Bun + TypeScript; plugin-local
  agent guidance in `opencode/plugins/blotto-mode/AGENTS.md`.

## Conventions

New work goes on a feature branch in `.worktrees/<branch>` (gitignored),
merged to `main` once verified.

OpenCode plugins target **OpenCode v2** only; my other V1-pinned client
deployments adopt when they upgrade.
