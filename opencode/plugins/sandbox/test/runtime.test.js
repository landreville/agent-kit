import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { resolveOptions, buildBaseConfig, fallbackBaseConfig } from "../config.js"
import { createRuntime } from "../runtime.js"

// Every piece of I/O — the package import, the npm spawn, the wrapped
// self-test spawn — is injected: these tests never touch the real sandbox,
// the real npm, or the real import.

const PACKAGE = "@anthropic-ai/sandbox-runtime"

function notFoundError(spec = PACKAGE) {
  const err = new Error(`Cannot find module '${spec}' imported from ...`)
  err.code = "ERR_MODULE_NOT_FOUND"
  return err
}

/** A fake sandbox-runtime module: every manager method records its calls;
 * every promise settles on the microtask queue so one setImmediate flush
 * advances a pending availability()/install() to its next spawn. The
 * violation store is a per-module singleton, like the real manager's, and
 * the schema is a pass-through (overridable with a rejecting one). */
function fakeModule(overrides = {}) {
  const calls = { initialize: [], reset: 0, wrap: [], platform: 0, deps: 0 }
  const violations = new Map()
  const violationStore = {
    getViolationsForCommand: (id) => violations.get(id) ?? [],
    record: (id, v) => {
      const list = violations.get(id) ?? []
      list.push(v)
      violations.set(id, list)
    },
  }
  const manager = {
    isSupportedPlatform() {
      calls.platform++
      return overrides.supported ?? true
    },
    async checkDependenciesAsync() {
      calls.deps++
      return { errors: overrides.depsErrors ?? [], warnings: [] }
    },
    async reset() {
      calls.reset++
    },
    async initialize(config) {
      calls.initialize.push(config)
    },
    async wrapWithSandbox(command, binShell, customConfig, abortSignal, options) {
      calls.wrap.push({ command, binShell, customConfig, abortSignal, options })
      return `BWRAP(${command})`
    },
    getSandboxViolationStore() {
      return violationStore
    },
  }
  return {
    SandboxManager: manager,
    SandboxRuntimeConfigSchema: { safeParse: (v) => ({ success: true, data: v }) },
    calls,
    violations,
  }
}

/** A spawn double shared by install() (npm) and the availability
 * self-test (the wrapped probe): records every call and returns an
 * EventEmitter child whose stderr is an EventEmitter the test feeds
 * chunks into; the test settles the child by emitting "close" or
 * "error" on it. Both of child_process.spawn's call shapes are
 * recorded as given: spawn(cmd, opts) — the self-test — and
 * spawn(cmd, args, opts) — npm install. */
function makeSpawn() {
  const calls = []
  const children = []
  const spawn = (cmd, args, opts) => {
    calls.push(Array.isArray(args) ? { cmd, args, opts } : { cmd, opts: args })
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    children.push(child)
    return child
  }
  return { spawn, calls, children }
}

/** Drain the microtask queue — and any promise chains created while it
 * drains — so a pending availability()/install() has advanced to its
 * next spawn. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** The degraded retry config: the production base with the Unix-socket
 * allowance merged into its network block. */
const degraded = (base) => ({
  ...base,
  network: { ...base.network, allowAllUnixSockets: true },
})

test("missing module: load() undefined (one memoized attempt), availability() not-installed", async () => {
  const spawn = makeSpawn()
  const logs = []
  let imports = 0
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: () => {
      imports++
      return Promise.reject(notFoundError())
    },
    spawn: spawn.spawn,
    log: (m) => logs.push(m),
  })
  assert.equal(await rt.load(), undefined)
  assert.equal(await rt.load(), undefined)
  assert.equal(imports, 1) // memoized: absent means absent until install()
  assert.deepEqual(await rt.availability(), { ok: false, reason: "not-installed" })
  assert.equal(spawn.calls.length, 0) // no self-test without the module
  assert.equal(rt.store(), undefined)
  assert.equal(rt.sandboxMode(), undefined)
  assert.deepEqual(logs, []) // module-not-found is the expected state, not logged
})

