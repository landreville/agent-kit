import { test } from "node:test"
import assert from "node:assert/strict"
import plugin, { createSetup } from "../index.js"
import { createGate } from "../policy.js"

// The wiring tests (v2): a fake ctx captures the hook registrations, and
// the createSetup overrides inject fake runtime/gate/classifier/after
// handlers that RECORD CALL ORDER into a shared `calls` log. The fakes
// mimic the real modules' contracts (policy.js's gate decides wrap/skip
// and stashes messages per call id; violations.js's after handler
// dual-indexes the wrapped string and annotates a completed result) so
// the wiring is pinned against the contracts, not the plan text.
//
// v2 hook flow (verified order: tool.execute.before → permission.evaluate
// → spawn → tool.execute.after):
//   execute.before  — gate.decide PREDICTS the permission outcome; on
//                     "wrap" the wiring wraps and rewrites
//                     event.input.command (the LAST mutation: every
//                     failure before it leaves the input untouched —
//                     the status quo, since v2 never flipped a permission
//                     for an unwrapped command).
//   evaluate        — recognize, don't decide: a resource that exact-matches
//                     a wrapped string this plugin produced flips to allow;
//                     otherwise the gate's stashed message (per call id) is
//                     surfaced. Never flips otherwise.
//   execute.after   — gate.noteGranted(event.id) (the consent flow's
//                     approval signal — fires the background install),
//                     then the after handler.

/** A fake ctx capturing hook registrations per namespace. */
function makeCtx(options = {}) {
  const hooks = { permission: [], shell: [], tool: [] }
  const ctx = {
    options,
    location: { directory: "/repo" },
    permission: {
      hook: (name, fn) => {
        hooks.permission.push({ name, fn })
        return { namespace: "permission", name, fn }
      },
    },
    shell: {
      hook: (name, fn) => {
        hooks.shell.push({ name, fn })
        return { namespace: "shell", name, fn }
      },
    },
    tool: {
      hook: (name, fn) => {
        hooks.tool.push({ name, fn })
        return { namespace: "tool", name, fn }
      },
    },
  }
  return { ctx, hooks }
}

/**
 * A full fake world: ordered call log, captured logs, and the fakes.
 * `over` tweaks behavior: decision (the gate.decide result, default
 * {kind:"wrap"}), availability, install, module, decideThrows,
 * messageForThrows, stash (the messageFor result), wrapped (pre-seeded
 * wrapped strings for after.isWrapped), isWrappedThrows, wrapThrows,
 * wrapResult (an explicit wrapWithSandbox return value, e.g. a
 * non-string), noteGrantedThrows, afterThrows, resetThrows.
 */
function makeWorld(over = {}) {
  const calls = []
  const logs = []
  /** The wrapped-string index the fake after handler maintains on begin —
   *  the violations.js contract the evaluate hook relies on. */
  const wrappedSet = new Set(over.wrapped ?? [])
  const state = {
    decision: "decision" in over ? over.decision : { kind: "wrap" },
    availability: over.availability ?? { ok: true, mode: "seccomp" },
    install: over.install ?? { ok: true },
    module:
      "module" in over
        ? over.module // an explicit undefined = load() yields no module
        : {
            SandboxManager: {
              wrapWithSandbox: async (command, binShell, customConfig, reserved, opts) => {
                calls.push({
                  name: "wrapWithSandbox",
                  args: [command, binShell, customConfig, reserved, opts],
                })
                if (over.wrapThrows) throw new Error("wrap blew up")
                if ("wrapResult" in over) return over.wrapResult // e.g. a non-string
                return `SRT-WRAPPED[${command}]`
              },
            },
          },
  }

  const runtime = {
    install: async () => {
      calls.push({ name: "install", args: [] })
      return state.install
    },
    availability: async (input) => {
      calls.push({ name: "availability", args: [input] })
      return state.availability
    },
    load: async () => {
      calls.push({ name: "load", args: [] })
      return state.module
    },
    store: () => ({ marker: "the-store" }),
    reset: async () => {
      calls.push({ name: "reset", args: [] })
      if (over.resetThrows) throw new Error("reset blew up")
    },
    declined: () => false,
    markDeclined: () => {},
    sandboxMode: () => "seccomp",
  }

  const gate = {
    decide: async (input) => {
      calls.push({ name: "decide", args: [input] })
      if (over.decideThrows) throw new Error("decide blew up")
      return state.decision
    },
    noteGranted: (callID) => {
      calls.push({ name: "noteGranted", args: [callID] })
      if (over.noteGrantedThrows) throw new Error("noteGranted blew up")
    },
    messageFor: (callID) => {
      calls.push({ name: "messageFor", args: [callID] })
      if (over.messageForThrows) throw new Error("messageFor blew up")
      return over.stash
    },
    recordAttempt: (command) => {
      calls.push({ name: "recordAttempt", args: [command] })
    },
    recordSandboxFailure: () => {},
    markInstallDeclined: () => {},
    declined: () => false,
  }

  const classifier = {
    classify: async () => ({ verdict: "SAFE" }),
  }

  const after = {
    begin: (command, entry) => {
      calls.push({ name: "begin", args: [command, entry] })
      // The real handler dual-indexes the wrapped string; the fake mirrors
      // it so the evaluate hook's recognize-path is pinned end-to-end.
      if (typeof entry?.wrapped === "string") wrappedSet.add(entry.wrapped)
    },
    isWrapped: (resource) => {
      calls.push({ name: "isWrapped", args: [resource] })
      if (over.isWrappedThrows) throw new Error("isWrapped blew up")
      return wrappedSet.has(resource)
    },
    handleAfter: async (event) => {
      calls.push({ name: "handleAfter", args: [event] })
      if (over.afterThrows) throw new Error("after blew up")
      // Simulate the real handler's completed-run annotation so the test
      // sees the wiring forward the live event object.
      if (event?.status === "completed" && event.result && typeof event.result === "object") {
        event.result.metadata = { ...(event.result.metadata ?? {}), sandbox: { mode: "sandbox" } }
      }
    },
  }

  const setup = createSetup({
    createRuntime: (deps) => {
      calls.push({ name: "createRuntime", args: [deps] })
      return runtime
    },
    createGate: (deps) => {
      calls.push({ name: "createGate", args: [deps] })
      return gate
    },
    createClassifier: (ctxArg, classifierOptions) => {
      calls.push({ name: "createClassifier", args: [ctxArg, classifierOptions] })
      return classifier
    },
    createAfterHandler: (deps) => {
      calls.push({ name: "createAfterHandler", args: [deps] })
      return after
    },
    randomId: () => "test-command-id",
    log: (m) => logs.push(m),
  })

  const names = () => calls.map((c) => c.name)
  /** Call names made by hook bodies only (the setup-time factory calls
   * filtered out) — for the load-bearing hook-sequence assertions. */
  const hookNames = () =>
    names().filter(
      (n) => !["createRuntime", "createClassifier", "createGate", "createAfterHandler"].includes(n),
    )
  const findCall = (name) => calls.find((c) => c.name === name)
  return {
    setup,
    calls,
    names,
    hookNames,
    findCall,
    logs,
    runtime,
    gate,
    classifier,
    after,
    state,
    wrappedSet,
  }
}

