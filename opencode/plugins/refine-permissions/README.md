# refine-permissions

OpenCode v2 plugin that keeps this machine's shell allowlist converging on
real usage. It ships a `refine-permissions` skill: when invoked, the skill
analyzes recent agent session history, proposes a batch of safer allowlist
rules, and applies the accepted rules to the global OpenCode config.

## Install

Add the plugin to the global config (`~/.config/opencode/opencode.json`):

```jsonc
{
  "plugins": [
    "/home/user/workspace/agent-kit/opencode/plugins/refine-permissions"
  ]
}
```

The path is the merged checkout; point it at a worktree path while testing.
OpenCode loads the plugin on next start (or on config reload), which registers
both the `refine_permissions` tool and the skill.

## Usage

In any session, ask to refine permissions (for example: "refine my
permissions"). The skill:

1. Calls `refine_permissions` with `mode: "analyze"` — the window is the last
   7 days, truncated at the previous analysis (stored in plugin storage).
2. Prints a batch summary: each proposed pattern with its run count and
   example commands.
3. Asks once: **Accept all** / **Fine-tune** / **Reject**.
4. On acceptance, applies the rules with `mode: "apply"` and reports the
   backup file path.

Only rules that survive the safety gate are ever written.

## What it proposes

Read-only command families actually run in the window, as
`"<family> *"` patterns — for example `sort *`, `cut *`, `pgrep *`,
`git fetch *`, `git for-each-ref *`, `systemctl status *`, `dpkg -l *`.

Multi-subcommand tools (`git`, `gh`, `docker`, `systemctl`, `dpkg`, `kubectl`,
`git-spice`/`gs`) propose only their read-only subcommands. Everything else on
the denylist is never proposed: code-execution wrappers and local script paths
(`bash`, `node`, `python3`, `bin/…`), destructive filesystem mutations
(`rm`, `mv`, `chmod`, …), process control, network egress (`curl`, `ssh`,
`wget`, …), privilege/system changes, mutating package managers, and git
mutations (`reset`, `clean`, `push --force`, …).

Coverage is computed against **allow** rules only — a broad `"*": "ask"`
never hides a safe proposal, and a rule that already permits the family makes
it `alreadyPresent`.

## Applying changes

- Edits are anchored text insertions into the JSONC, right after the broad
  `"*": "ask"` rule, so last-match-wins keeps the new allow effective and
  trailing `deny` rules stay last. Comments and existing rules are untouched.
- Every apply first writes
  `opencode.json.pre-refine-permissions-backup-<epoch>.json` beside the
  config, then re-parses the result; a failed write restores the backup.
- Scope: the global config only. The plugin reads `opencode.db`
  (`$XDG_DATA_HOME`-aware) and never writes project configs.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "/abs/path/opencode/plugins/refine-permissions",
      "options": { "minCount": 3, "days": 7 }
    }
  ]
}
```

- `minCount` — minimum runs in the window before a family is proposed
  (default 3).
- `days` — maximum window length, capped at 7 (default 7).
- `configPath` — override the config file to update (default: the global
  file, `$XDG_CONFIG_HOME`-aware).

To change the safety policy itself, edit `SAFE_SUBCOMMANDS` and the denylist
sets in `policy.js` and run `npm test`.

## Tests

```sh
npm test
```
