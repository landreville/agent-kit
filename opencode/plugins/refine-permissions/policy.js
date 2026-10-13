// policy.js — command-family extraction and safety policy for refine-permissions.
//
// Two levels live here: mechanical splitting/extraction of command families
// (this file) and the safety decisions that turn families into proposed
// allowlist patterns (Task 2 adds those exports below as they are tested).

export const MULTI_TOKEN_TOOLS = new Set([
  "git",
  "gh",
  "docker",
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "uv",
  "pip",
  "pip3",
  "cargo",
  "go",
  "opencode",
  "kubectl",
  "systemctl",
  "git-spice",
  "gs",
  "dpkg",
])

// A leading assignment is only skipped when the WHOLE token is a simple
// scalar assignment: `KEY=$(python3 …` is a substitution, not an assignment.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:@%+,-]*$/

// Split one command string into pipeline/sequence segments. Splitting is
// quote-aware: a separator inside quotes does not split, and an unterminated
// quote consumes the rest of the string (best effort, like OpenCode's own
// shell scanner).
export function splitSegments(command) {
  const text = (typeof command === "string" ? command : "").split("\n")[0] ?? ""
  const segments = []
  let current = ""
  let quote = null
  const push = () => {
    const trimmed = current.trim()
    if (trimmed) segments.push(trimmed)
    current = ""
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === "|") {
      if (text[i + 1] === "|") i++
      push()
      continue
    }
    if (ch === "&" && text[i + 1] === "&") {
      i++
      push()
      continue
    }
    if (ch === ";" || ch === "\n") {
      push()
      continue
    }
    current += ch
  }
  push()
  return segments
}

const stripEnvAssignments = (segment) => {
  const tokens = segment.trim().split(/\s+/)
  while (tokens.length > 0 && ENV_ASSIGNMENT.test(tokens[0])) tokens.shift()
  return tokens
}

// Family of one segment: first token, two tokens for multi-subcommand tools
// (a leading flag like `git -C dir …` stays depth-1), env assignments skipped.
const familyOfSegment = (segment) => {
  const tokens = stripEnvAssignments(segment)
  if (tokens.length === 0) return null
  const [first, second] = tokens
  if (MULTI_TOKEN_TOOLS.has(first) && second && !second.startsWith("-")) {
    return `${first} ${second}`
  }
  return first
}

export function extractFamilies(command) {
  const families = []
  for (const segment of splitSegments(command)) {
    const family = familyOfSegment(segment)
    if (family && !families.includes(family)) families.push(family)
  }
  return families
}

// --- Safety policy -----------------------------------------------------------------

// Subcommands that are read-only per tool. `canonicalFamily` proposes only
// these patterns for multi-subcommand tools; anything else under those tools
// is denied.
export const SAFE_SUBCOMMANDS = new Map([
  ["git", [["status"], ["diff"], ["log"], ["show"], ["blame"], ["branch"], ["remote", "-v"],
    ["rev-parse"], ["ls-files"], ["describe"], ["shortlog"], ["for-each-ref"], ["rev-list"],
    ["count-objects"], ["fetch"], ["config", "--list"], ["config", "--get"],
    ["config", "credential.helper"], ["config", "--global", "credential.helper"],
    ["tag", "-l"], ["stash", "list"], ["worktree", "list"], ["reflog"], ["symbolic-ref"]]],
  ["gh", [["pr", "list"], ["pr", "view"], ["pr", "status"], ["pr", "diff"], ["pr", "checks"],
    ["pr", "reviews"], ["issue", "list"], ["issue", "view"], ["issue", "status"],
    ["repo", "view"], ["run", "list"], ["run", "view"], ["workflow", "list"],
    ["workflow", "view"], ["release", "list"], ["release", "view"], ["status"],
    ["auth", "status"]]],
  ["docker", [["info"], ["ps"], ["images"], ["version"], ["compose", "ps"], ["compose", "ls"],
    ["compose", "logs"]]],
  ["systemctl", [["status"], ["--user", "status"], ["list-units"], ["--user", "list-units"],
    ["list-unit-files"], ["--user", "list-unit-files"], ["is-active"], ["is-enabled"], ["show"]]],
  ["dpkg", [["-l"], ["-L"], ["-s"], ["-V"]]],
  ["kubectl", [["get"], ["describe"], ["logs"], ["top"], ["api-resources"], ["explain"]]],
  ["git-spice", [["ls"], ["log"], ["status"], ["top"], ["bottom"], ["trunk"],
    ["branch", "ls"], ["stack", "ls"]]],
  ["gs", [["ls"], ["log"], ["status"], ["top"], ["bottom"], ["trunk"],
    ["branch", "ls"], ["stack", "ls"]]],
])

