/**
 * The lazy `@anthropic-ai/sandbox-runtime` runtime for the OpenCode
 * `sandbox` plugin: the memoized module import, the live availability
 * self-test, and the consented install. This module is the plugin's ONLY
 * touchpoint with the package — every other module receives the loaded
 * module or its pieces by injection — so the plugin stays loadable while
 * the package is absent, which is exactly the state the consent-install
 * flow serves.
 *
 * The availability self-test reproduces the probe's host-mode detection —
 * it initializes the manager, wraps the trivial `true` command (under
 * `/bin/bash`), and spawns the wrapped string — but it initializes the
 * PRODUCTION base config, not a throwaway probe config: the library reads
 * the wrap-time network/credential policy (`allowAllUnixSockets` included)
 * from the initialized config only, and `initialize()` is first-call-wins
 * per process (only `reset()` clears it), so whatever the self-test
 * initializes with is what every later wrap runs under. On a clean host
 * the probe exits 0 → mode "seccomp". On hosts whose AppArmor policy
 * capability-strips the vendored apply-seccomp helper (Ubuntu with
 * `kernel.apparmor_restrict_unprivileged_userns=1`), every wrapped command
 * dies at startup with the apply-seccomp signature — a non-zero exit of
 * the no-op command IS a startup-class failure — so the self-test resets,
 * re-initializes once with `network.allowAllUnixSockets: true` merged into
 * the production base (which skips apply-seccomp entirely), and retries:
 * exit 0 → mode "no-seccomp" plus a `[sandbox]` warning naming the host
 * fix. `checkDependencies*` is consulted only to name genuinely missing
 * binaries (bwrap/socat/ripgrep) — it reports CLEAN on the
 * AppArmor-restricted hosts above, so it is never the mode gate; the
 * spawned probe is.
 *
 * The manager stays initialized after a successful probe — with the config
 * that just proved to work — and availability() is memoized per process
 * (first call's input wins; a successful install() clears the memo, other
 * results stay sticky). The memoization is correctness, not just
 * efficiency: a repeated self-test would `reset()` the manager and wipe
 * its violation store between commands, breaking the `execute.after`
 * attribution of Task 6. A FAILED probe tears down (best-effort
 * `reset()`) so an inert plugin does not leave the manager's proxies
 * listening.
 */

import { spawn as spawnChild } from "node:child_process"
import { randomBytes } from "node:crypto"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { buildBaseConfig, validateBaseConfig, fallbackBaseConfig } from "./config.js"

/** The package this runtime owns, imported as a bare specifier — Task 1's
 * probe verified bare-specifier resolution reaches this directory's
 * node_modules even when the plugin is loaded through a symlinked entry. */
const PACKAGE = "@anthropic-ai/sandbox-runtime"

/** The consented-install target (the plan's pinned version range). */
const INSTALL_SPEC = `${PACKAGE}@^0.0.79`

/** The npm install budget; the `timeout` spawn option has Node kill the
 * child (SIGTERM) when it expires. */
const INSTALL_TIMEOUT_MS = 120_000

/** The startup signature of a wrapped command dying because this host's
 * AppArmor policy capability-strips the vendored apply-seccomp helper. */
const APPLY_SECCOMP_SIGNATURE = /apply-seccomp:/

/** What restores full (seccomp) containment on a restricted host, named
 * in the degraded-mode warning. */
const HOST_FIX = "sysctl kernel.apparmor_restrict_unprivileged_userns=0"

/** The trivial command the self-test wraps and spawns: it cannot fail on
 * its own, so any non-zero exit (or spawn error) is a startup-class
 * failure of the sandbox machinery itself. */
const SELF_TEST_COMMAND = "true"

/** The shell the self-test wraps under (the probe's binShell). */
const SELF_TEST_SHELL = "/bin/bash"

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The degraded retry config: the production base with the Unix-socket
 * allowance merged into its network block — which skips apply-seccomp
 * entirely, so the retry runs in bwrap's own namespaces.
 *
 * @param {import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig} base
 * @returns {import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig}
 */