/** A shell `tool.execute.before` event (the verified published shape). */
function beforeEvent(command, over = {}) {
  return {
    tool: "bash",
    id: "call_1",
    sessionID: "s1",
    agent: "build",
    messageID: "msg_1",
    input: { command },
    ...over,
  }
}

test("default export: { id: 'sandbox', setup } — plain ESM object", () => {
  assert.equal(plugin.id, "sandbox")
  assert.equal(typeof plugin.setup, "function")
  assert.deepEqual(Object.keys(plugin).sort(), ["id", "setup"])
})

test("enabled:false registers nothing and constructs nothing", async () => {
  const { ctx, hooks } = makeCtx({ enabled: false })
  const { setup, calls } = makeWorld()
  const cleanup = await setup(ctx)
  assert.equal(cleanup, undefined)
  assert.equal(hooks.permission.length, 0)
  assert.equal(hooks.shell.length, 0)
  assert.equal(hooks.tool.length, 0)
  assert.deepEqual(calls, []) // not even the factories ran
})

test("setup registers execute.before, evaluate, execute.after — NO shell hook — and wires the factories", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, findCall, gate, classifier, after, runtime } = makeWorld()
  const cleanup = await setup(ctx)

  assert.deepEqual(
    hooks.tool.map((h) => h.name),
    ["execute.before", "execute.after"],
  )
  assert.deepEqual(
    hooks.permission.map((h) => h.name),
    ["evaluate"],
  )
  assert.equal(hooks.shell.length, 0) // the v1 shell.create.before hook is gone
  for (const list of Object.values(hooks)) {
    for (const { fn } of list) assert.equal(typeof fn, "function")
  }
  assert.equal(typeof cleanup, "function")

  // The factory wiring: pluginDir derived from the plugin's own directory,
  // gate over { options, runtime, classifier }, after over { store, gate, log }.
  const createRuntimeCall = findCall("createRuntime")
  assert.equal(typeof createRuntimeCall.args[0].pluginDir, "string")
  assert.ok(createRuntimeCall.args[0].pluginDir.endsWith("sandbox"))

  const createGateCall = findCall("createGate")
  assert.equal(createGateCall.args[0].runtime, runtime)
  assert.equal(createGateCall.args[0].classifier, classifier)
  assert.equal(createGateCall.args[0].options.enabled, true)
  assert.deepEqual(createGateCall.args[0].options.classifier, {
    enabled: false,
    providerID: "litellm",
    id: "jev-1.13",
  })

  const createClassifierCall = findCall("createClassifier")
  assert.equal(createClassifierCall.args[0], ctx)
  assert.deepEqual(createClassifierCall.args[1], {
    enabled: false,
    providerID: "litellm",
    id: "jev-1.13",
  })

  const createAfterCall = findCall("createAfterHandler")
  assert.equal(createAfterCall.args[0].gate, gate)
  assert.equal(typeof createAfterCall.args[0].store, "function")
  assert.equal(typeof createAfterCall.args[0].log, "function")
  assert.deepEqual(createAfterCall.args[0].store(), { marker: "the-store" }) // delegates to runtime.store()
  assert.ok(after) // constructed
})

