import { test } from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { resolveOptions } from "../config.js"
import { createGate, commandKeys } from "../policy.js"

// The v2 gate decides at tool.execute.before — BEFORE the harness's
// permission decision exists — so it predicts that outcome locally from the
// effective rules (rules.js) and only would-ask commands run the eligibility
// chain. The gate never touches the sandbox package, a model, or the
// filesystem: the runtime, the classifier, and the rules ctx are injected
// fakes that record their calls, and the clock is injected so TTLs advance
// by assignment.

const OK = { ok: true, mode: "seccomp" }

/** Step 7's consent message (v2 wording: approval runs THIS command with
 * normal permissions; the background install sandboxed SUBSEQUENT ones). */
const CONSENT =
  "Sandbox runtime not installed. Approving runs this command with normal permissions and installs @anthropic-ai/sandbox-runtime into the plugin directory (local npm install, no sudo), so subsequent commands run sandboxed. Denying leaves sandboxing off."

/** The schema base policy — probe-observed first rules of agent `build`. */
const BASE_POLICY = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "ask" },
]

/** User config rules: a broad shell ask, then specific allows and a deny
 * (last match wins). */
const USER_RULES = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "shell", resource: "uptime", effect: "allow" },
  { action: "shell", resource: "echo *", effect: "allow" },
  { action: "shell", resource: "rm -rf *", effect: "deny" },
]

/** The full agent ruleset — base policy first, user rules appended. */
const AGENT_RULES = [...BASE_POLICY, ...USER_RULES]

/** Fake runtime: `availability` records every invocation in `calls` and
 * memoizes the configured result (each actual computation recorded in
 * `probes` — the real runtime memoizes per process); `declined()` reports a
 * mutable flag the recording `markDeclined()` flips; `install()` records
 * and, on a successful result, flips the memoized availability to healthy
 * (the real runtime clears the memo so the next call re-probes). */
function makeRuntime(result, { declined = false } = {}) {
  const calls = []
  const probes = []
  const installCalls = []
  const markDeclinedCalls = []
  let declinedFlag = declined
  let memo
  let installResult = { ok: true }
  const rt = {
    calls,
    probes,
    installCalls,
    markDeclinedCalls,
    declined: () => declinedFlag,
    markDeclined() {
      markDeclinedCalls.push(true)
      declinedFlag = true
    },
    availability(input) {
      calls.push(input)
      if (!memo) {
        probes.push(input)
        memo = result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
      }
      return memo
    },
    install() {
      installCalls.push(true)
      if (installResult.ok === true) memo = Promise.resolve(OK)
      return Promise.resolve(installResult)
    },
    setInstallResult(r) {
      installResult = r
    },
  }
  return rt
}

/** Fake classifier: records (command, policy) calls and answers the
 * configured verdict (rejects when it is an Error); a function answer is
 * computed per command. */
function makeClassifier(answer) {
  const calls = []
  return {
    calls,
    classify(command, policy) {
      calls.push({ command, policy })
      const resolved = typeof answer === "function" ? answer(command) : answer
      return resolved instanceof Error ? Promise.reject(resolved) : Promise.resolve(resolved)
    },
  }
}

let agentCounter = 0

/** A fake plugin ctx for loadRules, over the probe-verified shapes:
 * agent.get → { location, data: { permissions } }; session.get → the
 * session object, which carries NO permissions key by default. A fresh
 * agentID per ctx by default (pass `agentID` to force a collision — the
 * per-instance loader test needs two gates over the SAME agentID). */
function makeCtx({ agentRules = AGENT_RULES, session = {}, throws, agentID: fixedAgentID } = {}) {
  const calls = { agent: [], session: [] }
  const agentID = fixedAgentID ?? `agent-${++agentCounter}`
  const ctx = {
    agent: {
      get: async (input) => {
        calls.agent.push(input)
        if (throws) throw throws
        return { location: { directory: "/repo" }, data: { permissions: agentRules } }
      },
    },
    session: {
      get: async (input) => {
        calls.session.push(input)
        if (throws) throw throws
        return session
      },
    },
  }
  return { ctx, calls, agentID }
}