function degradedBase(base) {
  return {
    ...base,
    network: { ...base?.network, allowAllUnixSockets: true },
  }
}

/** The most informative short evidence string for a failed attempt: the
 * apply-seccomp signature when present, else the first non-empty stderr
 * line, else "" (the exit code is carried by the caller's message). */
function summary({ stderr }) {
  const text = typeof stderr === "string" ? stderr : ""
  if (APPLY_SECCOMP_SIGNATURE.test(text)) return "apply-seccomp startup failure"
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "")
  if (!line) return ""
  return line.length > 160 ? line.slice(0, 157) + "..." : line
}

/**
 * Create the plugin's sandbox runtime.
 *
 * @param {{
 *   pluginDir?: string,
 *   importModule?: (spec: string) => Promise<unknown>,
 *   spawn?: Function,
 *   log?: (m: string) => void,
 * }} [deps] test injection: with none given, the real dynamic import,
 *   the real child_process.spawn, and console.warn are used.
 * @returns {{
 *   load(): Promise<{ SandboxManager: import("@anthropic-ai/sandbox-runtime").SandboxManager } | undefined>,
 *   availability(input?: { requireSeccomp?: boolean, options?: Object }): Promise<{ ok: true, mode: "seccomp" | "no-seccomp" } | { ok: false, reason: string }>,
 *   install(): Promise<{ ok: true } | { ok: false, reason: string }>,
 *   declined(): boolean,
 *   markDeclined(): void,
 *   sandboxMode(): "seccomp" | "no-seccomp" | undefined,
 *   store(): { getViolationsForCommand(id: string): readonly unknown[] } | undefined,
 *   reset(): Promise<void>,
 * }}
 */
