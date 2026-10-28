# sandbox

An OpenCode **v2** plugin that runs would-be-ask shell commands inside
Anthropic's `@anthropic-ai/sandbox-runtime` OS sandbox, so routine work
(builds, test runs, local inspection) stops interrupting you with
permission prompts. The sandbox is the *precondition* for skipping the
prompt, never a silent privilege grant: a command whose effect is `ask`
is auto-allowed **only** to run sandboxed — writes limited to the working
directory (plus temp), reads allowed except sensitive credential paths,
all network egress denied except configured domains, credential env vars
scrubbed. When the sandbox genuinely blocks a command, the failure is
remembered and the retry goes through the normal permission flow,
unsandboxed once approved. Commands that invoke `srt` themselves are never
re-sandboxed.

## How it works

Three hooks, one decision per command. The wrap happens at
`tool.execute.before` — the only hook that runs before OpenCode's
permission decision exists for that command (`tool.execute.before` →
`permission.evaluate` → spawn, verified against the OpenCode source):

| Hook | Role |
|---|---|
| `ctx.tool.hook("execute.before")` | **Decide + wrap** — `policy.js`'s gate predicts the permission outcome for the command (see *Permission prediction*) and, only for a command that would ASK (simple or compound, when the segmenter accepts the shape), runs the eligibility chain (availability → exclusions / `srt` → failure memory → attempt cap → classifier → install consent) and wraps it by rewriting `event.input.command` wholesale with the `SandboxManager.wrapWithSandbox` string — a 128-bit `commandId` for attribution, and a per-call filesystem config resolved from the session's location directory. The rewrite is the LAST mutation: every failure path leaves the input untouched and the rules decide normally. |
| `ctx.permission.hook("evaluate")` | **Recognize** — a resource that exact-matches a wrapped string this plugin produced flips to `allow` (the decision was made pre-wrap on the original command; the headless runner auto-rejects asks, so the flip is what lets wrapped commands run at all). Otherwise it only surfaces a stashed message (the one-time unavailable message, the classifier's `UNSAFE` reason, the install consent). It never flips anything the plugin did not wrap. **Shell-action events only** — the shell tool's `prepare` asks about `external_directory` first, under the same call id, so a non-shell action is a strict no-op and the message stash is consumed by exactly the ask that carries the command — **and never from a `deny`**: a deny rule matching the wrapped resource (or another plugin's deny) stays final, because the flip only ever answers an ask. |
| `ctx.tool.hook("execute.after")` | **Observe + consent** — `violations.js`: attribute failures (violations for the `commandId`, or denial markers in the output), remember sandbox-blocked commands, annotate results (`(ran in sandbox: writes limited to <cwd>; network denied except configured domains)`); non-shell tools are strict no-ops. A completed **shell** run is the consent flow's proof of approval (a rejected ask also fires `execute.after`, with `status: "error"` — the command never spawned — and a non-shell tool never proves a shell ask at all) and fires the consented background install. |

**Permission prediction.** Before wrapping, the plugin asks the same
question the permission system will: it loads the effective ruleset (`rules.js` —
the agent's rules from `agent.get` (`data.permissions`, base policy first)
plus the session's if present) and mirrors the harness's own matching
(`Wildcard.match` — including `git status *` matching bare `git status` —
last matching rule wins, no match → `ask`). Predicted **deny** or **allow**
→ the plugin does nothing: a configured deny stays final with the harness,
and an allow-listed command (which may legitimately need network, e.g.
`git push`) runs exactly as configured. Only a predicted **ask** is a
candidate for wrapping. The prediction sees configured rules only, not
runtime "allow always" approvals (unreadable from the plugin API): a
saved-approved command may be predicted `ask` and wrapped — safe
direction, and `excludedCommands` covers any command that must never be
wrapped.

**State is per command text** (and per `&&`, `||`, `;`, `|`-separated
segment of it): failure memory and the lifetime attempt cap are keyed the
same way, so one sandbox-burned piece holds a later compound's retry
back. All state is in-memory per plugin instance — nothing persists
across sessions, and a reload resets it. Crucially the agent-ruleset
cache is per plugin *instance*, not per module: a config edit that
rebuilds the plugin in the same process gets a COLD cache and re-reads
the agent rules, so a rule added mid-session takes effect on the next
command. There are no verdicts: the decision and the wrap happen
together, before the permission check.

**Scope: compound commands are now supported.** A command is wrapped
when `segments.js` (the feature's single shared parser) accepts its shape
and every segment would ASK under the effective rules — the same
eligibility chain as a simple command, applied per segment. The supported
grammar is commands joined at top level by `&&`, `||`, `;`, `|`, or a
raw newline (blank lines between commands are dropped), with normal
quoting (`'…'` literal, `"…"` with backslash escapes, unquoted backslash
escapes) and legal fd-dup redirects (`2>&1`, `>&2`, `<&0`). Rejected
shapes — which follow the normal permission flow, exactly as before — are:
subshells `( … )`; command substitution `$( … )` / backticks; process
substitution `<(` / `>(`; heredocs `<<`; backgrounding `&`; the bashisms
`&>`, `>&&`, `<&>`, `|&`; ANSI-C quoting `$'…'`; unquoted `#` comments;
unbalanced quotes; and an empty segment at an operator boundary (trailing
`&&`, `a ;; b`). The segmenter's accept-set is deliberately *narrower*
than the shell scanner's, so anything that cannot be predicted faithfully
is left unwrapped rather than mis-predicted.

**Deny is sacred across both permission actions.** Prediction runs over
the two assert sets core runs: the `shell` action (one resource per
segment) and the `external_directory` action (one per `cd`/`pushd`/…
segment's resolved directory). A deny on *either* action for *any* segment
makes the whole compound skip — the harness denies the invocation before
anything prompts. All-allow on both → skip too (runs exactly as
configured). Only an ask somewhere falls through to the eligibility
chain. A wrap suppresses the `external_directory` assert entirely (the
wrapped command's scan sees only the sandbox runner), which is why the
prediction must mirror it here.

**`srt` invocations are never sandboxed.** If any segment of the command
has `srt` as its first token (`srt -- npm test`, `cd x && srt -- make`),
the command is left to normal permissions — the agent is deliberately
sandboxing on its own; no double-sandboxing. (This check is per-segment,
so a compound is excluded when any single segment invokes `srt`.)

**`unsandboxed --` runs a command outside the sandbox on purpose.** If any
segment of the command has `unsandboxed` as its first token
(`unsandboxed -- ssh heart-of-gold`, `cd x && unsandboxed -- make`),
the plugin strips the marker and leaves the underlying command to the
normal permission flow — it asks, and on approval runs unsandboxed. Use
this when the sandbox would (correctly) block the command but the work
genuinely needs outside access; the marker is per-segment, so a compound
is unsandboxed when any single segment carries it, and quoted content
inside a segment's args never counts.

**`excludedCommands` is per-segment.** A compound is excluded when any
single segment matches a pattern (pattern semantics unchanged —
`docker compose *` matches the base command alone or followed by
arguments, a boundary, not `docker composese`; anything else is an exact
match). Quoted content inside a segment's args (`echo "docker compose"`)
never counts as a segment. When the segmenter rejects the shape, the
full text is matched exactly as before, keeping the check total.

## Install

Symlink the plugin directory into `~/.config/opencode/plugins/sandbox`:

```sh
ln -s /path/to/agent-kit/opencode/plugins/sandbox \
  ~/.config/opencode/plugins/sandbox
```

and pass options with the V1-style tuple entry, which V2 also accepts:

```json
{
  "plugin": [["/home/user/.config/opencode/plugins/sandbox", {}]]
}
```

with options in the tuple's second element:

```json
{
  "plugin": [[
    "/home/user/.config/opencode/plugins/sandbox",
    { "install": "ask", "network": { "allowedDomains": ["registry.npmjs.org"] } }
  ]]
}
```

(V2-native configs use `plugins: [{ "package": "...", "options": {…} }]`.)

The plugin loads with `@anthropic-ai/sandbox-runtime` **absent** — only
`runtime.js` ever imports it — and the first sandbox-eligible command asks
to install it (see *Install consent*). A developer checkout can pre-install
instead: `npm install` in `opencode/plugins/sandbox`.

## Options

Defaults from `config.js`'s `resolveOptions` (malformed values fall back to
that field's default; nothing throws):

| Option | Default | Notes |
|---|---|---|
| `enabled` | `true` | `false` registers no hooks at all |
| `install` | `"ask"` | `"ask"` = consent prompt on first need; `"never"` = inert while the package is missing |
| `requireSeccomp` | `false` | `true` = the plugin stays inert instead of degrading when the self-test shows seccomp Unix-socket blocking is unavailable |
| `network.allowedDomains` | `[]` | the only domains sandboxed commands may contact (wildcards + optional `:port`, per the library grammar); `[]` = all egress denied |
| `network.deniedDomains` | `[]` | domains always denied |
| `filesystem.denyRead` | the 13 paths below | sensitive paths the sandbox refuses to read; extras extend, never replace, the defaults |
| `filesystem.allowWrite` | `[]` | extra writable roots; every run also allows the command's cwd, the system tmpdir, and — in a linked worktree — the shared git dir |
| `filesystem.denyWrite` | `[]` | extra never-writable paths; every run also denies `<cwd>/.git/config` and `<cwd>/.git/hooks` (plus the shared git dir's) |
| `credentials.envVars` | the 8 names below | scrubbed inside the sandbox; a bare string denies, an object `{ "name": …, "mode": "deny" }` sets the mode, a same-name entry overrides the default |
| `excludedCommands` | `[]` | never sandboxed, matched per segment: a compound is excluded when any single segment matches (quoted content inside a segment's args never counts as a segment); `docker compose *` matches the base command alone or followed by arguments (a boundary — not `docker composese`); anything else is an exact match; an unparseable shape falls back to matching the full text |
| `classifier` | `{ "enabled": false, "providerID": "litellm", "id": "jev-1.13" }` | opt-in pre-classification, see *The classifier* |
| `maxSandboxAttempts` | `3` | lifetime cap of sandboxed runs per command text (a backstop, not the primary mechanism) |
| `failureMemorySec` | `1800` | how long a sandbox-blocked command is remembered — its retry asks |

Default `filesystem.denyRead`: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`,
`~/.netrc`, `~/.config/gh`, `~/.password-store`, `~/.docker/config.json`,
`~/.config/opencode`, `~/.local/share/opencode`, `~/.claude`,
`~/.claude.json`, `~/.env`.

Default `credentials.envVars` (denied): `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `LITELLM_API_KEY`.

## Flows

### Availability self-test (first use)

Usability is proven live, once per process, at the first sandbox-eligible
command (a successful install clears the memo, so the next command
re-probes): initialize the production base config (built from your
options, validated against the package's own `SandboxRuntimeConfigSchema`,
falling back to a hardcoded safe config — deny-all network, default
deny-reads, scrubbed env — if validation fails), wrap the trivial command
`true`, and spawn it.

- Exit 0 → **seccomp mode**: full containment, including seccomp
  Unix-socket blocking.
- The wrapped `true` dies with the `apply-seccomp` startup signature —
  Ubuntu's AppArmor policy capability-strips the vendored
  `apply-seccomp` helper's nested userns, either through the
  `kernel.apparmor_restrict_unprivileged_userns=1` restriction or,
  independently of that sysctl, through the hardened
  `bwrap-userns-restrict` profile — so every seccomp-mode command exits
  before running — → **one** automatic retry
  with `network.allowAllUnixSockets: true`, which skips apply-seccomp
  entirely and runs in bwrap's own namespaces: **degraded mode**.
  Filesystem and network isolation are unaffected; Unix-socket blocking
  is off. Every degraded initialize logs:

  ```
  [sandbox] seccomp sandbox unavailable on this host (…) — running degraded with network.allowAllUnixSockets: true, so unix-socket blocking is off; host fix: sysctl kernel.apparmor_restrict_unprivileged_userns=0; if instead the kernel log shows unpriv_bwrap sys_admin denials (`journalctl -k`), Ubuntu's hardened bwrap-userns-restrict AppArmor profile is the blocker — no bwrap child can regain CAP_SYS_ADMIN while it is loaded, sysctl or not — disable or replace it (weigh the trade-offs first)
  ```

- `requireSeccomp: true` keeps the plugin inert instead of degrading —
  the retry never runs, the self-test answers
  `seccomp-unavailable (…)`, and eligible commands keep asking (run
  unsandboxed on approval).
- The self-test is also the initialization: the library's `initialize()`
  is first-call-wins, so the config the self-test proved — seccomp or
  degraded — is what every later command runs under.
- Fix the host — see "The degraded-mode warning" under Troubleshooting
  for which of the two AppArmor mechanisms blocks you and what each fix
  costs — and the next process's self-test lands in seccomp mode with no
  config change: the plugin self-strengthens.
- `SandboxManager.checkDependencies()` is never the gate — it reports
  clean on the AppArmor-restricted hosts above while every seccomp-mode
  command dies. It only names missing binaries; the spawned self-test
  decides.

### Install consent

The first sandbox-eligible command with the package missing (and
`install: "ask"`) asks with:

> Sandbox runtime not installed. Approving runs this command with normal
> permissions and installs @anthropic-ai/sandbox-runtime into the plugin
> directory (a local npm install, no sudo) in the background, so
> subsequent commands run sandboxed. Denying falls back to normal
> permissions.

Approval is proven by the command reaching `status: "completed"` at
`execute.after` — a rejected ask fires `execute.after` with
`status: "error"` and proves nothing — and only then does
`npm install --save @anthropic-ai/sandbox-runtime@^0.0.79` run in the
plugin directory (120-second timeout, fire-and-forget). From the next
command on, the availability memo is re-probed and sandboxing is active.
A denial (or a repeated consent ask while the consent is still pending —
an approval would have executed) makes the plugin **inert for the
session**: normal permission rules resume, no repeat prompts.
`install: "never"` never asks: the plugin is inert while the package is
missing, with a one-time message. Edge case, accepted deliberately: an
approved consent whose command then *fails* does not install, and the
surviving consent reads as a decline on the next decide — the safe
direction for a consent mechanism. If instead the install is APPROVED
but the local `npm install` itself FAILS (an offline host, a registry
error), the command already ran unsandboxed and nothing is retained: the
next command raises a FRESH consent ask. The "no repeat prompts" promise
above is about DENIALS; a failed install is a different thing and the
user is asked again, because the sandbox is still missing.

### Escape hatch

A command the sandbox actually **blocked** — violations attributed to its
`commandId`, or one of the denial markers below in its output — is
remembered for `failureMemorySec` (default 30 minutes), per command text
and per compound segment. Retrying it asks; once approved, it runs
unsandboxed. A command that failed for its own reasons (failing tests, a
typo) is **not** remembered — its retries stay prompt-free. Violations on
a run that *succeeded* are annotated lightly but never recorded — its
retry must not run unsandboxed where it could read deny-read paths.

The denial markers (`violations.js`'s `SANDBOX_DENIAL_MARKERS`):

- `Read-only file system`
- `Operation not permitted`
- `Connection blocked by network allowlist`
- `blocked by sandbox-runtime`
- `connection not allowed by ruleset`
- `Could not resolve host`

The first two are the kernel errnos of filesystem denials, which the
violation store does not attribute on Linux (network denies are
attributed — see *Probe findings*). `Could not resolve host` is weak but
sandbox-indicative under the default deny-all DNS: a marker false
positive costs one extra prompt, the safe direction. A denied *read*
hides the path as `No such file or directory` — deliberately not a
marker, it is indistinguishable from a genuinely missing path.

### The classifier (opt-in)

Before wrapping, the plugin can ask `litellm`/`jev-1.13` whether the
command would **succeed** under the policy — allowed domains, write
roots, and denied reads are inlined in the prompt; reading outside the
working directory is allowed, so it never makes a command unsafe. `SAFE`
→ the sandbox attempt proceeds (which can only fail into an ask); `UNSAFE`
→ the command asks directly with the model's one-line reason:
`Classifier: <reason>`. Any error, timeout, or unparseable answer is
treated as `SAFE` — a sandboxed failure can only escalate into a
permission ask, never a silent unsandboxed run. Verdicts are cached per
command for the plugin's lifetime; failed model calls are not cached, so
a recovered gateway is re-asked. Enable with
`classifier: { "enabled": true }`; while disabled, `ctx.generate` is
never called.

## Failure behavior

| Situation | Behavior |
|---|---|
| ask-bound command, sandbox-eligible | runs sandboxed with no prompt, annotated result |
| the sandbox blocks it (network / write / denied read) | failure remembered + annotated; the retry asks and runs unsandboxed on approval |
| command fails for its own reasons | normal failure; retries stay prompt-free |
| unparseable compound shape (subshell, `$( )`, heredoc, background `&`, unbalanced quote, …) | never wrapped — normal permission flow (documented scope) |
| predicted `allow` (allow-listed command) | never wrapped — runs exactly as configured |
| predicted `deny` | never wrapped — the harness's denial stays final |
| package missing | consent ask (`install: "ask"`) or inert (`"never"`) |
| install approved and the command completed | background install; from the next command on, sandboxed |
| install declined (or consent re-asked, or the approved command itself failed) | inert for the session (the last case is the safe direction: no install without a proven grant); normal permissions |
| seccomp unavailable on the host | one degraded retry (Unix sockets unrestricted) + warning; `requireSeccomp: true` → inert |
| self-test fails entirely | inert + one-time message naming the reason |
| `bwrap`/`socat` missing | inert + one-time message with the install hint |
| classifier error / unavailable | treated as `SAFE`; the sandbox attempt runs |
| malformed options | per-field defaults; setup never crashes |

## Probe findings

From the Task 1 probe (`probe/probe.mjs`, `probe/import-check.mjs`),
2026-10-09:

- **Import resolution**: the bare specifier
  `@anthropic-ai/sandbox-runtime` resolves both directly and through a
  symlinked entry path (the probe's `/tmp/sandbox-plugin-link` — the same
  shape as `~/.config/opencode/plugins/sandbox` → repo), so the documented
  wiring needs no absolute-path fallback.
- **Host mode**: this workstation is `HOST-MODE: seccomp` (Ubuntu
  26.04.1 as of 2026-10-14, after setting
  `kernel.apparmor_restrict_unprivileged_userns=0` **and** disabling the
  hardened `bwrap-userns-restrict` profile — see "The degraded-mode
  warning" for why both levers were needed; before that, and on any
  Ubuntu with that profile loaded, the vendored `apply-seccomp` helper is
  capability-stripped and every seccomp-mode wrapped command dies at
  startup with `apply-seccomp: write /proc/self/setgroups …: Permission
  denied`, making the degraded fallback the steady state).
  `node probe/probe.mjs` re-checks it (on this host it prints 4/4 PASS
  with two attribution SKIPs, final line `HOST-MODE: seccomp`, exit 0).
- **Violation attribution is partial on Linux**: network denies are
  attributed (proxy-side, keyed by the `commandId` embedded in the proxy
  auth — `deny network-outbound example.com:443 (host is not on the allow
  list)`); filesystem denies are unattributed kernel errnos — hence
  `SANDBOX_DENIAL_MARKERS`.
- **`SandboxManager.checkDependencies()` is blind to the AppArmor
  restriction** — it reports clean while every seccomp-mode command dies;
  hence the spawned self-test is the availability gate.
- **`npm audit`: 2 high** in `node-forge` (GHSA-86w9-cpqp-85rv, a
  transitive dependency of sandbox-runtime used by its MITM CA). npm's
  only offered fix downgrades sandbox-runtime to 0.0.50 (breaking); not
  taken.

## Troubleshooting

- **`Sandbox unavailable (missing-dependencies: …)` once, then nothing.**
  The Linux sandbox needs `bwrap` and `socat` (and `rg`) on PATH. Install
  them: `sudo apt-get install bubblewrap socat` (Debian/Ubuntu) or
  `sudo dnf install bubblewrap socat` (Fedora). The plugin never
  sudo-installs; it goes inert for the session.
- **I declined the install — how do I re-enable?** The decline flag is
  in-memory for the plugin's lifetime. Reload the plugin (restart the
  session / reload the config) and the next eligible command asks again.
- **The degraded-mode warning.** `[sandbox] seccomp sandbox unavailable
  on this host (…) — running degraded with network.allowAllUnixSockets:
  true, so unix-socket blocking is off; host fix: …` means: the vendored
  `apply-seccomp` helper cannot get its nested user namespace, so the
  plugin fell back to bwrap-namespace mode. Filesystem and network
  isolation are unaffected, but sandboxed processes *can* reach host
  Unix sockets visible inside the sandbox (e.g. `/var/run/docker.sock` —
  effectively root on a Docker host). Two different AppArmor mechanisms
  cause this and they need different fixes — tell them apart with
  `journalctl -k | grep apparmor` after a failed self-test:
  - `profile="unprivileged_userns"` denials: the
    `kernel.apparmor_restrict_unprivileged_userns` restriction is the
    blocker. Set it to `0` (persist under `/etc/sysctl.d/`).
  - `profile="unpriv_bwrap"` `capname="sys_admin"` denials: Ubuntu's
    hardened `bwrap-userns-restrict` profile is the blocker (shipped
    enabled on 26.04). It stacks a capability-deny onto every bwrap
    child, and inside bwrap `no_new_privs` means profiles can only
    *stack* onto the child's profile, never replace it — so no
    in-sandbox process can regain `CAP_SYS_ADMIN`, sysctl or not, and a
    `userns` profile for `apply-seccomp` itself cannot help. The only
    fixes are disabling or replacing that profile (`disable/` symlink +
    `apparmor_parser -R`) — which also drops its mitigation for every
    other bwrap user, flatpak included — or accepting degraded mode.

  After the fix, the next process self-strengthens to seccomp mode.
  `requireSeccomp: true` makes the plugin inert instead.
- **Why did my command still ask?** In order of likelihood: (1) it — or a
  segment of it — was **sandbox-blocked within the last
  `failureMemorySec`** (30 min default); the retry is the escape hatch.
  (2) It hit the **attempt cap** — `maxSandboxAttempts` (3) sandboxed runs
  per command text, lifetime. (3) The **classifier** answered `UNSAFE`
  (the ask carries `Classifier: <reason>`). (4) It matches
  **`excludedCommands`**, or a segment invokes **`srt`**. (5) The package
  is missing and `install` is `"never"` (or was declined).
- **Why did my command run unsandboxed after approval?** That is the
  escape hatch — the sandbox blocked it (check the `[sandbox] blocked by
  the sandbox (…)` annotation), so the retry asks and approval grants the
  unsandboxed run.
- **The classifier never fires.** It is disabled by default; enable with
  `classifier: { "enabled": true }` in the plugin's tuple options (it
  uses `litellm`/`jev-1.13` unless overridden). While disabled,
  `ctx.generate` is never called.

## Known limitations

- **Compound commands are now supported (parseable shapes).** A
  command joined by `&&`, `||`, `;`, `|`, or a raw newline is wrapped
  when `segments.js` accepts the shape and every segment would ASK under
  the effective rules — deny on *either* the `shell` or the
  `external_directory` action for any segment still wins (the harness
  denies before anything prompts), and all-allow on both runs exactly as
  configured. The permission prediction runs per segment, and the evaluate
  recognizer keys on the *wrapped* string (which the wiring dual-indexes
  under the original text), so compounds flip to allow exactly like simple
  commands. Unparseable shapes (subshells, `$( )`, heredocs, background
  `&`, unbalanced quotes, …) are still never wrapped and follow the normal
  permission flow — a documented scope, not a silent hole.
- **Multi-line scripts are supported when parseable** — blank lines
  between commands are dropped (a script ending in a newline is normal).
  Backgrounded commands (`&`) and the bashisms (`&>`, `>&&`, `<&>`,
  `|&`) are still never wrapped, and fd-dup redirects (`2>&1`, `>&2`)
  are legal inside a segment. A single command containing a raw newline
  that is *not* a separator boundary is not a supported shape and stays
  unwrapped (failing safe).
- **The prediction cannot see runtime "allow always" approvals.** They
  live in the permission store, which the plugin API does not expose, so
  a saved-approved command may be predicted `ask` and wrapped. Safe
  direction (a wrapped read-only command behaves identically); a wrapped
  network command fails and its retry asks. This drift now applies to
  compounds too — a compound that is allow-listed at runtime but predicted
  `ask` is wrapped, and its retry follows the normal flow. List any
  command that must never be wrapped in `excludedCommands` (matched
  per-segment).
- **The session directory, not the command's `workdir`, scopes the
  sandbox.** The `shell.create.before` hook (which carried the per-command
  cwd) is gone in v2, so the wrap uses the session's location directory;
  a command with an explicit `workdir` outside it gets the
  location-scoped sandbox (fails safe: its writes are denied, it fails,
  and the retry prompts).
- **Filesystem denial attribution is partial on Linux.** A denied write or read is a kernel errno (`Read-only file system`, `Operation not permitted`, or a hidden path), not a violation event — network denies (proxy) and Unix-socket denies (seccomp) are attributed. The escape-hatch detector therefore pairs violation attribution with denial-marker matching; a denied *read* that hides a path as `No such file or directory` is indistinguishable from a genuine missing file and is not detected.

## Development

```bash
npm test              # node --test — 238 tests, no network
node probe/probe.mjs  # prints the host-mode verdict: HOST-MODE: seccomp | no-seccomp
```

Modules: `index.js` (hook wiring) · `policy.js` (the pre-permission
decide gate) · `rules.js` (local permission prediction) · `config.js`
(options → configs) · `runtime.js` (lazy import, self-test, consented
install) · `classifier.js` (jev pre-check) · `violations.js`
(attribution + annotation).

## Live drills

A copy-pasteable runbook (the spec's Testing section) against a live
OpenCode session. Setup: make the wildcard shell rule `ask` — only
predicted-ask commands are ever wrapped:

```json
"permission": { "bash": { "*": "ask" } }
```

1. **First-call wrap, no prompt.** In a FRESH session, as the very first
   tool call, run a command no allow rule covers, e.g. `node -e
   "console.log('hi')"`. Expected: no prompt; it runs **sandboxed even
   as the first call** (the wrap happens before the permission check);
   the result is annotated `(ran in sandbox: writes limited to <cwd>;
   network denied except configured domains)`.
2. **Escape hatch.** `touch ~/x` — runs sandboxed, fails with `touch:
   cannot touch '/home/user/x': Read-only file system` (the home
   directory is outside the write roots), annotated as blocked. Retry
   the same command: it asks (failure memory). Approve: runs
   unsandboxed, succeeds.
3. **Network deny (default deny-all).** `curl https://example.com` —
   runs sandboxed, fails with an attributed network violation (`deny
   network-outbound example.com:443 (host is not on the allow list)`;
   curl exits 7 through the sandbox's denied proxy). The retry asks;
   approve → unsandboxed. (With the classifier on — drill 5 — it asks
   up front instead.)
4. **Install consent.** Rename the package directory away — `mv
   …/opencode/plugins/sandbox/node_modules
   …/opencode/plugins/sandbox/node_modules.away` (approved) — then run
   an eligible command. Expected: the ask carries the consent message
   (approval = run normally now + the local `npm install` in the
   background; from the next command on, sandboxed). Approve → the
   command runs and the install completes in the background; the next
   eligible command runs sandboxed with no prompt. To drill the denial:
   decline instead — the plugin goes inert for the session; later
   commands just follow normal permissions, no repeat consent asks.
   Rename back afterward.
5. **Classifier on.** Set `classifier: { "enabled": true }` in the
   tuple options and reload, then run a network-needing command, e.g.
   `curl https://example.com`. Expected: it asks directly — no sandboxed
   attempt — with the jev reason quoted (`Classifier: <one-line
   reason>`).
6. **`PATH` without `bwrap` → inert.** Launch a session whose PATH
   excludes `bwrap`/`socat` (and `rg`) — e.g. a bin dir of symlinks to
   only the needed binaries:

   ```sh
   mkdir -p /tmp/opencode-nobwrap
   for b in node npm npx git sh bash opencode; do ln -s "$(command -v "$b")" /tmp/opencode-nobwrap/; done
   env PATH=/tmp/opencode-nobwrap opencode
   ```

   Then run an eligible command. Expected: the ask carries the one-time
   message `Sandbox unavailable (missing-dependencies: …) — approving
   runs the command unsandboxed (normal permissions).` (naming the
   binaries absent from that PATH). Approve → it runs unsandboxed;
   later commands ask normally, without the message (one-time). Delete
   `/tmp/opencode-nobwrap` afterward.
7. **Classifier pointed at a dead model → fail-toward-sandbox.** Set
   `classifier: { "enabled": true, "id": "no-such-model" }` in the tuple
   options and reload, then run an eligible command, e.g.
   `node -e "console.log('hi')"`. Expected: the generate call fails, the
   plugin logs `[sandbox] classifier unavailable (…) — treating the
   command as sandbox-eligible`, and the command still runs sandboxed
   with no prompt — a classifier failure can only fall toward the
   sandbox attempt. Restore the real model id afterward.

**Sandbox self-check** — run these as ordinary commands under the ask
rule (each gets auto-allowed and sandboxed); both must *fail* inside the
sandbox — and then ask on retry, the escape hatch at work — which is the
evidence containment is actually enforced:

```sh
touch ~/sandbox-probe                      # must fail: Read-only file system
curl --noproxy '*' https://example.com     # must fail: Could not resolve host
```

`touch ~/sandbox-probe` proves writes outside the working directory are
blocked; `curl --noproxy '*'` bypasses the sandbox's HTTP proxy, proving
direct DNS/network egress is denied too.