test("any other import error: load() undefined AND logged", async () => {
  const logs = []
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: () => Promise.reject(new Error("corrupt package: boom")),
    spawn: () => {
      throw new Error("no spawn expected")
    },
    log: (m) => logs.push(m),
  })
  assert.equal(await rt.load(), undefined)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /boom/)
})

test("a namespace without SandboxManager is unusable: undefined and logged", async () => {
  const logs = []
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => ({}),
    spawn: makeSpawn().spawn,
    log: (m) => logs.push(m),
  })
  assert.equal(await rt.load(), undefined)
  assert.equal(logs.length, 1)
})

test("loaded module: load() memoizes one import, store() exposes the violation store", async () => {
  const mod = fakeModule()
  let imports = 0
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => {
      imports++
      return mod
    },
    spawn: makeSpawn().spawn,
    log: () => {},
  })
  assert.equal(await rt.load(), mod)
  assert.equal(await rt.load(), mod)
  assert.equal(imports, 1)
  const store = rt.store()
  assert.equal(typeof store.getViolationsForCommand, "function")
  assert.deepEqual(store.getViolationsForCommand("nope"), [])
})

test("store() before any load() is undefined", () => {
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => fakeModule(),
    spawn: makeSpawn().spawn,
    log: () => {},
  })
  assert.equal(rt.store(), undefined)
})

test("unsupported platform: availability() reports unsupported-platform, never initializes", async () => {
  const mod = fakeModule({ supported: false })
  const spawn = makeSpawn()
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => mod,
    spawn: spawn.spawn,
    log: () => {},
  })
  assert.deepEqual(await rt.availability(), { ok: false, reason: "unsupported-platform" })
  assert.equal(mod.calls.initialize.length, 0)
  assert.equal(spawn.calls.length, 0)
  assert.equal(rt.sandboxMode(), undefined)
})

test("missing sandbox dependencies: reason names the missing binaries", async () => {
  const mod = fakeModule({
    depsErrors: ["bubblewrap (bwrap) not installed", "socat not installed"],
  })
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => mod,
    spawn: makeSpawn().spawn,
    log: () => {},
  })
  const result = await rt.availability()
  assert.equal(result.ok, false)
  assert.match(result.reason, /bwrap/)
  assert.match(result.reason, /socat/)
  assert.equal(mod.calls.initialize.length, 0) // dependency gate precedes the probe
})

test("clean seccomp host, no options: first attempt exits 0 → mode seccomp, safe fallback base", async () => {
  const mod = fakeModule()
  const spawn = makeSpawn()
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => mod,
    spawn: spawn.spawn,
    log: () => {},
  })
  const p = rt.availability()
  await flush()
  assert.equal(spawn.calls.length, 1)
  assert.equal(spawn.calls[0].cmd, "BWRAP(true)") // the WRAPPED command is spawned
  assert.deepEqual(spawn.calls[0].opts, { shell: true, stdio: ["ignore", "ignore", "pipe"] })
  spawn.children[0].emit("close", 0)
  assert.deepEqual(await p, { ok: true, mode: "seccomp" })
  assert.equal(rt.sandboxMode(), "seccomp")
  // one initialize with the safe fallback default — denyRead defaults +
  // credential scrub, network denied (a stray no-options first call makes
  // the initialized config sticky, so the default must be scrub-safe) —
  // preceded by reset (first-call-wins)
  assert.deepEqual(mod.calls.initialize, [fallbackBaseConfig()])
  assert.ok(mod.calls.initialize[0].filesystem.denyRead.includes("~/.ssh"))
  assert.ok(
    mod.calls.initialize[0].credentials.envVars.some((e) => e.name === "ANTHROPIC_API_KEY"),
  )
  assert.equal(mod.calls.reset, 1)
  // the wrap: trivial command under /bin/bash, no per-call customConfig
  // (the base rides initialize, as the probe does)
  assert.equal(mod.calls.wrap.length, 1)
  assert.equal(mod.calls.wrap[0].command, "true")
  assert.equal(mod.calls.wrap[0].binShell, "/bin/bash")
  assert.equal(mod.calls.wrap[0].customConfig, undefined)
  assert.equal(mod.calls.wrap[0].abortSignal, undefined)
  assert.equal(mod.calls.wrap[0].options.commandText, "true")
  // commandId: ≥128-bit random base64url — 22 chars, the plan's
  // attribution-key shape
  assert.match(mod.calls.wrap[0].options.commandId, /^[A-Za-z0-9_-]{22}$/)
})