test("execute.before happy path: decide→wrap — input replaced, begin/recordAttempt with the ORIGINAL text, binShell undefined", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, findCall, hookNames } = makeWorld()
  await setup(ctx)

  const payload = `printf '%s' "$HOME/*; rm -rf /" | sh` // metacharacters stay verbatim inside the wrap
  const event = beforeEvent(payload)
  await hooks.tool[0].fn(event)

  // The command is replaced WHOLESALE, the payload verbatim inside it.
  assert.equal(event.input.command, `SRT-WRAPPED[${payload}]`)

  // decide received the original command and the event's identifiers.
  assert.deepEqual(findCall("decide").args, [
    { command: payload, ctx, sessionID: "s1", agentID: "build", callID: "call_1" },
  ])

  // wrapWithSandbox(command, undefined, customConfig, undefined, { commandId, commandText })
  const wrap = findCall("wrapWithSandbox")
  assert.equal(wrap.args[0], payload)
  assert.equal(wrap.args[1], undefined) // the library's default shell — v1's per-command shell is gone
  assert.equal(typeof wrap.args[2], "object")
  assert.ok(wrap.args[2].filesystem.allowWrite.includes("/repo")) // the real buildCustomConfig, cwd = ctx.location.directory
  assert.equal(wrap.args[2].network, undefined) // no allowUnixSockets at wrap time (the initialized base carries the mode)
  assert.equal(wrap.args[3], undefined)
  assert.deepEqual(wrap.args[4], { commandId: "test-command-id", commandText: payload })

  // begin and recordAttempt see the ORIGINAL command text; begin carries
  // the wrapped string for the dual index.
  assert.deepEqual(findCall("begin").args, [
    payload,
    { commandId: "test-command-id", cwd: "/repo", wrapped: `SRT-WRAPPED[${payload}]` },
  ])
  assert.deepEqual(findCall("recordAttempt").args, [payload])

  // The whole wrap sequence, in order: decide first; the bookkeeping
  // (recordAttempt, begin) BEFORE the input rewrite.
  assert.deepEqual(hookNames(), [
    "decide",
    "availability",
    "load",
    "wrapWithSandbox",
    "recordAttempt",
    "begin",
  ])

  // The availability re-check carries the resolved options plus
  // requireSeccomp — the SAME input the gate passes (M-4: the
  // inert-instead-of-degrade guarantee must not be lost to a reorder).
  const availabilityInput = findCall("availability").args[0]
  assert.deepEqual(Object.keys(availabilityInput).sort(), ["options", "requireSeccomp"])
  assert.equal(availabilityInput.options, findCall("createGate").args[0].options)
  assert.equal(availabilityInput.requireSeccomp, false) // the resolved default
})

test("execute.before: with requireSeccomp:true the availability re-check passes it through (M-4)", async () => {
  const { ctx, hooks } = makeCtx({ requireSeccomp: true })
  const { setup, findCall } = makeWorld()
  await setup(ctx)

  await hooks.tool[0].fn(beforeEvent("make"))
  const availabilityInput = findCall("availability").args[0]
  assert.equal(availabilityInput.requireSeccomp, true)
  assert.equal(availabilityInput.options.requireSeccomp, true)
})

test("execute.before: non-shell tools and non-string commands are strict no-ops", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, hookNames } = makeWorld()
  await setup(ctx)

  const read = { tool: "read", id: "call_1", input: { command: "make", path: "/repo/x" } }
  await hooks.tool[0].fn(read)
  assert.equal(read.input.command, "make")

  const weird = beforeEvent(undefined, { input: { command: 42 } })
  await hooks.tool[0].fn(weird)
  assert.equal(weird.input.command, 42)

  const noInput = { tool: "bash", id: "call_2" }
  await hooks.tool[0].fn(noInput)

  assert.deepEqual(hookNames(), []) // decide never ran
})

test("execute.before: decide skip (allow-listed / compound / ineligible) → input untouched, no runtime calls", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, hookNames } = makeWorld({ decision: { kind: "skip" } })
  await setup(ctx)

  const event = beforeEvent("git push --dry-run")
  await hooks.tool[0].fn(event)
  assert.equal(event.input.command, "git push --dry-run")
  assert.deepEqual(hookNames(), ["decide"]) // nothing after a skip

  const event2 = beforeEvent("make", { id: "call_2" })
  await hooks.tool[0].fn(event2)
  assert.equal(event2.input.command, "make")
  assert.deepEqual(hookNames(), ["decide", "decide"])
})

