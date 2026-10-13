# blotto-mode

Auto mode for OpenCode v2. A plugin that answers permission requests on the user's behalf: obviously dangerous actions are denied by hard rules, repeats are served from a session cache, and everything else is judged against what the user actually asked for. Anything undecided, or any failure, falls back to OpenCode's normal prompt. It lives in the agent-kit repo at `opencode/plugins/blotto-mode/`.

It is **not a sandbox** (see [Safety notes](#safety-notes)).

## Pipeline

```
Permission
  |
  v
1. Normalize ---> ActionRequest { kind, pattern, commands[], opaque }
  |
  v
2. Hard rules ---> deny | pass              (deterministic, data-driven)
  |
  v
3. Session cache ---> allow | pass          (exact key, then judge-proposed globs)
  |
  v                    fetch session context (concurrent)
4. Laya tier ---> allow | ask | deny | pass (optional; shadow by default)
  |
  v
5. LLM judge ---> allow | deny | ask | pass (structured JSON via LiteLLM)
  |
  v
6. Fallback ---> ask
```

The first tier to return a decision wins. A tier that throws is logged and skipped, except the hard-rules tier: if it throws, the request ends in ask, so no later tier can allow something the rules never checked. Decisions are appended to a JSONL log, and the user's later replies are merged in for `bun run report`. Plugin diagnostics go to OpenCode's log (`client.app.log`, service `blotto-mode`), not to the terminal.

## Install

Add the plugin by path (the package entry is `src/index.ts`, which exports `BlottoMode`):

Install dependencies in the plugin directory:

```
bun install
```

```json
// ~/.config/opencode/opencode.json
{ "plugin": ["/path/to/blotto-mode"] }
```

> On the agent-kit machine the plugin lives at
> `opencode/plugins/blotto-mode` and is **not yet activated** — no
> config entry and nothing under `~/.config/opencode/plugins/` (that
> directory is auto-loaded at startup, so a symlink there would count as
> activation). See [docs/install.md](docs/install.md) for the activation
> checklist.

Configure the judge:

```json
// ~/.config/opencode/blotto-mode.json
{ "judge": { "apiKey": "{env:LITELLM_API_KEY}" } }
```

`LITELLM_API_KEY` must be exported in the shell that launches OpenCode, or written literally into the file. An unset `{env:VAR}` expands to an empty string with no warning. See [docs/install.md](docs/install.md) for the manual acceptance checklist.

## Configuration

Config layers, later wins: built-in defaults, `~/.config/opencode/blotto-mode.json`, then `<worktree>/.opencode/blotto-mode.json`. Objects merge key by key. Arrays replace, except `rules.custom` and `laya.questions`, which concatenate. Strings support `{env:VAR}` and a leading `~`. An unset `{env:VAR}` expands to an empty string with no warning, so make sure `LITELLM_API_KEY` is exported in the shell that launches OpenCode. An invalid config logs the problem and falls back to defaults. A full copy of the defaults plus examples is in [.opencode/blotto-mode.example.json](.opencode/blotto-mode.example.json).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Global switch. `BLOTTO_MODE=off` in the environment forces `false`. |
| `kinds` | `["bash","webfetch","websearch","external_directory","edit","mcp"]` | Permission kinds the plugin handles. Others are left to OpenCode. |
| `judge.baseUrl` | `https://litellm.example.com/v1` | OpenAI-compatible chat completions endpoint. |
| `judge.apiKey` | `{env:LITELLM_API_KEY}` | API key for the judge. |
| `judge.model` | `glm-5.3-flash` | Judge model. |
| `judge.fallbackModel` | `null` | Model to try if the primary fails. |
| `judge.timeoutMs` | `8000` | Judge timeout (100-60000). |
| `judge.userMessageCount` | `6` | Recent user messages shown to the judge (1-20). |
| `judge.contextTokenBudget` | `1500` | Token budget for session context (200-20000). |
| `laya.mode` | `"shadow"` | `off`, `shadow` (run and log, never decide), or `active`. |
| `laya.baseUrl` | `null` | Laya server. The tier is skipped while this is unset. |
| `laya.apiKey` | `null` | Optional bearer token for Laya. |
| `laya.timeoutMs` | `150` | Laya budget (20-5000): the session-context wait and the request share it. While the startup probe is still running, a request also waits up to this long for it, and is passed to the judge if the probe has not finished. |
| `laya.verdictThreshold` | `0.95` | Minimum confidence for the `verdict` question to allow (0.5-1). |
| `laya.allowDeny` | `false` | Lets a veto deny instead of ask. The veto question must also set `allowDeny`. |
| `laya.questions` | `[]` | Extra questions, or overrides of a default question by `id`. |
| `laya.disableQuestions` | `[]` | Ids of default questions to drop. |
| `rules.disable` | `[]` | Ids of built-in rules to turn off. |
| `rules.custom` | `[]` | Extra deny rules (see below). |
| `cache.sessionPatterns` | `true` | Allow judge-proposed glob patterns to be cached per session. |
| `feedback.injectDenialReason` | `true` | Send the denial reason to the agent as a message. |
| `feedback.toast` | `true` | Show a toast on denial. |
| `log.path` | `~/.local/share/blotto-mode/decisions.jsonl` | Decision log. Created with mode `0600` in a `0700` directory. |
| `log.maxMb` | `50` | Log size cap (1-1000). |

### Custom rules

A rule is `{ id, kinds, reason, match }`. `match` is one form, or an array of forms (any may match):

| Form | Fields |
|---|---|
| `command` | `command` (string or list), optional `subcommand`, optional `argsGlob`, optional `argsRegex` (tested against a space followed by the space-joined arguments) |
| `pathWrite` | list of path globs (`~` expanded) that must not be written |
| `deleteOutsideWorktree` | `true` |
| `urlHost` | host glob |
| `pipeToNetwork` | `{ sources?, fileGlobs? }`: commands or files whose output is sent to a network command |
| `downloadToInterpreter` | `true` |
| `regex` | regular expression over the raw pattern |

Bash rules are evaluated per simple command, so `ls && terraform apply` still matches. Rules are deny-only. `subcommand` is the first non-option argument; for `git`, global options that take a value (`-C <dir>`, `-c <k=v>`, `--git-dir`, `--work-tree`, ...) are skipped first. A `regex` or `argsRegex` that does not compile makes the whole config invalid, so the defaults are used.

### Built-in rules

| Id | Blocks |
|---|---|
| `rm-root-home` | recursive delete of `/`, home, or a path outside the worktree (`rm -r`, and `find <paths> ... -delete` on its start paths; a bare `cd` counts as going home) |
| `write-ssh` | writes under `~/.ssh` (redirects, `tee`, `cp`, `curl -o`, `wget -O`, ...) |
| `write-shell-profile` | writes to shell profiles (`.bashrc`, `.zshrc`, `.profile`, fish config, ...) |
| `write-self` | writes to blotto-mode config or log |
| `write-opencode-config` | writes under OpenCode config (`~/.config/opencode`, `.opencode`) |
| `sudo` | `sudo`, `doas`, `su`, `pkexec`, `run0` |
| `mkfs-dd` | `wipefs`, `fdisk`, `parted`, `sfdisk`, `mkfs`, `dd of=/dev/...` |
| `chmod-root` | recursive `chmod`/`chown`/`chgrp` on `/`, `/home/*`, `~`, `$HOME`, or `${HOME}` |
| `curl-pipe-sh` | remote script run by an interpreter: `curl ... \| sh`, `eval "$(curl ...)"`, `sh -c "$(curl ...)"`, `$(curl ...)`, `bash <(curl ...)`, `source <(curl ...)`, `. <(curl ...)` |
| `persistence` | `crontab -e`, `-r`, a file, or `-` (not `crontab -l`); `systemctl enable`; writes to systemd/autostart/cron paths or OpenCode plugins |
| `exfil-env` | `env`/`printenv`/`set`/`export` output or credential files (`.env`, `~/.aws`, keys, ...) sent to the network |
| `git-destructive-remote` | `git push` with `--force`, `-f` (also in clusters such as `-fu`), `--force-with-lease`, `--force-if-includes`, `--mirror`, `--delete`/`-d`, a `+ref` force refspec, or a `:ref` deletion |

### Laya questions

The Laya tier posts the session state and these questions to `{laya.baseUrl}/v1/systemone`. Roles: `verdict` (allow/ask/deny choice), `approve` (a high-confidence yes allows), `veto` (a yes forces ask), `signal` (a yes is passed to the judge as a flag). Thresholds apply to the probability of `true`.

| Id | Role | Threshold |
|---|---|---|
| `verdict` | verdict | `laya.verdictThreshold` (0.95) |
| `read_only` | approve | 0.9 |
| `project_check` | approve | 0.9 |
| `local_network_only` | approve | 0.9 |
| `irreversible` | veto | 0.8 |
| `out_of_scope` | veto | 0.8 |
| `exfiltrates` | veto | 0.8 |
| `reveals_secret` | veto | 0.8 |
| `persistence` | veto | 0.8 |
| `injection_driven` | signal | 0.7 |

In `active` mode: a fired veto gives ask (or deny, see `allowDeny`); otherwise a fired approve gives allow; otherwise a confident `verdict: allow` gives allow; otherwise the request passes to the judge. An allow is only issued when every veto question was answered.

A `verdict` question must have type `choice`; `approve`, `veto`, and `signal` questions must have type `noul`. Any other combination makes the config invalid.

## The `blotto_mode` tool

The agent can call `blotto_mode` with `action`:

- `status`: enabled state, judge model, Laya mode and reachability, and this session's allowed/denied/asked counts by tier.
- `off`: disable blotto-mode for this session only (prompts appear normally).
- `on`: re-enable for this session. Refused when disabled globally.

It cannot change persistent configuration.

## Reports and evals

```
bun run report [--log PATH] [--since DATE] [--json] [--export-eval FILE] [--export-laya FILE]
```

Summarizes the decision log (default `log.path`): decision counts, agreement with the user's replies, a confusion matrix of final status against the user's answer, and Laya mode, agreement, latency, and per-question stats. `--since` takes any date string `Date` parses. `--json` prints the raw report. `--export-eval` writes eval cases from the log as JSONL, and `--export-laya` writes Laya-format rows as JSONL.

```
bun run eval [--cases PATH] [--tiers rules,cache,laya,judge] [--model NAME] [--laya-mode MODE]
             [--laya-url URL] [--only TAG_OR_ID] [--concurrency N] [--out FILE]
```

Runs the seed corpus (`eval/cases`) through the real tiers, with mock sessions. Defaults: all four tiers, concurrency 4, output `eval/runs/<timestamp>.json`. `--only` selects cases by tag or id. The judge tier needs `LITELLM_API_KEY`. Exit codes: `0` ok, `1` at least one false allow, `2` invalid arguments or no cases selected, `3` the judge tier was selected but errored (no verdict) on more than half the cases, so the run measured the fallback rather than the judge. Code `3` takes precedence over `1`, and a warning is printed to stderr.

## Safety notes

- **Not a sandbox.** It decides whether to prompt. An unknown request, a timeout, or any failure falls back to `ask`. A command the parser cannot fully account for is marked opaque: heredocs, here-strings, `|&`, unknown wrapper options, failed inner parses, `coproc`, a command name built from an expansion (`$x id`, `${SHELL} -c ...`), and `$(...)` nested inside `${...}`. Opaque commands still get hard rules over whatever was parsed, plus regex rules on the raw text. When the whole command fails to parse, the parser retries with `<<<` read as `<` and `|&` as `|` so the rules still see the commands. Nested `${x:-$(cmd)}` substitutions are parsed out for the rules too. The judge then decides on the raw text and may allow it. Session globs never apply to opaque commands. The user's own `opencode.json` permissions still apply.
- **Wrappers and runners are looked through.** Hard rules see the inner command of `sudo`, `env`, `nohup`, `nice`, `time`, `timeout`, `xargs`, `exec`, `command`, `watch`, `stdbuf`, `ionice`, `chroot`, `flock` (including `-c`), `strace`, `busybox`, `pkexec`, `run0`, and `srt --`; the `-c` payload of `sh`/`bash`/`zsh`/`dash`/`ksh`/`fish`, including option clusters such as `bash -lc` and `sh -ec`, and of `script -c`; the arguments of `eval`; and `find -exec`/`-execdir`/`-ok`/`-okdir` payloads, with `{}` replaced by each start path.
- **The judge never sees tool output or file contents.** It sees recent user messages, brief assistant intent, and the action. This limits prompt injection through content the agent read. The agent-supplied title is collapsed to one line, capped at 120 characters, and labelled as agent-supplied. For MCP tools the judge also sees the tool arguments (the permission's `metadata`) as JSON, capped at 600 characters, inside a fence the content cannot close.
- **Subagents are judged against the user's words.** In a subagent (child) session, the "user" messages are the parent agent's prompt. The plugin follows the session's parent links, at most 5, to the root session and shows the judge the root's user messages. The agent intent still comes from the requesting session. If the chain cannot be resolved, the context is marked unavailable and the judge is told to lean toward ask.
- **Slow context cannot hang a request.** Fetching session context shares the judge's `timeoutMs` deadline, and Laya's own `timeoutMs` budget. If it does not arrive in time, the judge sees "context unavailable" or, if the deadline is used up, the request falls back to ask.
- **Hard rules are deny-only.** The plugin never allows from a rule. If the rules tier itself fails, the request asks.
- **Session globs are guarded.** A judge-proposed glob is cached only if it has two literal tokens, matches the request it came from, does not start with a shell, `eval`, `source`, `.`, a wrapper (`env`, `xargs`, `sudo`, `timeout`, ...), `find`, or an interpreter (`python*`, `node`, `perl`, `ruby`, `php`, `deno`, `bun`, ...), and still hits no hard rule when probed with risky expansions (`/`, `~`, `../..`, `/etc/x`). Globs apply only to single, fully parsed commands with no redirects, and never to a command that carries inline code (`-c`/`-e` on a shell or interpreter, `find -exec`). Globs are never stored from a deny.
- **The cache is scoped by permission type and never stores denies.** Exact entries and globs are keyed by the permission type, so allowing one MCP tool never allows another. MCP exact entries also include the tool arguments. A deny, from the judge or Laya, is not cached, so the next identical request goes back through the pipeline. That way a user who later says "yes, do it" reaches the judge again. Rule denies are re-derived on every request.
- **Project config is trusted like OpenCode's own.** The project layer `<worktree>/.opencode/blotto-mode.json` can disable built-in rules, repoint `judge.baseUrl` at another endpoint, or turn the plugin off. That is the same trust OpenCode gives the project's own `.opencode/` config, which can already add plugins and change permissions. Do not open untrusted repositories with blotto-mode enabled unless you have reviewed that file. The agent cannot change it through blotto-mode: the `write-self` and `write-opencode-config` rules deny such writes, and the `blotto_mode` tool cannot change configuration.
- **Global disable wins.** With `enabled: false` or `BLOTTO_MODE=off`, the agent's `blotto_mode on` cannot re-enable it.
- **Laya fails closed.** Malformed or unrecognized answers are dropped, so Laya never auto-allows on them. A veto only asks, unless `allowDeny` is set (globally and on the question). Laya's default mode is `shadow`, which logs what it would have done and never decides.
- **The decision log is private.** It records commands and reasons, so it is created with mode `0600` in a `0700` directory.
- **Guard protection is limited to writes the rules recognise.** Covered: `**/blotto-mode.json`, `~/.local/share/blotto-mode/**` and the configured log path (`write-self`); `~/.config/opencode/**` and `**/.opencode/**` (`write-opencode-config`); `~/.config/opencode/plugins/**` (`persistence`). Not detected by rules, and so left to the judge: a project-root `opencode.json` or `opencode.jsonc`, the plugin's own source directory, and writes made by interpreters (`python -c`, `node -e`, etc.).

## Development

```
bun test
bun run typecheck
```