test("production options: initialize receives the options-derived base config", async () => {
  const mod = fakeModule()
  const spawn = makeSpawn()
  const options = resolveOptions({
    network: { allowedDomains: ["example.com"] },
    credentials: { envVars: [{ name: "MY_TOKEN", mode: "deny" }] },
  })
  const expected = buildBaseConfig(options)
  assert.deepEqual(expected.network.allowedDomains, ["example.com"]) // sanity
  assert.ok(expected.credentials.envVars.some((e) => e.name === "MY_TOKEN"))
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => mod,
    spawn: spawn.spawn,
    log: () => {},
  })
  const p = rt.availability({ options })
  await flush()
  assert.equal(spawn.calls.length, 1)
  spawn.children[0].emit("close", 0)
  assert.deepEqual(await p, { ok: true, mode: "seccomp" })
  // the user's allowedDomains and credentials.envVars reach initialize —
  // the library reads network/credential policy from the initialized
  // config only, so the probe must initialize exactly the production base
  assert.deepEqual(mod.calls.initialize, [expected])
  assert.deepEqual(mod.calls.initialize[0].network.allowedDomains, ["example.com"])
  assert.ok(mod.calls.initialize[0].credentials.envVars.some((e) => e.name === "MY_TOKEN"))
})

test("production options, degraded host: retry merges allowAllUnixSockets into the production base", async () => {
  const mod = fakeModule()
  const spawn = makeSpawn()
  const logs = []
  const options = resolveOptions({ network: { allowedDomains: ["example.com"] } })
  const expected = buildBaseConfig(options)
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => mod,
    spawn: spawn.spawn,
    log: (m) => logs.push(m),
  })
  const p = rt.availability({ options })
  await flush()
  spawn.children[0].stderr.emit(
    "data",
    "bwrap: apply-seccomp: write /proc/self/setgroups: Permission denied\n",
  )
  spawn.children[0].emit("close", 1)
  await flush()
  assert.equal(mod.calls.initialize.length, 2)
  assert.deepEqual(mod.calls.initialize[0], expected)
  assert.deepEqual(mod.calls.initialize[1], degraded(expected))
  spawn.children[1].emit("close", 0)
  assert.deepEqual(await p, { ok: true, mode: "no-seccomp" })
  assert.equal(rt.sandboxMode(), "no-seccomp")
  assert.equal(logs.length, 1) // the degraded warning, naming the host fix
  assert.match(logs[0], /^\[sandbox\]/)
  assert.match(logs[0], /allowAllUnixSockets/)
  assert.match(logs[0], /apparmor_restrict_unprivileged_userns/)
})

test("invalid options: fallbackBaseConfig reaches initialize, with a log", async () => {
  const mod = fakeModule()
  mod.SandboxRuntimeConfigSchema = {
    safeParse: () => ({ success: false, error: { message: "not a config" } }),
  }
  const spawn = makeSpawn()
  const logs = []
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => mod,
    spawn: spawn.spawn,
    log: (m) => logs.push(m),
  })
  const p = rt.availability({ options: resolveOptions({}) })
  await flush()
  spawn.children[0].emit("close", 0)
  assert.deepEqual(await p, { ok: true, mode: "seccomp" }) // proceeds on the fallback
  assert.deepEqual(mod.calls.initialize, [fallbackBaseConfig()])
  assert.equal(logs.length, 1)
  assert.match(logs[0], /validation/)
  assert.match(logs[0], /fallback/)
})