/** A gate over fakes: resolved options, fake runtime, fake classifier,
 * fake rules ctx, captured logs, and a manually advanced clock. `decide`
 * is the convenience wrapper for the gate's decide with this world's ctx
 * and an auto-incremented call id. */
function makeGate({
  options = {},
  availability = OK,
  declined = false,
  classifier = { verdict: "SAFE" },
  agentRules = AGENT_RULES,
  session = {},
  ctxThrows,
  agentID,
} = {}) {
  const logs = []
  let t = 1_000_000
  const opts = resolveOptions(options)
  const runtime = makeRuntime(availability, { declined })
  const cls = makeClassifier(classifier)
  const { ctx, calls: ctxCalls } = makeCtx({ agentRules, session, throws: ctxThrows, agentID })
  const resolvedAgentID = agentID ?? `agent-${++agentCounter}`
  const gate = createGate({
    options: opts,
    runtime,
    classifier: cls,
    log: (m) => logs.push(m),
    now: () => t,
  })
  let callCounter = 0
  return {
    gate,
    opts,
    runtime,
    classifier: cls,
    logs,
    ctxCalls,
    agentID: resolvedAgentID,
    advance: (ms) => {
      t += ms
    },
    decide: (command, callID = `call-${++callCounter}`) =>
      gate.decide({ command, ctx, sessionID: "ses_1", agentID: resolvedAgentID, callID }),
  }
}

test("commandKeys: full text plus trimmed &&/||/;/|-segments, deduped; non-string → [\"\"]", () => {
  assert.deepEqual(commandKeys("make"), ["make"])
  assert.deepEqual(commandKeys("make && make install"), [
    "make && make install",
    "make",
    "make install",
  ])
  assert.deepEqual(commandKeys("a;b|c"), ["a;b|c", "a", "b", "c"])
  assert.deepEqual(commandKeys("cd x && srt npm test"), ["cd x && srt npm test", "cd x", "srt npm test"])
  assert.deepEqual(commandKeys("make&& make"), ["make&& make", "make"])
  assert.deepEqual(commandKeys("a || a"), ["a || a", "a"])
  assert.deepEqual(commandKeys(undefined), [""])
  assert.deepEqual(commandKeys(42), [""])
})

test("predicted allow → skip with NO runtime or classifier calls", async () => {
  const { decide, runtime, classifier, gate } = makeGate()
  const decision = await decide("uptime", "c1")
  assert.deepEqual(decision, { kind: "skip" })
  assert.equal(runtime.calls.length, 0)
  assert.equal(classifier.calls.length, 0)
  assert.equal(gate.messageFor("c1"), undefined)
  // An allow by a trailing-' *' rule is an allow too.
  assert.deepEqual(await decide("echo hi"), { kind: "skip" })
  assert.equal(runtime.calls.length, 0)
})

test("predicted deny → skip with NO runtime calls (deny-finality is the harness's)", async () => {
  const { decide, runtime, classifier } = makeGate()
  assert.deepEqual(await decide("rm -rf /tmp/x"), { kind: "skip" })
  assert.equal(runtime.calls.length, 0)
  assert.equal(classifier.calls.length, 0)
})

test("a session rule overrides a same-pattern agent rule (agent first, session appended)", async () => {
  const { decide, runtime } = makeGate({
    session: { permissions: [{ action: "shell", resource: "uptime", effect: "ask" }] },
  })
  // The agent allows `uptime`; the session's later ask rule wins → wrap.
  assert.deepEqual(await decide("uptime"), { kind: "wrap" })
  assert.equal(runtime.calls.length, 1)
})

test("prediction failure (ctx throws → loadRules not ok) → skip, no runtime calls", async () => {
  const { decide, runtime } = makeGate({ ctxThrows: new Error("ctx down") })
  assert.deepEqual(await decide("make"), { kind: "skip" })
  assert.equal(runtime.calls.length, 0)
  // A missing ctx is a failure too — status quo, never a wrap.
  const { gate } = makeGate()
  assert.deepEqual(await gate.decide({ command: "make" }), { kind: "skip" })
})

test("decide feeds sessionID/agentID to the rules loader", async () => {
  const { decide, ctxCalls, agentID } = makeGate()
  await decide("make")
  assert.deepEqual(ctxCalls.agent[0], { agentID })
  assert.deepEqual(ctxCalls.session[0], { sessionID: "ses_1" })
})