test("execute.before: availability not ok after a wrap decision → input untouched, load/wrap never run", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, hookNames } = makeWorld({
    availability: { ok: false, reason: "self-test failed: exit=1" },
  })
  await setup(ctx)

  const event = beforeEvent("make")
  await hooks.tool[0].fn(event)
  assert.equal(event.input.command, "make") // status quo: the rules decide normally
  assert.deepEqual(hookNames(), ["decide", "availability"])
})

test("execute.before: load yields no module → input untouched, wrap never runs", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, hookNames } = makeWorld({ module: undefined })
  await setup(ctx)

  const event = beforeEvent("make")
  await hooks.tool[0].fn(event)
  assert.equal(event.input.command, "make")
  assert.deepEqual(hookNames(), ["decide", "availability", "load"])
})

test("execute.before: module without a usable wrapWithSandbox → input untouched", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, hookNames } = makeWorld({ module: { SandboxManager: {} } })
  await setup(ctx)

  const event = beforeEvent("make")
  await hooks.tool[0].fn(event)
  assert.equal(event.input.command, "make")
  assert.deepEqual(hookNames(), ["decide", "availability", "load"])
})

test("execute.before: a throwing wrap never rejects, leaves the input untouched, and later calls still work", async () => {
  const { ctx, hooks } = makeCtx({})
  const world = makeWorld({ wrapThrows: true })
  await world.setup(ctx)

  const event = beforeEvent("make")
  await hooks.tool[0].fn(event) // must not reject
  assert.equal(event.input.command, "make") // untouched — v2 fails toward the status quo, no stub
  assert.ok(!world.names().includes("begin")) // a failed wrap registers no run
  assert.ok(!world.names().includes("recordAttempt")) // counted only once the wrapped string exists
  assert.ok(world.logs.some((m) => m.includes("wrap blew up")))

  // Subsequent calls are unaffected: a healthy fake wraps the next command.
  const world2 = makeWorld()
  const { ctx: ctx2, hooks: hooks2 } = makeCtx({})
  await world2.setup(ctx2)
  const event2 = beforeEvent("make")
  await hooks2.tool[0].fn(event2)
  assert.equal(event2.input.command, "SRT-WRAPPED[make]")
})

test("execute.before: a non-string wrap result → input untouched, no bookkeeping", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, hookNames } = makeWorld({ wrapResult: undefined })
  await setup(ctx)

  const event = beforeEvent("make")
  await hooks.tool[0].fn(event)
  assert.equal(event.input.command, "make")
  assert.deepEqual(hookNames(), ["decide", "availability", "load", "wrapWithSandbox"])
  // recordAttempt/begin never ran.
})

test("execute.before: a wrap returning the command VERBATIM leaves the input untouched and registers nothing", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, hookNames, logs, wrappedSet } = makeWorld({ wrapResult: "make" })
  await setup(ctx)

  const event = beforeEvent("make")
  await hooks.tool[0].fn(event)
  // A degenerate wrap must NOT index the original text in the wrapped set —
  // that would let evaluate flip an UNWRAPPED command to allow.
  assert.equal(event.input.command, "make") // untouched
  assert.deepEqual(hookNames(), ["decide", "availability", "load", "wrapWithSandbox"])
  assert.equal(wrappedSet.size, 0) // begin never ran
  assert.ok(logs.some((m) => m.includes("verbatim")))
})

test("execute.before: a throwing gate.decide never rejects and leaves the input untouched", async () => {
  const { ctx, hooks } = makeCtx({})
  const world = makeWorld({ decideThrows: true })
  await world.setup(ctx)

  const event = beforeEvent("make")
  await hooks.tool[0].fn(event) // must not reject
  assert.equal(event.input.command, "make")
  assert.ok(world.logs.some((m) => m.includes("decide blew up")))
  assert.deepEqual(world.hookNames(), ["decide"])
})

test("evaluate: a resource exact-matching the wrapped string flips to allow (messageFor NOT consulted)", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, names } = makeWorld({ wrapped: ["SRT-WRAPPED[make]"] })
  await setup(ctx)

  const event = {
    action: "shell",
    effect: "ask",
    resources: ["SRT-WRAPPED[make]"],
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
  }
  await hooks.permission[0].fn(event)
  assert.equal(event.effect, "allow")
  assert.equal(event.message, undefined)
  assert.ok(!names().includes("messageFor")) // the flip needs no stash
})

test("evaluate (chained): the string execute.before produced is what evaluate recognizes (Review Focus 2+4)", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup } = makeWorld() // the fake after-handler indexes wrapped on begin
  await setup(ctx)

  const before = beforeEvent("make")
  await hooks.tool[0].fn(before)
  const wrappedString = before.input.command
  assert.equal(wrappedString, "SRT-WRAPPED[make]")

  // The harness evaluates the WRAPPED command; the plugin recognizes its
  // own string and flips — the decision was made pre-wrap on the original.
  const evaluate = {
    action: "shell",
    effect: "ask",
    resources: [wrappedString],
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
  }
  await hooks.permission[0].fn(evaluate)
  assert.equal(evaluate.effect, "allow")
})