test("apply-seccomp-dying host, no options: one retry with allowAllUnixSockets → no-seccomp + warning", async () => {
  const mod = fakeModule()
  const spawn = makeSpawn()
  const logs = []
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => mod,
    spawn: spawn.spawn,
    log: (m) => logs.push(m),
  })
  const p = rt.availability()
  await flush()
  // attempt 1 dies at startup with the apply-seccomp signature
  spawn.children[0].stderr.emit(
    "data",
    "bwrap: apply-seccomp: write /proc/self/setgroups: Permission denied\n",
  )
  spawn.children[0].emit("close", 1)
  await flush()
  // attempt 2: reset first (first-call-wins), initialize with sockets
  // allowed merged into the safe fallback base
  assert.equal(spawn.calls.length, 2)
  assert.equal(mod.calls.reset, 2)
  assert.deepEqual(mod.calls.initialize[1], degraded(fallbackBaseConfig()))
  spawn.children[1].emit("close", 0)
  assert.deepEqual(await p, { ok: true, mode: "no-seccomp" })
  assert.equal(rt.sandboxMode(), "no-seccomp")
  assert.equal(spawn.calls.length, 2) // exactly one retry
  assert.equal(logs.length, 1) // one warning, naming the host fix
  assert.match(logs[0], /^\[sandbox\]/)
  assert.match(logs[0], /allowAllUnixSockets/)
  assert.match(logs[0], /apparmor_restrict_unprivileged_userns/)
})

test("any startup-class self-test failure (no signature) takes the same one retry", async () => {
  const mod = fakeModule()
  const spawn = makeSpawn()
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => mod,
    spawn: spawn.spawn,
    log: () => {},
  })
  const p = rt.availability()
  await flush()
  spawn.children[0].stderr.emit("data", "some other startup failure\n")
  spawn.children[0].emit("close", 126) // `true` cannot fail on its own
  await flush()
  spawn.children[1].emit("close", 0)
  assert.deepEqual(await p, { ok: true, mode: "no-seccomp" })
  assert.equal(spawn.calls.length, 2)
})

test("self-test spawn error is a startup-class failure: one retry", async () => {
  const mod = fakeModule()
  const spawn = makeSpawn()
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => mod,
    spawn: spawn.spawn,
    log: () => {},
  })
  const p = rt.availability()
  await flush()
  spawn.children[0].emit("error", new Error("spawn failed"))
  await flush()
  spawn.children[1].emit("close", 0)
  assert.deepEqual(await p, { ok: true, mode: "no-seccomp" })
  assert.equal(spawn.calls.length, 2)
})

test("requireSeccomp on a seccomp-dying host: seccomp-unavailable (with evidence), no retry, mode unset", async () => {
  const mod = fakeModule()
  const spawn = makeSpawn()
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => mod,
    spawn: spawn.spawn,
    log: () => {},
  })
  const p = rt.availability({ requireSeccomp: true })
  await flush()
  spawn.children[0].stderr.emit(
    "data",
    "apply-seccomp: write /proc/self/setgroups: Permission denied",
  )
  spawn.children[0].emit("close", 1)
  const result = await p
  assert.equal(result.ok, false)
  assert.equal(result.reason, "seccomp-unavailable (apply-seccomp startup failure)")
  assert.equal(spawn.calls.length, 1) // no degraded retry
  assert.equal(mod.calls.initialize.length, 1)
  assert.equal(mod.calls.reset, 2) // pre-attempt + teardown of the failed probe
  assert.equal(rt.sandboxMode(), undefined)
})

test("both attempts fail: ok:false with the exit evidence, teardown, mode unset", async () => {
  const mod = fakeModule()
  const spawn = makeSpawn()
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => mod,
    spawn: spawn.spawn,
    log: () => {},
  })
  const p = rt.availability()
  await flush()
  spawn.children[0].emit("close", 1)
  await flush()
  spawn.children[1].emit("close", 1)
  const result = await p
  assert.equal(result.ok, false)
  assert.match(result.reason, /exit=1/)
  assert.equal(spawn.calls.length, 2) // one retry, then give up
  assert.equal(mod.calls.reset, 3) // two pre-attempt resets + teardown
  assert.equal(rt.sandboxMode(), undefined)
})