test("compound commands → skip before rules or runtime are consulted", async () => {
  const { decide, runtime, ctxCalls, classifier } = makeGate()
  for (const command of ["make && make install", "a;b|c", "make | tee log", "cd x || true"]) {
    assert.deepEqual(await decide(command), { kind: "skip" })
  }
  assert.equal(ctxCalls.agent.length, 0)
  assert.equal(ctxCalls.session.length, 0)
  assert.equal(runtime.calls.length, 0)
  assert.equal(classifier.calls.length, 0)
})

test("newline-separated and backgrounded commands are NOT simple → skip (the scanner splits them too)", async () => {
  const { decide, runtime, ctxCalls, classifier, gate } = makeGate()
  // The shell scanner's separator set is `<>&|;\\n`
  // (packages/core/src/shell/scan.ts:590,710) — a raw newline and a bare
  // `&` fragment exactly like `&&`/`||`/`;`/`|` do, so `commandKeys` alone
  // is a narrower test than the scanner's. These skip BEFORE rules or the
  // runtime are consulted.
  for (const command of [
    "npm install\nnpm test",
    "npm install\r\nnpm test",
    "sleep 1 & echo done",
    "make &\nmake test",
  ]) {
    assert.deepEqual(await decide(command), { kind: "skip" }, command)
  }
  assert.equal(ctxCalls.agent.length, 0)
  assert.equal(ctxCalls.session.length, 0)
  assert.equal(runtime.calls.length, 0)
  assert.equal(classifier.calls.length, 0)
  assert.equal(gate.messageFor("call-1"), undefined)

  // The shared correlation contract is unchanged: commandKeys still treats
  // a newline command as ONE key (a later compound's fragment lines up).
  assert.deepEqual(commandKeys("npm install\nnpm test"), ["npm install\nnpm test"])

  // Conservative on purpose: a plain `2>&1` redirect contains an `&` and
  // is therefore not wrapped — it follows the normal permission flow
  // (fails safe: it prompts instead of wrapping something the
  // exact-match recognizer cannot recognize).
  assert.deepEqual(await decide("npm install 2>&1"), { kind: "skip" })
  assert.equal(ctxCalls.agent.length, 0)
})

test("a plain simple command is still simple (the fix narrows nothing that works today)", async () => {
  const { decide } = makeGate()
  assert.deepEqual(await decide("make"), { kind: "wrap" })
  assert.deepEqual(await decide("npm install --save-dev typescript"), { kind: "wrap" })
})

test("each gate owns its rule cache: a config edit (a second plugin instance over the same agentID) sees the NEW rules", async () => {
  // Important 3: rules.js's agent cache used to be MODULE-scope, so a
  // config edit rebuilt plugin instances in the same process against a
  // stale ruleset (a new deny rule stayed invisible — and combined with
  // the deny-flip fix, a deny bypass). Per-instance loader: the second
  // gate re-reads the agent rules from ITS OWN ctx.
  const first = makeGate({
    agentID: "shared-agent",
    agentRules: [...AGENT_RULES],
  })
  assert.deepEqual(await first.decide("curl https://example.com"), { kind: "wrap" }) // shell * → ask

  const second = makeGate({
    agentID: "shared-agent", // the SAME agentID — the module scope used to collide here
    agentRules: [...AGENT_RULES, { action: "shell", resource: "curl https://example.com", effect: "deny" }],
  })
  assert.deepEqual(await second.decide("curl https://example.com"), { kind: "skip" }) // the new deny is visible
  assert.equal(second.ctxCalls.agent.length, 1) // its own ctx was actually consulted (no foreign cache hit)
  assert.deepEqual(second.ctxCalls.agent[0], { agentID: "shared-agent" })
})

test("a blank or non-string command skips before rules or runtime are consulted", async () => {
  const { gate, decide, runtime, ctxCalls } = makeGate()
  assert.deepEqual(await decide("   "), { kind: "skip" })
  assert.deepEqual(await gate.decide({ command: 42, ctx: null }), { kind: "skip" })
  assert.deepEqual(await gate.decide({}), { kind: "skip" })
  assert.deepEqual(await gate.decide(undefined), { kind: "skip" })
  assert.equal(ctxCalls.agent.length, 0)
  assert.equal(runtime.calls.length, 0)
})

