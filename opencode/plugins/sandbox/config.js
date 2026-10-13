/**
 * Options → sandbox configs for the OpenCode `sandbox` plugin.
 *
 * This module imports nothing from `@anthropic-ai/sandbox-runtime` — the
 * plugin must stay loadable while the package is absent so its
 * consent-install flow can run; the caller injects the lazily-imported
 * schema into `validateBaseConfig`. `resolveOptions` normalizes user
 * options onto the safe defaults (never throws); `buildBaseConfig` purely
 * constructs the base config; `buildCustomConfig` builds the per-call
 * filesystem override with absolute paths resolved from the command's
 * cwd. Option values are kept as written by `resolveOptions` — a leading
 * `~` is expanded only when paths end up in a config, because the
 * library does not guarantee `~` expansion in path entries.
 */

import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { statSync } from "node:fs"
import { spawnSync } from "node:child_process"

/** Sensitive host paths the sandbox denies reads of, by default. */
const DEFAULT_DENY_READ = [
  "~/.ssh",
  "~/.gnupg",
  "~/.aws",
  "~/.kube",
  "~/.netrc",
  "~/.config/gh",
  "~/.password-store",
  "~/.docker/config.json",
  "~/.config/opencode",
  "~/.local/share/opencode",
  "~/.claude",
  "~/.claude.json",
  "~/.env",
]

/** Environment variables scrubbed (denied) inside the sandbox, by default. */
const DEFAULT_ENV_DENY_ENTRIES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "LITELLM_API_KEY",
].map((name) => ({ name, mode: "deny" }))

/**
 * @typedef {Object} SandboxOptions
 * @property {boolean} enabled
 * @property {"ask" | "never"} install
 * @property {boolean} requireSeccomp
 * @property {{ allowedDomains: string[], deniedDomains: string[] }} network
 * @property {{ denyRead: string[], allowWrite: string[], denyWrite: string[] }} filesystem
 * @property {{ envVars: Array<{ name: string, mode: "deny" | "mask" }> }} credentials
 * @property {string[]} excludedCommands
 * @property {{ enabled: boolean, providerID: string, id: string }} classifier
 * @property {number} maxSandboxAttempts
 * @property {number} failureMemorySec
 */

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** An array of strings; a non-array value falls back to the field default,
 * malformed entries are dropped. Never throws. */
function stringArray(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  return value.filter((entry) => typeof entry === "string")
}

/** Dedupe exact duplicates, keeping the first occurrence. */
function dedupe(list) {
  return [...new Set(list)]
}

/** A positive integer, or the field default. */
function positiveInt(value, fallback) {
  return Number.isInteger(value) && value >= 1 ? value : fallback
}

/** Replace a leading `~` with the home directory — `~` alone and `~/…`
 * (plus `~\…` on Windows only — on POSIX, `~\foo` is a legal relative
 * filename and must not expand), mirroring the library's own rules. */
function expandTilde(p) {
  if (typeof p !== "string") return p
  if (p === "~") return homedir()
  if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) {
    return homedir() + p.slice(1)
  }
  return p
}

/** Option entries extend the default deny list: a bare string names a
 * variable to deny; an object names one with its mode (and any masking
 * options, which the library's schema validates downstream), a missing or
 * unrecognized mode defaulting to deny. A same-name option entry overrides
 * the default. Malformed entries are skipped, never thrown. */
function mergeEnvVars(raw) {
  const byName = new Map(DEFAULT_ENV_DENY_ENTRIES.map((entry) => [entry.name, { ...entry }]))
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") {
        if (item !== "") byName.set(item, { name: item, mode: "deny" })
      } else if (isPlainObject(item) && typeof item.name === "string" && item.name !== "") {
        byName.set(item.name, { ...item, mode: item.mode === "mask" ? "mask" : "deny" })
      }
    }
  }
  return [...byName.values()]
}

/**
 * The hardcoded fail-safe base config — the safe defaults as literals, so
 * a config that fails schema validation still leaves the sandbox denied
 * network and scrubbed credentials.
 *
 * @returns {import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig}
 */
export function fallbackBaseConfig() {
  return {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead: [...DEFAULT_DENY_READ], allowWrite: [], denyWrite: [] },
    credentials: { envVars: DEFAULT_ENV_DENY_ENTRIES.map((entry) => ({ ...entry })) },
  }
}