const CODE_EXECUTION = new Set([
  "bash", "sh", "zsh", "fish", "dash", "ksh", "node", "python3", "python", "ruby",
  "perl", "php", "java", "deno", "bun", "npx", "env", "command", "timeout", "nohup",
  "xargs", "eval", "exec", "source", "screen", "tmux", "parallel", "watch", "uv",
  "srt", // the local sandbox wrapper: `srt -- <anything>`
])

// Tools that mutate display or session state.
const DISPLAY_SYSTEM = new Set(["xrandr", "kwin_wayland", "wlr-randr", "kreadconfig5"])

const DESTRUCTIVE_FS = new Set([
  "rm", "rmdir", "mv", "cp", "chmod", "chown", "dd", "mkfs", "shred", "tee",
  "truncate", "ln", "unlink", "touch", "install", "rsync", "usermod", "useradd", "userdel",
])

const PROCESS_CONTROL = new Set(["kill", "pkill", "killall", "reboot", "shutdown", "halt", "poweroff"])

const NETWORK = new Set(["curl", "wget", "nc", "ncat", "telnet", "ssh", "scp", "sftp", "ftp", "http", "https"])

const PRIVILEGE = new Set([
  "sudo", "su", "doas", "service", "iptables", "nft", "ufw", "mount", "umount",
  "modprobe", "insmod", "crontab", "at", "visudo", "passwd", "chpasswd",
])

const PACKAGE_MANAGERS = new Set(["apt", "apt-get", "pip", "pip3", "gem", "npm", "yarn", "pnpm"])

// Read-only exceptions for package tools that also mutate.
const DPKG_READ_FLAGS = new Set(["-l", "-L", "-s", "-V"])
const BUNDLE_READ_SUBCOMMANDS = new Set(["list", "info", "show"])

const GIT_MUTATIONS = new Set([
  "reset", "clean", "checkout", "switch", "restore", "rebase", "update-ref",
  "filter-branch", "gc", "prune",
])

// Tokens that are shell syntax, never commands: a `for *` rule would match a
// whole compound command in OpenCode's glob matching, which is arbitrary code.
const SHELL_KEYWORDS = new Set([
  "for", "if", "then", "elif", "else", "fi", "while", "until", "do", "done",
  "case", "esac", "function", "select", "time", "{", "}", "(", ")", "[[", "]]",
  "EOF", "in",
])

// Multi-purpose tools that execute code or drive the system: proposing
// `<tool> *` would approve far more than reading.
const CODE_EXECUTING_TOOLS = new Set([
  "ansible", "ansible-playbook", "busctl", "claude", "opencode", "make",
  "cmake", "cc", "gcc", "clang", "rustc", "patch", "ddcutil",
  "kscreen-doctor", "nvidia-settings", "tea", "systemd-run",
])

// Anything that is not a plausible command name (variables, operators, …).
const COMMAND_TOKEN_SHAPE = /^[A-Za-z0-9._-]+$/

const startsWith = (tokens, entry) =>
  entry.length <= tokens.length && entry.every((token, i) => tokens[i] === token)

const isPathToken = (token) => token === "." || token === ".." || token.startsWith("./") || token.includes("/")