test("enabled:false and a declined gate are inert without consulting rules or runtime", async () => {
  const off = makeGate({ options: { enabled: false } })
  assert.deepEqual(await off.decide("make"), { kind: "skip" })
  assert.equal(off.ctxCalls.agent.length, 0)
  assert.equal(off.runtime.calls.length, 0)

  const { gate, decide, runtime, ctxCalls } = makeGate()
  gate.markInstallDeclined()
  assert.equal(gate.declined(), true)
  assert.deepEqual(await decide("make"), { kind: "skip" })
  assert.equal(ctxCalls.agent.length, 0)
  assert.equal(runtime.calls.length, 0)
  // Idempotent.
  gate.markInstallDeclined()
  assert.deepEqual(await decide("make test"), { kind: "skip" })
})

test("wrap path: a predicted-ask eligible command wraps; availability consulted once per decide (memoized)", async () => {
  const { decide, runtime, opts, gate } = makeGate()
  assert.deepEqual(await decide("make", "c1"), { kind: "wrap" })
  assert.equal(runtime.calls.length, 1)
  assert.deepEqual(runtime.calls[0], { options: opts, requireSeccomp: false })
  assert.equal(gate.messageFor("c1"), undefined) // no message on the wrap path
  // A second eligible decide consults availability again, but the memoized
  // fake probed only once (mirroring the real runtime's per-process memo).
  assert.deepEqual(await decide("make test"), { kind: "wrap" })
  assert.equal(runtime.calls.length, 2)
  assert.equal(runtime.probes.length, 1)
})

test("the availability call carries requireSeccomp from the options", async () => {
  const on = makeGate({ options: { requireSeccomp: true } })
  await on.decide("make")
  assert.deepEqual(on.runtime.calls[0], { options: on.opts, requireSeccomp: true })
})

test("unavailable sandbox → one-time message naming the reason, then silent skips", async () => {
  const { decide, runtime, gate } = makeGate({ availability: { ok: false, reason: "unsupported-platform" } })
  const first = await decide("make", "c1")
  assert.equal(first.kind, "skip")
  assert.ok(first.message.includes("unsupported-platform"))
  // Stashed for the evaluate hook under the call id; consumed on read.
  assert.equal(gate.messageFor("c1").message, first.message)
  assert.equal(gate.messageFor("c1"), undefined)
  // Subsequent commands do not re-message.
  assert.deepEqual(await decide("make test", "c2"), { kind: "skip" })
  assert.equal(gate.messageFor("c2"), undefined)
  assert.equal(runtime.probes.length, 1)
})

test("srt invocations and excluded commands → skip silently (and before the classifier)", async () => {
  const { decide, gate, classifier } = makeGate({
    options: { excludedCommands: ["docker compose *", "sudo"], classifier: { enabled: true } },
  })
  for (const command of ["srt -- make", "docker compose up -d", "docker compose", "sudo"]) {
    assert.deepEqual(await decide(command), { kind: "skip" })
  }
  assert.equal(classifier.calls.length, 0)
  // `docker compose *` does not match `docker composese` (pattern boundary).
  assert.deepEqual(await decide("docker composese"), { kind: "wrap" })
  // No messages stashed for the silent skips.
  assert.equal(gate.messageFor("call-1"), undefined)
})

test("failure memory → silent skip; expires after failureMemorySec (lazy expiry on read)", async () => {
  const { gate, decide, advance } = makeGate({ options: { failureMemorySec: 30 } })
  gate.recordSandboxFailure("make", ["blocked network: example.com"])
  assert.deepEqual(await decide("make"), { kind: "skip" })
  advance(29_999)
  assert.deepEqual(await decide("make"), { kind: "skip" })
  advance(1) // now exactly 30s old → expired
  assert.deepEqual(await decide("make"), { kind: "wrap" })
})

test("a failure recorded under a compound's full text blocks a fragment decide (shared keys)", async () => {
  const { gate, decide } = makeGate()
  // Task 6 records with the full event.command; the retry's decide carries
  // the simple fragment — the failure must still correlate.
  gate.recordSandboxFailure("make && make install", ["v"])
  assert.deepEqual(await decide("make"), { kind: "skip" })
  assert.deepEqual(await decide("make install"), { kind: "skip" })
  assert.deepEqual(await decide("make test"), { kind: "wrap" })
})