/**
 * Resolve raw plugin options onto the safe defaults. Extras extend — never
 * replace — `filesystem.denyRead` and `credentials.envVars`;
 * `filesystem.allowWrite`/`denyWrite` extras start from an empty default
 * (the cwd/tmp/.git paths are per-call, built by `buildCustomConfig`).
 * Malformed values fall back to that field's default; never throws.
 *
 * @param {unknown} raw
 * @returns {SandboxOptions}
 */
export function resolveOptions(raw) {
  const input = isPlainObject(raw) ? raw : {}
  const network = isPlainObject(input.network) ? input.network : {}
  const filesystem = isPlainObject(input.filesystem) ? input.filesystem : {}
  const credentials = isPlainObject(input.credentials) ? input.credentials : {}
  const classifier = isPlainObject(input.classifier) ? input.classifier : {}

  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : true,
    install: input.install === "ask" || input.install === "never" ? input.install : "ask",
    requireSeccomp: input.requireSeccomp === true,
    network: {
      allowedDomains: stringArray(network.allowedDomains, []),
      deniedDomains: stringArray(network.deniedDomains, []),
    },
    filesystem: {
      denyRead: dedupe([...DEFAULT_DENY_READ, ...stringArray(filesystem.denyRead, [])]),
      allowWrite: stringArray(filesystem.allowWrite, []),
      denyWrite: stringArray(filesystem.denyWrite, []),
    },
    credentials: {
      envVars: mergeEnvVars(credentials.envVars),
    },
    excludedCommands: stringArray(input.excludedCommands, []),
    classifier: {
      enabled: typeof classifier.enabled === "boolean" ? classifier.enabled : false,
      providerID: typeof classifier.providerID === "string" ? classifier.providerID : "litellm",
      id: typeof classifier.id === "string" ? classifier.id : "jev-1.13",
    },
    maxSandboxAttempts: positiveInt(input.maxSandboxAttempts, 3),
    failureMemorySec: positiveInt(input.failureMemorySec, 1800),
  }
}

/**
 * Purely construct the config to pass to `SandboxManager.initialize()`
 * once: network policy and the credential scrub list, plus the
 * schema-required filesystem defaults. No validation, no package import —
 * the caller validates with `validateBaseConfig` and the lazily-imported
 * library schema, falling back to `fallbackBaseConfig()` on failure.
 *
 * @param {SandboxOptions} options
 * @returns {import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig}
 */
export function buildBaseConfig(options) {
  try {
    return {
      network: {
        allowedDomains: options.network.allowedDomains,
        deniedDomains: options.network.deniedDomains,
      },
      filesystem: {
        denyRead: options.filesystem.denyRead,
        allowWrite: options.filesystem.allowWrite,
        denyWrite: options.filesystem.denyWrite,
      },
      credentials: {
        envVars: options.credentials.envVars,
      },
    }
  } catch {
    console.warn("[sandbox] base config could not be built; using safe defaults")
    return fallbackBaseConfig()
  }
}

/**
 * Validate a base config with the injected schema (the caller passes the
 * lazily-imported `SandboxRuntimeConfigSchema` from the sandbox package —
 * nothing here imports it). Returns `{ ok: true, data }` with the
 * validated config, or `{ ok: false, reason }`; never throws.
 *
 * @param {unknown} cfg
 * @param {{ safeParse(v: unknown): { success: true, data: unknown } | { success: false, error?: { message?: string } } }} schema
 * @returns {{ ok: true, data: import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig } | { ok: false, reason: string }}
 */
export function validateBaseConfig(cfg, schema) {
  let parsed
  try {
    if (!schema || typeof schema.safeParse !== "function") {
      return { ok: false, reason: "no schema provided" }
    }
    parsed = schema.safeParse(cfg)
  } catch (err) {
    return { ok: false, reason: `schema validation threw: ${err?.message ?? String(err)}` }
  }
  if (parsed && parsed.success) return { ok: true, data: parsed.data }
  return { ok: false, reason: parsed?.error?.message ?? "schema validation failed" }
}

/** The shared git dir when `cwd` is a linked worktree (its `.git` is a
 * file pointing into the main repository), so `git commit` can write to
 * the shared object store outside `cwd`. A normal repository's git dir
 * sits inside `cwd` and is writable already; anything else resolves to
 * undefined and is omitted. */
function linkedWorktreeGitDir(cwd, deps) {
  try {
    if (!statSync(join(cwd, ".git")).isFile()) return undefined
  } catch {
    return undefined
  }
  return resolveGitCommonDir(cwd, deps)
}