export function createRuntime(deps) {
  const pluginDir =
    typeof deps?.pluginDir === "string" && deps.pluginDir !== ""
      ? deps.pluginDir
      : dirname(fileURLToPath(import.meta.url))
  const importModule =
    typeof deps?.importModule === "function" ? deps.importModule : (spec) => import(spec)
  const spawn = typeof deps?.spawn === "function" ? deps.spawn : spawnChild
  const log = typeof deps?.log === "function" ? deps.log : (m) => console.warn(m)

  /** The memoized import attempt — cleared by a successful install() so
   * the next load() re-imports. Resolves undefined (never rejects). */
  let modulePromise
  /** The namespace the memo resolved to; drives store(). */
  let loadedModule
  /** The memoized availability result promise — memoized per process
   * (first call's input wins); cleared by a successful install() so the
   * pre-install "not-installed" memo does not stick. Other results stay
   * sticky: an inert plugin stays inert. Re-probing would reset() the
   * manager and wipe the violation store between commands. */
  let availabilityMemo
  /** "seccomp" | "no-seccomp" | undefined — set by a successful probe;
   * cleared whenever a fresh probe runs (the memo it belonged to was
   * cleared), so a failed re-probe never reports a stale mode. */
  let mode
  /** The install-decline flag: one-way, idempotent (never re-prompts). */
  let installDeclined = false
  /** The memoized install attempt — at most one npm spawn per process,
   * success or failure; concurrent callers share the in-flight promise. */
  let installPromise

  /**
   * The lazily-imported sandbox module, or undefined when it is absent
   * (ERR_MODULE_NOT_FOUND — the expected absent-package state the
   * consent-install flow serves, not worth a log line) or failed to
   * import for any other reason (logged: distinguishable reasons matter)
   * or resolved without a usable SandboxManager export (logged).
   * Memoized; re-attempts after a successful install().
   *
   * @returns {Promise<{ SandboxManager: import("@anthropic-ai/sandbox-runtime").SandboxManager } | undefined>}
   */
  function load() {
    if (!modulePromise) {
      modulePromise = Promise.resolve()
        .then(() => importModule(PACKAGE))
        .then(
          (mod) => {
            if (isPlainObject(mod) && isPlainObject(mod.SandboxManager)) {
              loadedModule = mod
              return mod
            }
            log(`[sandbox] ${PACKAGE} loaded without a usable SandboxManager export`)
            loadedModule = undefined
            return undefined
          },
          (err) => {
            if (err?.code !== "ERR_MODULE_NOT_FOUND") {
              log(`[sandbox] ${PACKAGE} import failed: ${err?.message ?? String(err)}`)
            }
            loadedModule = undefined
            return undefined
          },
        )
    }
    return modulePromise
  }

  /**
   * The production base config the probe must initialize with — the
   * config every later wrap will actually run under. From the caller's
   * options (Task 2's SandboxOptions, resolved): buildBaseConfig, then
   * validateBaseConfig with the loaded module's SandboxRuntimeConfigSchema
   * (a missing schema fails validation), falling back to the hardcoded
   * safe fallbackBaseConfig() when invalid — an unvalidated config is
   * never handed to initialize(). With no options, the same
   * fallbackBaseConfig(): deny-read defaults and credential scrub, network
   * denied — equally "minimal deny-all", and strictly safer than a bare
   * minimal config, because the initialized config is sticky
   * (first-call-wins), so a stray no-options first call would otherwise
   * run every later wrap without env scrubbing.
   *
   * @param {{ SandboxManager: import("@anthropic-ai/sandbox-runtime").SandboxManager, SandboxRuntimeConfigSchema?: { safeParse(v: unknown): { success: true, data: unknown } | { success: false, error?: { message?: string } } } }} mod
   * @param {Object} [options] Task 2's SandboxOptions (see ./config.js)
   * @returns {import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig}
   */
  function baseConfigFor(mod, options) {
    if (!isPlainObject(options)) return fallbackBaseConfig()
    const validated = validateBaseConfig(buildBaseConfig(options), mod.SandboxRuntimeConfigSchema)
    if (validated.ok) return validated.data
    log(
      `[sandbox] base config failed validation (${validated.reason}) — ` +
        `initializing the safe fallback config`,
    )
    return fallbackBaseConfig()
  }

  /** Spawn the wrapped command and settle on its close (or a spawn
   * "error", a startup-class failure: exit -1), capturing stderr for the
   * startup-signature match. Never rejects. */
  function runWrapped(wrapped) {
    return new Promise((resolve) => {
      let stderr = ""
      let settled = false
      let child
      try {
        child = spawn(wrapped, { shell: true, stdio: ["ignore", "ignore", "pipe"] })
      } catch (err) {
        resolve({ exit: -1, stderr: String(err?.message ?? err) })
        return
      }
      const finish = (exit) => {
        if (settled) return
        settled = true
        resolve({ exit, stderr })
      }
      // Best-effort capture: the exit code is the gate, stderr only
      // enriches the failure evidence.
      child.stderr?.on?.("data", (chunk) => {
        stderr += String(chunk)
      })
      child.on("error", () => finish(-1))
      child.on("close", (code) => finish(code ?? -1))
    })
  }

  /**
   * One self-test attempt: reset() then initialize() with the attempt's
   * config (initialize() is first-call-wins — reset() is what lets it
   * apply this attempt's config), wrap the trivial command, and spawn the
   * wrapped string.
   *
   * @param {import("@anthropic-ai/sandbox-runtime").SandboxManager} manager
   * @param {import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig} config
   * @returns {Promise<{ exit: number, stderr: string }>}
   */
  async function runSelfTest(manager, config) {
    await manager.reset()
    await manager.initialize(config)
    const wrapped = await manager.wrapWithSandbox(
      SELF_TEST_COMMAND,
      SELF_TEST_SHELL,
      undefined,
      undefined,
      {
        commandId: randomBytes(16).toString("base64url"),
        commandText: SELF_TEST_COMMAND,
      },
    )
    return runWrapped(wrapped)
  }

  /** Best-effort teardown after a failed probe: the manager stays
   * initialized (proxies listening) even when every wrapped command
   * died, and an inert plugin must not hold host sockets open. Never
   * throws. */
  async function teardown(manager) {
    try {
      await manager.reset()
    } catch (err) {
      log(`[sandbox] reset after failed self-test failed: ${err?.message ?? String(err)}`)
    }
  }

  /**
   * The live availability self-test — the body behind the memoized
   * availability(). `checkDependencies*` names genuinely missing binaries
   * but is never the mode gate — it reports CLEAN on AppArmor-restricted
   * hosts where the default (seccomp) mode actually dies; the spawned
   * probe decides. On success the manager stays initialized with the
   * production base that just proved to work, and sandboxMode() reports
   * it; any failure path — the explicit ones and the catch-all — tears
   * down (best-effort reset()) so an inert plugin does not leave the
   * manager's proxies listening, and clears the mode (a fresh probe
   * invalidates the previous lifetime's). Never rejects.
   *
   * @param {{ requireSeccomp?: boolean, options?: Object }} [input] — `options`
   *   is Task 2's SandboxOptions (see ./config.js); the FIRST call's input
   *   is the one that runs (availability() memoizes).
   * @returns {Promise<{ ok: true, mode: "seccomp" | "no-seccomp" } | { ok: false, reason: string }>}
   */
  async function probe(input) {
    const requireSeccomp = isPlainObject(input) ? input.requireSeccomp === true : false
    const options = isPlainObject(input) ? input.options : undefined
    // Hoisted so the catch-all can tear it down: whatever way the probe
    // fails — including a throwing wrap or a rejected re-initialize after
    // initialize() already started the proxies — the manager must not be
    // left listening for the process lifetime. (reset() before the first
    // initialize is safe: every teardown in the library is guarded.)
    let manager
    // A fresh probe invalidates the previous lifetime's mode: the
    // availability memo it belonged to was cleared, so the mode must not
    // outlive it — a failed re-probe reports undefined, not a stale mode.
    mode = undefined
    try {
      const mod = await load()
      if (!mod) return { ok: false, reason: "not-installed" }
      manager = mod.SandboxManager

      if (typeof manager.isSupportedPlatform !== "function" || !manager.isSupportedPlatform()) {
        return { ok: false, reason: "unsupported-platform" }
      }

      if (typeof manager.checkDependenciesAsync === "function") {
        const deps = await manager.checkDependenciesAsync()
        const errors = Array.isArray(deps?.errors) ? deps.errors : []
        if (errors.length > 0) {
          return { ok: false, reason: `missing-dependencies: ${errors.join("; ")}` }
        }
      }

      // The PRODUCTION base config — the library reads the wrap-time
      // network/credential policy from the initialized config only and
      // initialize() is first-call-wins, so the probe must initialize
      // exactly what production will run under.
      const base = baseConfigFor(mod, options)

      // Attempt 1 — the library default (apply-seccomp on).
      const first = await runSelfTest(manager, base)
      if (first.exit === 0) {
        mode = "seccomp"
        return { ok: true, mode: "seccomp" }
      }
      if (requireSeccomp) {
        await teardown(manager)
        const firstDetail = summary(first)
        return {
          ok: false,
          reason: `seccomp-unavailable${firstDetail ? ` (${firstDetail})` : ""}`,
        }
      }

      // Attempt 2 — one retry with the Unix-socket allowance merged into
      // the production base, which skips apply-seccomp entirely: the
      // degraded host mode.
      const second = await runSelfTest(manager, degradedBase(base))
      if (second.exit === 0) {
        mode = "no-seccomp"
        const firstDetail = summary(first)
        log(
          `[sandbox] seccomp sandbox unavailable on this host${firstDetail ? ` (${firstDetail})` : ""} — ` +
            `running degraded with network.allowAllUnixSockets: true, so unix-socket blocking is off; ` +
            `host fix: ${HOST_FIX}`,
        )
        return { ok: true, mode: "no-seccomp" }
      }
      await teardown(manager)
      const secondDetail = summary(second)
      return {
        ok: false,
        reason: `self-test failed: exit=${second.exit}${secondDetail ? ` — ${secondDetail}` : ""}`,
      }
    } catch (err) {
      // The catch-all failure path tears down too, like the explicit ones:
      // a failed probe must not leave the manager's proxies listening,
      // however it failed. Never throws (teardown guards itself).
      if (manager) await teardown(manager)
      return { ok: false, reason: `availability error: ${err?.message ?? String(err)}` }
    }
  }

  /**
   * The memoized availability self-test: the first call probes (its
   * input is the one that runs); every later call returns the memoized
   * result — re-probing would reset() the manager and wipe its violation
   * store between commands, breaking execute.after attribution. A
   * successful install() clears the memo so a pre-install "not-installed"
   * result does not stick; other results stay sticky (an inert plugin
   * stays inert). Never rejects.
   *
   * @param {{ requireSeccomp?: boolean, options?: Object }} [input]
   * @returns {Promise<{ ok: true, mode: "seccomp" | "no-seccomp" } | { ok: false, reason: string }>}
   */
  function availability(input) {
    if (!availabilityMemo) {
      availabilityMemo = probe(input)
    }
    return availabilityMemo
  }

  /**
   * The consented install: `npm install --save` the package into
   * pluginDir, at most once per process (a failed install is never
   * re-run; concurrent callers share the in-flight promise). A
   * successful install clears the load() memo — so the next load()
   * re-imports — and the availability() memo — so a pre-install
   * "not-installed" result does not stick. The 120s spawn timeout has
   * Node kill the child; that outcome returns ok:false naming the
   * timeout. Never rejects.
   *
   * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
   */
  function install() {
    if (!installPromise) {
      installPromise = new Promise((resolve) => {
        let finished = false
        const finish = (result) => {
          if (finished) return
          finished = true
          if (result.ok) {
            modulePromise = undefined // next load() re-imports
            availabilityMemo = undefined // next availability() re-probes
          }
          resolve(result)
        }
        try {
          const child = spawn("npm", ["install", "--save", INSTALL_SPEC], {
            cwd: pluginDir,
            stdio: "ignore",
            timeout: INSTALL_TIMEOUT_MS,
          })
          child.on("error", (err) =>
            finish({ ok: false, reason: `npm install failed: ${err?.message ?? String(err)}` }),
          )
          child.on("close", (code, signal) => {
            if (code === 0) {
              finish({ ok: true })
            } else if (code === null) {
              finish({
                ok: false,
                reason: `npm install timed out after ${INSTALL_TIMEOUT_MS / 1000}s (killed: ${signal ?? "unknown"})`,
              })
            } else {
              finish({ ok: false, reason: `npm install exited with code ${code}` })
            }
          })
        } catch (err) {
          finish({ ok: false, reason: `npm install could not run: ${err?.message ?? String(err)}` })
        }
      })
    }
    return installPromise
  }

  /** The one-way install-decline flag: once declined, never re-prompt. */
  function declined() {
    return installDeclined
  }

  function markDeclined() {
    installDeclined = true
  }

  /** "seccomp" | "no-seccomp" | undefined — set by a successful
   * availability(); cleared when a fresh probe runs; consumed by the
   * per-call config builder. */
  function sandboxMode() {
    return mode
  }

  /** The violation store, only after a successful load(); otherwise
   * undefined. Never throws. */
  function store() {
    try {
      return loadedModule?.SandboxManager?.getSandboxViolationStore?.()
    } catch {
      return undefined
    }
  }

  /** `SandboxManager.reset()`; a no-op resolution when the module is
   * absent (there is nothing to reset). */
  async function reset() {
    const mod = await load()
    if (mod) await mod.SandboxManager.reset()
  }

  return { load, availability, install, declined, markDeclined, sandboxMode, store, reset }
}