test("attempt cap → skip; the cap is lifetime-per-text and per command text", async () => {
  const { gate, decide, advance } = makeGate() // default cap 3
  gate.recordAttempt("make")
  gate.recordAttempt("make")
  assert.deepEqual(await decide("make"), { kind: "wrap" })
  gate.recordAttempt("make") // third → at the cap
  assert.deepEqual(await decide("make"), { kind: "skip" })
  advance(10_000_000) // the cap never expires
  assert.deepEqual(await decide("make"), { kind: "skip" })
  assert.deepEqual(await decide("make test"), { kind: "wrap" })
})

test("classifier UNSAFE → skip with `Classifier: <reason>`, stashed per call id; the policy summary is options-built", async () => {
  const { decide, gate, classifier, opts } = makeGate({
    options: { classifier: { enabled: true } },
    classifier: { verdict: "UNSAFE", reason: "needs registry.npmjs.org" },
  })
  const decision = await decide("npm install", "c1")
  assert.deepEqual(decision, { kind: "skip", message: "Classifier: needs registry.npmjs.org" })
  assert.equal(gate.messageFor("c1").message, "Classifier: needs registry.npmjs.org")
  assert.equal(gate.messageFor("c1"), undefined) // consumed on read
  // The classifier saw the command text and the policy summary built from options.
  assert.equal(classifier.calls.length, 1)
  assert.equal(classifier.calls[0].command, "npm install")
  assert.deepEqual(classifier.calls[0].policy, {
    allowedDomains: opts.network.allowedDomains,
    writeRoots: ["<command working directory>", tmpdir()],
    deniedReads: opts.filesystem.denyRead,
  })
})

test("classifier UNSAFE without a reason falls back to a static message", async () => {
  const { decide } = makeGate({
    options: { classifier: { enabled: true } },
    classifier: { verdict: "UNSAFE" },
  })
  assert.deepEqual(await decide("npm install"), {
    kind: "skip",
    message: "Classifier: command would not succeed inside the sandbox",
  })
})

test("classifier SAFE still wraps; a disabled classifier is never called", async () => {
  const safe = makeGate({ options: { classifier: { enabled: true } }, classifier: { verdict: "SAFE" } })
  assert.deepEqual(await safe.decide("make"), { kind: "wrap" })
  assert.equal(safe.classifier.calls.length, 1)

  const off = makeGate({ classifier: { verdict: "UNSAFE", reason: "x" } })
  assert.deepEqual(await off.decide("make"), { kind: "wrap" })
  assert.equal(off.classifier.calls.length, 0)
})

test("ordering: failure memory, the cap, and exclusions skip before the classifier runs", async () => {
  const failed = makeGate({ options: { classifier: { enabled: true } } })
  failed.gate.recordSandboxFailure("make", ["v"])
  assert.deepEqual(await failed.decide("make"), { kind: "skip" })
  assert.equal(failed.classifier.calls.length, 0)

  const capped = makeGate({ options: { classifier: { enabled: true }, maxSandboxAttempts: 1 } })
  capped.gate.recordAttempt("make")
  assert.deepEqual(await capped.decide("make"), { kind: "skip" })
  assert.equal(capped.classifier.calls.length, 0)

  const excluded = makeGate({
    options: { classifier: { enabled: true }, excludedCommands: ["make"] },
  })
  assert.deepEqual(await excluded.decide("make"), { kind: "skip" })
  assert.equal(excluded.classifier.calls.length, 0)
})

test("package missing + install:\"ask\" → consent message stashed per call id; not declined; no install yet", async () => {
  const { decide, gate, runtime } = makeGate({ availability: { ok: false, reason: "not-installed" } })
  const decision = await decide("make", "c1")
  assert.deepEqual(decision, { kind: "skip", message: CONSENT })
  // Stashed for the evaluate hook under this call id; consumed on read.
  assert.equal(gate.messageFor("c1").message, CONSENT)
  assert.equal(gate.messageFor("c1"), undefined)
  assert.equal(gate.declined(), false)
  assert.equal(runtime.installCalls.length, 0)
  assert.equal(runtime.markDeclinedCalls.length, 0)
})