test("execute.before happy path (compound): decide→wrap — recordAttempt/begin under the ORIGINAL text, evaluate flips the wrapped string to allow", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, findCall, hookNames } = makeWorld()
  await setup(ctx)

  const payload = "set -e\ngit status --short" // a parseable compound (newline separator)
  const event = beforeEvent(payload)
  await hooks.tool[0].fn(event)

  // The command is replaced WHOLESALE with the wrapped string.
  assert.equal(event.input.command, `SRT-WRAPPED[${payload}]`)

  // decide received the original compound text.
  assert.deepEqual(findCall("decide").args, [
    { command: payload, ctx, sessionID: "s1", agentID: "build", callID: "call_1" },
  ])

  // begin and recordAttempt see the ORIGINAL compound text; begin carries
  // the wrapped string for the dual index.
  assert.deepEqual(findCall("begin").args, [
    payload,
    { commandId: "test-command-id", cwd: "/repo", wrapped: `SRT-WRAPPED[${payload}]` },
  ])
  assert.deepEqual(findCall("recordAttempt").args, [payload])

  // The whole wrap sequence, in order.
  assert.deepEqual(hookNames(), [
    "decide",
    "availability",
    "load",
    "wrapWithSandbox",
    "recordAttempt",
    "begin",
  ])

  // The harness evaluates the WRAPPED compound; the plugin recognizes its
  // own string and flips — the decision was made pre-wrap on the original.
  const evaluate = {
    action: "shell",
    effect: "ask",
    resources: [event.input.command],
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
  }
  await hooks.permission[0].fn(evaluate)
  assert.equal(evaluate.effect, "allow")
})

// Final-review fix wave (RED → GREEN): the messages below are the
// Important 1 / Important 2 / M-1 / M-4 assertions. Each one FAILED
// against the pre-fix wiring:
//   Important 1 — the stash was consumed by the external_directory ask
//                (the shell action's event stayed silent).
//   Important 2 — a wrapped resource flipped an incoming `deny` to `allow`.
//   M-1        — noteGranted fired for a completed NON-shell tool call.
//   M-4        — the availability re-check dropped `requireSeccomp`.

test("evaluate: the shell tool's prepare asks external_directory FIRST — the message is not consumed by it (Important 1)", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, names, findCall } = makeWorld({
    stash: {
      message: "Sandbox unavailable (self-test failed) — approving runs the command unsandboxed (normal permissions).",
    },
  })
  await setup(ctx)

  // The shell tool's prepare() evaluates the external_directory ask
  // BEFORE the shell ask, both under the SAME `source.id`
  // (packages/core/src/tool/plugin/file-access.ts:125-142, then
  // shell.ts:138). Since gate.messageFor DELETES on read, the
  // external_directory evaluate must not touch the stash.
  const external = {
    action: "external_directory",
    effect: "allow",
    resources: ["/repo/x"],
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
  }
  await hooks.permission[0].fn(external)
  assert.equal(external.effect, "allow") // untouched: not the plugin's action
  assert.equal(external.message, undefined) // the stash is NOT consumed here
  assert.ok(!names().includes("messageFor"))
  assert.ok(!names().includes("isWrapped"))

  // The ask the user actually answers — the SHELL action, same call id —
  // carries the stashed message.
  const shell = {
    action: "shell",
    effect: "ask",
    resources: ["make"],
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
  }
  await hooks.permission[0].fn(shell)
  assert.equal(shell.effect, "ask")
  assert.equal(
    shell.message,
    "Sandbox unavailable (self-test failed) — approving runs the command unsandboxed (normal permissions).",
  )
  assert.deepEqual(findCall("messageFor").args, ["call_1"]) // exactly once, on the shell action
})

test("evaluate: a non-shell action never flips a wrapped resource either (the recognizer needs the shell action)", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, names } = makeWorld({ wrapped: ["SRT-WRAPPED[make]"], stash: { message: "M" } })
  await setup(ctx)

  const external = {
    action: "external_directory",
    effect: "ask",
    resources: ["SRT-WRAPPED[make]"],
    source: { type: "tool", id: "call_1" },
  }
  await hooks.permission[0].fn(external) // must not throw, must not flip
  assert.equal(external.effect, "ask")
  assert.equal(external.message, undefined)
  assert.ok(!names().includes("isWrapped"))
  assert.ok(!names().includes("messageFor"))
})