test("availability() is memoized per process: first input wins, no re-probe", async () => {
  const mod = fakeModule()
  const spawn = makeSpawn()
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => mod,
    spawn: spawn.spawn,
    log: () => {},
  })
  const firstP = rt.availability({ options: resolveOptions({}) })
  await flush()
  assert.equal(spawn.calls.length, 1)
  spawn.children[0].emit("close", 0)
  const first = await firstP
  assert.deepEqual(first, { ok: true, mode: "seccomp" })
  // a second call — even with different input — returns the SAME result
  // object without re-probing (a re-probe would reset() the manager and
  // wipe the violation store between commands)
  const second = await rt.availability({
    requireSeccomp: true,
    options: resolveOptions({ network: { allowedDomains: ["other.example"] } }),
  })
  assert.equal(second, first) // reference-equal: the memoized result
  assert.equal(mod.calls.initialize.length, 1)
  assert.equal(mod.calls.deps, 1)
  assert.equal(spawn.calls.length, 1)
  assert.equal(mod.calls.reset, 1) // no extra resets
})

test("other failures stay sticky: a failed availability is not re-probed", async () => {
  const mod = fakeModule({
    depsErrors: ["bubblewrap (bwrap) not installed", "socat not installed"],
  })
  const spawn = makeSpawn()
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => mod,
    spawn: spawn.spawn,
    log: () => {},
  })
  const first = await rt.availability()
  assert.equal(first.ok, false)
  const second = await rt.availability()
  assert.equal(second, first) // sticky: an inert plugin stays inert
  assert.equal(mod.calls.deps, 1) // not even re-checked
  assert.equal(mod.calls.initialize.length, 0)
})

test("a throwing wrap never rejects availability() and tears down", async () => {
  const mod = fakeModule()
  mod.SandboxManager.wrapWithSandbox = async () => {
    throw new Error("wrap exploded")
  }
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => mod,
    spawn: makeSpawn().spawn,
    log: () => {},
  })
  const result = await rt.availability()
  assert.equal(result.ok, false)
  assert.match(result.reason, /wrap exploded/)
  assert.equal(rt.sandboxMode(), undefined)
  // the catch-all path tears down too: attempt-1's reset + the teardown
  // reset, so a failed probe leaves no proxies listening
  assert.equal(mod.calls.initialize.length, 1)
  assert.equal(mod.calls.reset, 2)
})

test("a failed re-probe after install clears sandboxMode()", async () => {
  const mod = fakeModule()
  const spawn = makeSpawn()
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => mod,
    spawn: spawn.spawn,
    log: () => {},
  })
  // probe 1 succeeds → mode seccomp
  const p1 = rt.availability()
  await flush()
  spawn.children[0].emit("close", 0)
  assert.deepEqual(await p1, { ok: true, mode: "seccomp" })
  assert.equal(rt.sandboxMode(), "seccomp")
  // a successful install clears the availability memo
  const ip = rt.install()
  await flush()
  spawn.children[1].emit("close", 0)
  assert.deepEqual(await ip, { ok: true })
  // the fresh re-probe fails at both attempts
  const p2 = rt.availability()
  await flush()
  spawn.children[2].emit("close", 1)
  await flush()
  spawn.children[3].emit("close", 1)
  const result = await p2
  assert.equal(result.ok, false)
  assert.match(result.reason, /exit=1/)
  assert.equal(rt.sandboxMode(), undefined) // the stale mode did not survive its memo
})

test("install(): exact npm spawn, once per process, success clears the load memo", async () => {
  const mod = fakeModule()
  let imports = 0
  const spawn = makeSpawn()
  const rt = createRuntime({
    pluginDir: "/plugin/dir",
    importModule: () => {
      imports++
      return imports === 1 ? Promise.reject(notFoundError()) : Promise.resolve(mod)
    },
    spawn: spawn.spawn,
    log: () => {},
  })
  assert.equal(await rt.load(), undefined) // not installed yet
  const p = rt.install()
  await flush()
  assert.equal(spawn.calls.length, 1)
  assert.deepEqual(spawn.calls[0], {
    cmd: "npm",
    args: ["install", "--save", "@anthropic-ai/sandbox-runtime@^0.0.79"],
    opts: { cwd: "/plugin/dir", stdio: "ignore", timeout: 120_000 },
  })
  spawn.children[0].emit("close", 0)
  assert.deepEqual(await p, { ok: true })
  // second install(): the memoized result, no second npm spawn
  assert.deepEqual(await rt.install(), { ok: true })
  assert.equal(spawn.calls.length, 1)
  // the load memo was cleared: the next load() re-imports and now succeeds
  assert.equal(await rt.load(), mod)
  assert.equal(imports, 2)
  assert.equal(rt.store(), mod.SandboxManager.getSandboxViolationStore())
})