test("a second decide while consent is outstanding infers the denial and goes inert", async () => {
  const { decide, gate, runtime } = makeGate({ availability: { ok: false, reason: "not-installed" } })
  assert.deepEqual(await decide("make", "c1"), { kind: "skip", message: CONSENT })
  // The user denied: the tool call never executed and the model retries.
  // The repeat reaching the consent branch is the only denial signal.
  assert.deepEqual(await decide("make", "c2"), { kind: "skip" }) // silent: no re-prompt loop
  assert.equal(gate.declined(), true)
  assert.equal(runtime.declined(), true) // mirrored into the runtime
  assert.equal(runtime.markDeclinedCalls.length, 1)
  // The consent state must not outlive the denial: the stashed message is swept.
  assert.equal(gate.messageFor("c1"), undefined)
  assert.equal(gate.messageFor("c2"), undefined)
  // Inert for fresh command texts too.
  assert.deepEqual(await decide("make test", "c3"), { kind: "skip" })
  assert.equal(runtime.installCalls.length, 0)
})

test("an outstanding consent for ANOTHER command infers the denial (session-wide)", async () => {
  const { decide, gate } = makeGate({ availability: { ok: false, reason: "not-installed" } })
  assert.deepEqual(await decide("make", "c1"), { kind: "skip", message: CONSENT })
  // Permission asks are sequential: a different command reaching the
  // consent branch while c1's ask is outstanding means c1 was denied.
  assert.deepEqual(await decide("make test", "c2"), { kind: "skip" })
  assert.equal(gate.declined(), true)
})

test("noteGranted clears the consent and fires the background install; the next decide wraps", async () => {
  const { decide, gate, runtime } = makeGate({ availability: { ok: false, reason: "not-installed" } })
  assert.deepEqual(await decide("make", "c1"), { kind: "skip", message: CONSENT })
  // The user approved: the command executed (unsandboxed — approval ran it
  // with normal permissions) and execute.after proves the grant.
  gate.noteGranted("c1")
  await new Promise((resolve) => setImmediate(resolve)) // the install is fire-and-forget
  assert.equal(runtime.installCalls.length, 1)
  assert.equal(gate.declined(), false)
  // The fake's successful install flipped availability (the real runtime
  // clears its memo and re-probes): the next predicted-ask command wraps.
  assert.deepEqual(await decide("make test", "c2"), { kind: "wrap" })
})

test("noteGranted without an outstanding consent is a no-op (no install fired)", async () => {
  const { decide, gate, runtime } = makeGate()
  assert.deepEqual(await decide("make", "c1"), { kind: "wrap" })
  gate.noteGranted("c1") // this call wrapped — no consent was pending
  gate.noteGranted("never-seen")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runtime.installCalls.length, 0)
})

test("package missing + install:\"never\" → one-time unavailable message, not the consent", async () => {
  const { decide, gate } = makeGate({
    options: { install: "never" },
    availability: { ok: false, reason: "not-installed" },
  })
  const decision = await decide("make", "c1")
  assert.equal(decision.kind, "skip")
  assert.ok(decision.message.includes("not-installed"))
  assert.notEqual(decision.message, CONSENT)
  assert.equal(gate.declined(), false)
})

test("package missing + declined runtime → unavailable message, not the consent", async () => {
  const { decide } = makeGate({ availability: { ok: false, reason: "not-installed" }, declined: true })
  const decision = await decide("make")
  assert.equal(decision.kind, "skip")
  assert.ok(decision.message.includes("not-installed"))
  assert.notEqual(decision.message, CONSENT)
})