// Reason a segment's family is not safe to auto-allow, or null when it is.
// Accepts a whole command (first line/segment used) or a plain family string.
export function familyDenied(command) {
  const tokens = stripEnvAssignments(splitSegments(command)[0] ?? "")
  if (tokens.length === 0) return null
  const [first, second] = tokens

  if (isPathToken(first)) return "code execution: local script or interpreter path"
  if (SHELL_KEYWORDS.has(first)) return "shell keyword, not a command"

  if (first === "dpkg") return DPKG_READ_FLAGS.has(second) ? null : "package manager mutation"
  if (first === "bundle") return BUNDLE_READ_SUBCOMMANDS.has(second) ? null : "package manager mutation"

  if (first === "git") {
    if (second === "push" && ["--force", "-f", "--force-with-lease", "--force-with-lease=ref"].includes(tokens[2])) {
      return "destructive git mutation"
    }
    if (GIT_MUTATIONS.has(second)) return "destructive git mutation"
  }

  // Named dangerous groups first so their reasons win over the generic ones.
  if (CODE_EXECUTION.has(first)) return "code execution wrapper"
  if (DESTRUCTIVE_FS.has(first)) return "destructive filesystem mutation"
  if (PROCESS_CONTROL.has(first)) return "process control"
  if (NETWORK.has(first)) return "network egress"
  if (PRIVILEGE.has(first)) return "privilege or system mutation"
  if (DISPLAY_SYSTEM.has(first)) return "display or system state mutation"
  if (PACKAGE_MANAGERS.has(first)) return "package manager mutation"

  // Multi-subcommand tools with no read-only policy propose nothing.
  if (MULTI_TOKEN_TOOLS.has(first) && !SAFE_SUBCOMMANDS.has(first)) {
    return "multi-subcommand tool without a read-only subcommand policy"
  }

  // In-place editors mutate files even though their reads look harmless.
  if (first === "sed" && tokens.some((token) => token === "-i" || token.startsWith("-i") || token === "--in-place")) {
    return "in-place file mutation"
  }
  if (first === "awk" && tokens.some((token) => token === "-i" || token.startsWith("-i") || token === "--in-place")) {
    return "in-place file mutation"
  }

  if (CODE_EXECUTING_TOOLS.has(first)) return "code execution or system mutation"

  if (!COMMAND_TOKEN_SHAPE.test(first)) return "unrecognized command token"

  const entry = SAFE_SUBCOMMANDS.get(first)
  if (entry && !entry.some((candidate) => startsWith(tokens.slice(1), candidate))) {
    return `not a read-only subcommand of ${first}`
  }
  return null
}

// Canonical propose pattern prefix for a command (first non-denied segment),
// or null when nothing about it is provably read-only.
export function canonicalFamily(command) {
  for (const segment of splitSegments(command)) {
    if (familyDenied(segment)) continue
    const tokens = stripEnvAssignments(segment)
    const [first, second] = tokens
    const entries = SAFE_SUBCOMMANDS.get(first)
    if (entries) {
      const entry = entries.find((candidate) => startsWith(tokens.slice(1), candidate))
      if (entry) return [first, ...entry].join(" ")
      continue
    }
    if (first === "bundle" && BUNDLE_READ_SUBCOMMANDS.has(second)) return `bundle ${second}`
    return first
  }
  return null
}

const globToRegExp = (rule) =>
  new RegExp(`^${rule.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`)

// Would an existing allowlist rule already permit this family? Whole-string
// glob match; `rule *` also covers the bare `rule` (V2 rule semantics).
export function ruleCovers(rule, prefix) {
  if (typeof rule !== "string" || typeof prefix !== "string") return false
  if (rule === prefix) return true
  if (rule === `${prefix} *`) return true
  return globToRegExp(rule).test(prefix)
}

// Turn observed usage into proposals. `observed` maps family → { count, examples }.
export function classify(observed, existingRules, { minCount } = {}) {
  const threshold = typeof minCount === "number" ? minCount : 3
  const rules = Array.isArray(existingRules) ? existingRules : []
  const proposals = []
  const skipped = { denied: [], rare: [], covered: [] }
  for (const [family, stats] of observed) {
    const count = stats?.count ?? 0
    const examples = Array.isArray(stats?.examples) ? stats.examples : []
    // Denial is checked against every example: one mutating invocation in the
    // window is enough to refuse the family.
    const reason =
      familyDenied(family) ?? examples.map((example) => familyDenied(example)).find((r) => r) ?? null
    if (reason) {
      skipped.denied.push({ family, reason })
      continue
    }
    if (rules.some((rule) => ruleCovers(rule, family))) {
      skipped.covered.push(family)
      continue
    }
    if (count < threshold) {
      skipped.rare.push({ family, count })
      continue
    }
    proposals.push({ pattern: `${family} *`, count, examples })
  }
  return { proposals, skipped }
}