test("evaluate: an incoming deny is never flipped — a deny rule on the WRAPPED string stays final (Important 2)", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, names } = makeWorld({ wrapped: ["SRT-WRAPPED[make]"], stash: { message: "M" } })
  await setup(ctx)

  // A user rule `"shell": { "bwrap *": "deny" }` (or another plugin's
  // deny) matching the wrapped resource: the plugin's own allow must not
  // override it — the pre-wrap decision was made on the ORIGINAL command,
  // and this asks about the wrapped one.
  const denied = {
    action: "shell",
    effect: "deny",
    resources: ["SRT-WRAPPED[make]"],
    source: { type: "tool", id: "call_1" },
  }
  await hooks.permission[0].fn(denied)
  assert.equal(denied.effect, "deny")
  assert.equal(denied.message, undefined) // a denial carries no message
  assert.ok(!names().includes("isWrapped"))

  // An `allow` effect (the harness's own allow-listed command) is not
  // flipped either — only an ASK is what the wrap decision answered.
  const allowed = {
    action: "shell",
    effect: "allow",
    resources: ["SRT-WRAPPED[make]"],
    source: { type: "tool", id: "call_2" },
  }
  await hooks.permission[0].fn(allowed)
  assert.equal(allowed.effect, "allow")
})

test("evaluate: a plain command with a stashed message gets the message; effect untouched", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, findCall } = makeWorld({
    stash: { message: "Sandbox unavailable (self-test failed) — approving runs the command unsandboxed (normal permissions)." },
  })
  await setup(ctx)

  const event = {
    action: "shell",
    effect: "ask",
    resources: ["make"],
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
  }
  await hooks.permission[0].fn(event)
  assert.equal(event.effect, "ask") // never flips a plain command
  assert.equal(
    event.message,
    "Sandbox unavailable (self-test failed) — approving runs the command unsandboxed (normal permissions).",
  )
  assert.deepEqual(findCall("messageFor").args, ["call_1"]) // the call id from event.source.id
})

test("evaluate: a plain command with no stash is untouched", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup } = makeWorld()
  await setup(ctx)

  const event = {
    action: "shell",
    effect: "ask",
    resources: ["make"],
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
  }
  await hooks.permission[0].fn(event)
  assert.equal(event.effect, "ask")
  assert.equal(event.message, undefined)
})

test("evaluate: a non-tool source never flips and never consults the stash — even for a wrapped resource", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, names } = makeWorld({ wrapped: ["SRT-WRAPPED[make]"], stash: { message: "M" } })
  await setup(ctx)

  const userSource = {
    action: "shell",
    effect: "ask",
    resources: ["SRT-WRAPPED[make]"],
    source: { type: "user", id: "call_1" },
  }
  await hooks.permission[0].fn(userSource)
  assert.equal(userSource.effect, "ask")
  assert.equal(userSource.message, undefined)

  const noSource = { action: "shell", effect: "ask", resources: ["SRT-WRAPPED[make]"] }
  await hooks.permission[0].fn(noSource) // must not throw
  assert.equal(noSource.effect, "ask")

  assert.ok(!names().includes("messageFor"))
  assert.ok(!names().includes("isWrapped"))
})

test("evaluate: throwing fakes never reject, leave the event untouched, and later calls still work", async () => {
  const { ctx, hooks } = makeCtx({})
  const world = makeWorld({ isWrappedThrows: true, wrapped: ["SRT-WRAPPED[make]"] })
  await world.setup(ctx)

  const event = {
    action: "shell",
    effect: "ask",
    resources: ["SRT-WRAPPED[make]"],
    source: { type: "tool", id: "call_1" },
  }
  await hooks.permission[0].fn(event) // must not reject
  assert.equal(event.effect, "ask")
  assert.ok(world.logs.some((m) => m.includes("isWrapped blew up")))

  // A throwing messageFor is swallowed the same way.
  world.after.isWrapped = (r) => world.wrappedSet.has(r)
  world.gate.messageFor = () => {
    throw new Error("messageFor blew up")
  }
  const plain = {
    action: "shell",
    effect: "ask",
    resources: ["make"],
    source: { type: "tool", id: "call_2" },
  }
  await hooks.permission[0].fn(plain)
  assert.equal(plain.effect, "ask")
  assert.equal(plain.message, undefined)
  assert.ok(world.logs.some((m) => m.includes("messageFor blew up")))

  // And a healthy gate/after still flip + message afterwards.
  world.gate.messageFor = () => ({ message: "M" })
  const plain2 = {
    action: "shell",
    effect: "ask",
    resources: ["make"],
    source: { type: "tool", id: "call_3" },
  }
  await hooks.permission[0].fn(plain2)
  assert.equal(plain2.message, "M")
  const wrappedEvent = {
    action: "shell",
    effect: "ask",
    resources: ["SRT-WRAPPED[make]"],
    source: { type: "tool", id: "call_4" },
  }
  await hooks.permission[0].fn(wrappedEvent)
  assert.equal(wrappedEvent.effect, "allow")
})

test("execute.after: noteGranted(event.id) runs BEFORE handleAfter; the annotation lands on the result", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, hookNames, findCall } = makeWorld()
  await setup(ctx)

  const event = {
    tool: "bash",
    id: "call_1",
    input: { command: "SRT-WRAPPED[make]" },
    status: "completed",
    result: { content: "ok" },
  }
  await hooks.tool[1].fn(event)
  assert.deepEqual(hookNames(), ["noteGranted", "handleAfter"])
  assert.deepEqual(findCall("noteGranted").args, ["call_1"])
  assert.equal(findCall("handleAfter").args[0], event) // the same object
  assert.deepEqual(event.result.metadata, { sandbox: { mode: "sandbox" } }) // the fake's annotation landed
})