test("exclusions, failure memory, and the classifier skip WITHOUT the consent prompt even when installable", async () => {
  const { gate, decide } = makeGate({
    options: { excludedCommands: ["docker *"], classifier: { enabled: true } },
    availability: { ok: false, reason: "not-installed" },
    classifier: (cmd) =>
      cmd === "npm install" ? { verdict: "UNSAFE", reason: "needs network" } : { verdict: "SAFE" },
  })
  assert.deepEqual(await decide("docker ps", "c1"), { kind: "skip" })
  gate.recordSandboxFailure("make", ["v"])
  assert.deepEqual(await decide("make", "c2"), { kind: "skip" })
  const unsafe = await decide("npm install", "c3")
  assert.equal(unsafe.message, "Classifier: needs network")
  // None of the three stashed a consent message; the gate is not declined.
  assert.equal(gate.messageFor("c1"), undefined)
  assert.equal(gate.messageFor("c2"), undefined)
  assert.equal(gate.messageFor("c3").message, "Classifier: needs network")
  assert.equal(gate.declined(), false)
  // A clean command still gets the consent prompt.
  assert.deepEqual(await decide("make test", "c4"), { kind: "skip", message: CONSENT })
})

test("markInstallDeclined mirrors into the runtime, clears consent state, and is idempotent", async () => {
  const { decide, gate, runtime } = makeGate({ availability: { ok: false, reason: "not-installed" } })
  assert.equal(runtime.declined(), false)
  assert.deepEqual(await decide("make", "c1"), { kind: "skip", message: CONSENT })
  gate.markInstallDeclined()
  assert.equal(gate.declined(), true)
  assert.equal(runtime.declined(), true)
  assert.equal(runtime.markDeclinedCalls.length, 1)
  // The outstanding consent and its stashed message are swept — a denial
  // must not outlive the ask.
  assert.equal(gate.messageFor("c1"), undefined)
  gate.markInstallDeclined() // idempotent
  assert.equal(gate.declined(), true)
})

test("markInstallDeclined tolerates a runtime without markDeclined", async () => {
  const bare = {
    declined: () => false,
    availability: () => Promise.resolve({ ok: false, reason: "not-installed" }),
  }
  const { ctx, agentID } = makeCtx()
  const gate = createGate({
    options: resolveOptions({}),
    runtime: bare, // no markDeclined — the optional call must not throw
    classifier: makeClassifier({ verdict: "SAFE" }),
    log: () => {},
  })
  gate.markInstallDeclined() // must not throw
  assert.equal(gate.declined(), true)
  // The inference path (which calls markInstallDeclined) is safe too.
  const gate2 = createGate({
    options: resolveOptions({}),
    runtime: bare,
    classifier: makeClassifier({ verdict: "SAFE" }),
    log: () => {},
  })
  await gate2.decide({ command: "make", ctx, sessionID: "s", agentID, callID: "c1" })
  await gate2.decide({ command: "make", ctx, sessionID: "s", agentID, callID: "c2" })
  assert.equal(gate2.declined(), true)
})

test("decide never throws: a rejecting availability probe skips (and logs)", async () => {
  const { decide, logs } = makeGate({ availability: new Error("self-test exploded") })
  assert.deepEqual(await decide("make"), { kind: "skip" })
  assert.ok(logs.some((m) => m.includes("[sandbox]")))
})

test("decide never throws: a rejecting classifier skips (and logs)", async () => {
  const { decide, logs } = makeGate({
    options: { classifier: { enabled: true } },
    classifier: new Error("gateway down"),
  })
  assert.deepEqual(await decide("make"), { kind: "skip" })
  assert.ok(logs.some((m) => m.includes("[sandbox]")))
})

test("decide never throws: a runtime without availability skips (and logs)", async () => {
  const { ctx, agentID } = makeCtx()
  const gate = createGate({
    options: resolveOptions({}),
    runtime: {}, // no availability at all
    classifier: makeClassifier({ verdict: "SAFE" }),
    log: () => {},
  })
  assert.deepEqual(await gate.decide({ command: "make", ctx, sessionID: "s", agentID, callID: "c" }), {
    kind: "skip",
  })
})

test("recordAttempt / recordSandboxFailure / noteGranted / messageFor never throw on garbage", async () => {
  const { gate, decide } = makeGate()
  gate.recordAttempt(undefined)
  gate.recordAttempt(42)
  gate.recordSandboxFailure(undefined, "not-an-array")
  gate.recordSandboxFailure("make", "not-an-array")
  gate.noteGranted(undefined)
  assert.equal(gate.messageFor(undefined), undefined)
  // The garbage failure for "make" still marks it (evidence shape is not vetted).
  assert.deepEqual(await decide("make"), { kind: "skip" })
})