/**
 * The per-call config merged by the library over the initialized base:
 * an absolute, cwd-resolved filesystem block only — deny-read defaults
 * and extras (tilde-expanded), writes limited to the command's cwd,
 * tmp, the shared git dir for a linked worktree, and extras, with the
 * repository's config and hooks — the cwd's and, when a shared git dir
 * is in play, that dir's too — carved back out — plus, in the degraded
 * host mode, `network.allowAllUnixSockets`. Only overrides are included.
 *
 * @param {SandboxOptions} options
 * @param {{ cwd: string, allowUnixSockets?: boolean, gitDir?: string }} input
 * @param {{ spawnSync?: Function }} [deps] test injection for the git spawn
 * @returns {Partial<import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig>}
 */
export function buildCustomConfig(options, input, deps) {
  const raw = isPlainObject(input) ? input : {}
  const cwd = typeof raw.cwd === "string" && raw.cwd !== "" ? raw.cwd : process.cwd()
  const filesystem = isPlainObject(options?.filesystem) ? options.filesystem : {}
  const denyRead = Array.isArray(filesystem.denyRead) ? filesystem.denyRead : [...DEFAULT_DENY_READ]
  // An injected gitDir (test seam) wins over the stat+spawn resolution.
  const gitDir =
    typeof raw.gitDir === "string" && raw.gitDir !== ""
      ? raw.gitDir
      : linkedWorktreeGitDir(cwd, deps)

  const config = {
    filesystem: {
      denyRead: denyRead.map(expandTilde),
      allowWrite: dedupe([
        cwd,
        tmpdir(),
        ...(gitDir ? [gitDir] : []),
        ...stringArray(filesystem.allowWrite, []).map(expandTilde),
      ]),
      denyWrite: dedupe([
        join(cwd, ".git", "config"),
        join(cwd, ".git", "hooks"),
        ...(gitDir ? [join(gitDir, "config"), join(gitDir, "hooks")] : []),
        ...stringArray(filesystem.denyWrite, []).map(expandTilde),
      ]),
    },
  }
  if (raw.allowUnixSockets === true) {
    config.network = { allowAllUnixSockets: true }
  }
  return config
}

const gitCommonDirs = new Map()

/**
 * Resolve a cwd to its repository's shared git dir via
 * `git rev-parse --path-format=absolute --git-common-dir`. Cached per cwd
 * (failures too — undefined is cached as well). Any failure — spawn error,
 * non-zero status, empty output — yields undefined, never a throw.
 *
 * @param {string} cwd
 * @param {{ spawnSync?: Function }} [deps] test injection for the spawn
 * @returns {string | undefined}
 */
export function resolveGitCommonDir(cwd, deps) {
  if (typeof cwd !== "string" || cwd === "") return undefined
  if (gitCommonDirs.has(cwd)) return gitCommonDirs.get(cwd)
  const spawn = typeof deps?.spawnSync === "function" ? deps.spawnSync : spawnSync
  let result
  try {
    const res = spawn("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    })
    const stdout = typeof res?.stdout === "string" ? res.stdout.trim() : ""
    result = res && !res.error && res.status === 0 && stdout !== "" ? stdout : undefined
  } catch {
    result = undefined
  }
  gitCommonDirs.set(cwd, result)
  return result
}

/**
 * True when any `&&`/`||`/`;`/`|`-separated segment of the command has
 * `srt` as its first token — the plugin's own sandboxed runner, which
 * must never be sandboxed again.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isSrtInvocation(command) {
  const text = typeof command === "string" ? command : ""
  for (const segment of text.split(/&&|\|\||[;|]/)) {
    if (segment.trim().split(/\s+/)[0] === "srt") return true
  }
  return false
}

/**
 * Match a command against excluded-command patterns: a trailing ` *`
 * matches the base command alone or followed by a space — `docker
 * compose *` matches `docker compose` and `docker compose up -d` but not
 * `docker composese` — while anything else is an exact match.
 *
 * @param {string} command
 * @param {readonly string[]} patterns
 * @returns {boolean}
 */
export function matchesExcludedCommand(command, patterns) {
  const cmd = typeof command === "string" ? command : ""
  const list = Array.isArray(patterns) ? patterns : []
  for (const pattern of list) {
    if (typeof pattern !== "string" || pattern === "") continue
    if (pattern.endsWith(" *")) {
      const base = pattern.slice(0, -2)
      if (cmd === base || cmd.startsWith(base + " ")) return true
    } else if (cmd === pattern) {
      return true
    }
  }
  return false
}