test("execute.after: noteGranted is gated on the shell tool — only a completed SHELL call proves the consent grant (M-1)", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, hookNames, findCall } = makeWorld()
  await setup(ctx)

  // A completed NON-shell tool call (a `read`, say) carrying the call id of
  // an outstanding install consent proves nothing about that ask: the
  // shell command never ran (the scanner can reduce a command — e.g. a
  // comment-only one — to zero commands, so no shell ask is ever shown
  // and yet a later completed event could reach here).
  const nonShell = {
    tool: "read",
    id: "call_1",
    input: { path: "/repo/x" },
    status: "completed",
    result: {},
  }
  await hooks.tool[1].fn(nonShell)
  assert.ok(!hookNames().includes("noteGranted"))
  assert.ok(hookNames().includes("handleAfter")) // still forwarded; violations.js no-ops on it

  // The shell call does prove it.
  const shell = { tool: "bash", id: "call_1", input: { command: "make" }, status: "completed", result: {} }
  await hooks.tool[1].fn(shell)
  assert.deepEqual(findCall("noteGranted").args, ["call_1"])

  // And a non-completed shell call still proves nothing.
  assert.deepEqual(hookNames(), ["handleAfter", "noteGranted", "handleAfter"])
})

test("execute.after: a non-completed status never consults noteGranted (a rejection proves no grant); handleAfter still runs", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, hookNames } = makeWorld()
  await setup(ctx)

  // A rejected ask fires execute.after with status "error" (the command
  // never spawned); noteGranted must not see it.
  const rejected = {
    tool: "bash",
    id: "call_1",
    input: { command: "make" },
    status: "error",
    error: new Error("Unable to execute command: permission rejected"),
  }
  await hooks.tool[1].fn(rejected)
  assert.deepEqual(hookNames(), ["handleAfter"]) // no noteGranted

  // An unknown status: same — only "completed" proves execution.
  await hooks.tool[1].fn({ tool: "bash", id: "call_2", input: { command: "make" }, status: "aborted" })
  assert.deepEqual(hookNames(), ["handleAfter", "handleAfter"])
})

test("execute.after: a throwing after handler (or noteGranted) never rejects", async () => {
  const { ctx, hooks } = makeCtx({})
  const { setup, logs, hookNames } = makeWorld({ afterThrows: true, noteGrantedThrows: true })
  await setup(ctx)

  const event = { tool: "bash", id: "call_1", input: { command: "make" }, status: "completed", result: {} }
  await hooks.tool[1].fn(event) // must not reject
  // noteGranted's throw must not keep handleAfter from running.
  assert.deepEqual(hookNames(), ["noteGranted", "handleAfter"])
  assert.ok(logs.some((m) => m.includes("noteGranted blew up")))
  assert.ok(logs.some((m) => m.includes("after blew up")))
})

/**
 * A world wired with the REAL gate (policy.js) over a fake runtime whose
 * package is missing (`install: "ask"` is the resolved default), for the
 * consent-flow integration tests. ctx.agent/session feed loadRules the
 * probe-verified shapes: agent rules under `.data.permissions` predicting
 * ASK for every command, session permissions absent. Returns the captured
 * real gate (for `declined()`) and the install call log.
 */
function makeConsentWorld(over = {}) {
  const installCalls = []
  const captured = {}
  const runtime = {
    availability: async () => over.availability ?? { ok: false, reason: "not-installed" },
    install: async () => {
      installCalls.push(1)
      return { ok: true }
    },
    load: async () => undefined,
    store: () => undefined,
    reset: async () => {},
    declined: () => false,
    markDeclined: () => {
      captured.runtimeDeclined = true
    },
    sandboxMode: () => undefined,
  }
  const { ctx, hooks } = makeCtx({})
  ctx.agent = {
    get: async () => ({
      location: "config",
      data: { permissions: [{ action: "*", resource: "*", effect: "ask" }] },
    }),
  }
  ctx.session = { get: async () => ({}) } // permissions absent
  const setup = createSetup({
    createRuntime: () => runtime,
    createGate: (deps) => {
      captured.gate = createGate(deps) // the REAL gate
      return captured.gate
    },
    createClassifier: () => ({ classify: async () => ({ verdict: "SAFE" }) }),
    createAfterHandler: () => ({
      begin: () => {},
      isWrapped: () => false,
      handleAfter: async () => {},
    }),
    randomId: () => "test-command-id",
    log: () => {},
  })
  return { setup, ctx, hooks, installCalls, captured }
}