test("install(): a failed install returns ok:false and is never re-run", async () => {
  const spawn = makeSpawn()
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => fakeModule(),
    spawn: spawn.spawn,
    log: () => {},
  })
  const first = rt.install()
  await flush()
  spawn.children[0].emit("close", 1)
  const result = await first
  assert.equal(result.ok, false)
  assert.equal(typeof result.reason, "string")
  const second = await rt.install()
  assert.deepEqual(second, result) // at most once per process, even after failure
  assert.equal(spawn.calls.length, 1)
})

test("install(): concurrent callers share the in-flight spawn", async () => {
  const spawn = makeSpawn()
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => fakeModule(),
    spawn: spawn.spawn,
    log: () => {},
  })
  const p1 = rt.install()
  const p2 = rt.install()
  await flush()
  assert.equal(spawn.calls.length, 1)
  spawn.children[0].emit("close", 0)
  assert.deepEqual(await p1, { ok: true })
  assert.deepEqual(await p2, { ok: true })
  assert.equal(spawn.calls.length, 1)
})

test("install(): a timed-out npm (killed by the spawn timeout) returns ok:false naming the timeout", async () => {
  const spawn = makeSpawn()
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => fakeModule(),
    spawn: spawn.spawn,
    log: () => {},
  })
  const p = rt.install()
  await flush()
  spawn.children[0].emit("close", null, "SIGTERM") // Node's timeout kill
  const result = await p
  assert.equal(result.ok, false)
  assert.match(result.reason, /timed out/)
})

test("a successful install() clears the availability memo: the not-installed result does not stick", async () => {
  const mod = fakeModule()
  let imports = 0
  const spawn = makeSpawn()
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: () => {
      imports++
      return imports === 1 ? Promise.reject(notFoundError()) : Promise.resolve(mod)
    },
    spawn: spawn.spawn,
    log: () => {},
  })
  assert.deepEqual(await rt.availability(), { ok: false, reason: "not-installed" })
  // consented install succeeds
  const installP = rt.install()
  await flush()
  spawn.children[0].emit("close", 0)
  assert.deepEqual(await installP, { ok: true })
  // the availability memo was cleared: the next call re-probes for real
  const p = rt.availability()
  await flush()
  assert.equal(spawn.calls.length, 2) // npm + the self-test probe
  assert.equal(spawn.calls[1].cmd, "BWRAP(true)")
  spawn.children[1].emit("close", 0)
  assert.deepEqual(await p, { ok: true, mode: "seccomp" })
  assert.equal(mod.calls.initialize.length, 1)
  assert.equal(rt.sandboxMode(), "seccomp")
})

test("markDeclined()/declined(): the install-decline flag is one-way", () => {
  const rt = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => fakeModule(),
    spawn: makeSpawn().spawn,
    log: () => {},
  })
  assert.equal(rt.declined(), false)
  rt.markDeclined()
  assert.equal(rt.declined(), true)
  rt.markDeclined()
  assert.equal(rt.declined(), true) // idempotent: a declined install never re-prompts
})

test("reset(): delegates to SandboxManager.reset(); a no-op without the module", async () => {
  const mod = fakeModule()
  const loaded = createRuntime({
    pluginDir: "/plugin",
    importModule: async () => mod,
    spawn: makeSpawn().spawn,
    log: () => {},
  })
  await loaded.load()
  await loaded.reset()
  assert.equal(mod.calls.reset, 1)
  const absent = createRuntime({
    pluginDir: "/plugin",
    importModule: () => Promise.reject(notFoundError()),
    spawn: makeSpawn().spawn,
    log: () => {},
  })
  await absent.reset() // no module: resolves without throwing
})