test("consent flow through the REAL gate: a pending consent + execute.after for that call id → install fired exactly once", async () => {
  const { setup, ctx, hooks, installCalls } = makeConsentWorld()
  await setup(ctx)

  // 1. execute.before: decide reaches the installable case → skip with the
  //    consent stashed for this call id; the input stays untouched (the
  //    command runs with normal permissions if the ask is approved).
  const before = beforeEvent("make", { agent: "build-consent-it" })
  await hooks.tool[0].fn(before)
  assert.equal(before.input.command, "make")
  assert.equal(installCalls.length, 0) // no install before a grant

  // 2. evaluate: not a wrapped string → the stashed consent message is
  //    surfaced on the ask; the effect is never flipped.
  const evaluate = {
    action: "shell",
    effect: "ask",
    resources: ["make"],
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
  }
  await hooks.permission[0].fn(evaluate)
  assert.equal(evaluate.effect, "ask")
  assert.ok(evaluate.message.includes("Sandbox runtime not installed"))
  assert.ok(evaluate.message.includes("subsequent commands run sandboxed"))

  // 3. The command executed TO COMPLETION (approval proven) → noteGranted
  //    fires the consented install in the background, exactly once.
  const after = {
    tool: "bash",
    id: "call_1",
    input: { command: "make" },
    status: "completed",
    result: { content: "ok" },
  }
  await hooks.tool[1].fn(after)
  await new Promise((r) => setImmediate(r)) // let the fire-and-forget install land
  assert.equal(installCalls.length, 1)

  // A second execute.after for the same call id (or any other) fires no
  // further install — the consent was cleared.
  await hooks.tool[1].fn(after)
  await new Promise((r) => setImmediate(r))
  assert.equal(installCalls.length, 1)
})

test("consent flow (real gate): a REJECTED execution fires no install — the surviving consent infers decline on the next decide", async () => {
  const { setup, ctx, hooks, installCalls, captured } = makeConsentWorld()
  await setup(ctx)

  // 1. execute.before: the installable case stashes the consent for
  //    call_1; the input stays untouched.
  const before = beforeEvent("make", { agent: "build-consent-reject" })
  await hooks.tool[0].fn(before)
  assert.equal(before.input.command, "make")
  assert.equal(installCalls.length, 0)

  // 2. The ask is REJECTED: execute.after fires with status "error" — the
  //    command never spawned (the headless auto-reject and the interactive
  //    deny both surface exactly this way; Task 1's probe archive). An
  //    errored call proves NO grant: no install, and the consent survives.
  await hooks.tool[1].fn({
    tool: "bash",
    id: "call_1",
    input: { command: "make" },
    status: "error",
    error: new Error("Unable to execute command: permission rejected"),
  })
  await new Promise((r) => setImmediate(r))
  assert.equal(installCalls.length, 0) // no unconsented install
  assert.equal(captured.gate.declined(), false) // the consent survived

  // 3. The next decide observes the outstanding consent → decline inferred
  //    (markInstallDeclined, mirrored into the runtime), silent skip: the
  //    input stays untouched and the gate goes inert.
  const retry = beforeEvent("make", { id: "call_2", agent: "build-consent-reject" })
  await hooks.tool[0].fn(retry)
  assert.equal(retry.input.command, "make")
  assert.equal(captured.gate.declined(), true)
  assert.equal(captured.runtimeDeclined, true)
  assert.equal(installCalls.length, 0)

  // 4. Inert from here on (declined is one-way): no wrap, no message, no
  //    install, whatever later calls do.
  const later = beforeEvent("make", { id: "call_3", agent: "build-consent-reject" })
  await hooks.tool[0].fn(later)
  assert.equal(later.input.command, "make")
  assert.equal(installCalls.length, 0)
})

test("cleanup calls runtime.reset(); a reset failure is swallowed", async () => {
  const { ctx } = makeCtx({})
  const { setup, names } = makeWorld()
  const cleanup = await setup(ctx)
  await cleanup()
  assert.deepEqual(names(), [
    "createRuntime",
    "createClassifier",
    "createGate",
    "createAfterHandler",
    "reset",
  ])

  const world2 = makeWorld({ resetThrows: true })
  const { ctx: ctx2 } = makeCtx({})
  const cleanup2 = await world2.setup(ctx2)
  await cleanup2() // must not reject
  assert.ok(world2.names().includes("reset"))
  assert.ok(world2.logs.some((m) => m.includes("reset blew up")))
})

test("default-wired setup (no overrides) is production-real: registers the three hooks, no shell hook", async () => {
  const { ctx, hooks } = makeCtx({})
  const cleanup = await createSetup()(ctx)
  assert.deepEqual(
    hooks.tool.map((h) => h.name),
    ["execute.before", "execute.after"],
  )
  assert.deepEqual(
    hooks.permission.map((h) => h.name),
    ["evaluate"],
  )
  assert.equal(hooks.shell.length, 0)
  assert.equal(typeof cleanup, "function")
  // Cleanup is deliberately NOT invoked here: the real runtime.reset()
  // would import the real package — runtime.test.js owns that path.
})
