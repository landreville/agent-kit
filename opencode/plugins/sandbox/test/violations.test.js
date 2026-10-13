import { test } from "node:test"
import assert from "node:assert/strict"
import { createAfterHandler, isShellTool, SANDBOX_DENIAL_MARKERS } from "../violations.js"

// The after handler never touches the sandbox package, a model, or the
// filesystem: the violation store and the gate are injected fakes that
// record their calls, and the events are hand-built to the verified
// published `execute.after` shapes — { tool, sessionID, agent, messageID,
// id, input: { command } } & ({ status: "completed", result } |
// { status: "error", error }). In v2 the wrap happens at
// `tool.execute.before`, so the EXECUTED input — and therefore
// `input.command` at after-time — is the WRAPPED string; `begin` indexes
// the pending entry under BOTH the original command text and the wrapped
// string, `handleAfter` looks up by whichever arrives (with a wrapped-field
// scan as fallback), the gate failure record always keys on the ORIGINAL
// text, and `isWrapped` exact-matches the wrapped-string index for the
// evaluate hook. The older tests below drive events by the original text
// (the original key is a first-class lookup path); the v2 block at the
// bottom drives them by the wrapped string.

const CWD = "/workspace/proj"

/** The note appended to completed results, built from the pending cwd. */
const NOTE = `(ran in sandbox: writes limited to ${CWD}; network denied except configured domains)`

/** A handler over fakes: a store answering configured violation lists per
 * commandId, a gate recording every recordSandboxFailure call, and
 * captured logs. `storeFn` / `gate` override the defaults for the
 * broken-dependency cases. */
function makeHandler(over = {}) {
  const violationsById = over.violationsById ?? new Map()
  const recorded = []
  const logs = []
  const storeFn =
    over.storeFn ??
    (() => ({
      getViolationsForCommand: (id) => violationsById.get(id) ?? [],
    }))
  const gate =
    over.gate ??
    {
      recordSandboxFailure(command, evidence) {
        if (over.gateThrows) throw new Error("gate blew up")
        recorded.push({ command, evidence })
      },
    }
  const handler = createAfterHandler({ store: storeFn, gate, log: (m) => logs.push(m) })
  return { handler, recorded, logs }
}

/** A completed `execute.after` event for the bash tool. */
function completedEvent(command, over = {}) {
  return {
    tool: "bash",
    sessionID: "s1",
    id: "call_1",
    input: { command },
    status: "completed",
    result: { content: "done" },
    ...over,
  }
}

/** An errored `execute.after` event for the bash tool. */
function errorEvent(command, message, over = {}) {
  return {
    tool: "bash",
    sessionID: "s1",
    id: "call_1",
    input: { command },
    status: "error",
    error: new Error(message),
    ...over,
  }
}

test("isShellTool: exactly the bash and shell tool names", () => {
  assert.equal(isShellTool("bash"), true)
  assert.equal(isShellTool("shell"), true)
  assert.equal(isShellTool("read"), false)
  assert.equal(isShellTool("edit"), false)
  assert.equal(isShellTool("bash.exec"), false)
  assert.equal(isShellTool(""), false)
  assert.equal(isShellTool(undefined), false)
})

test("SANDBOX_DENIAL_MARKERS: the exact marker list", () => {
  assert.deepEqual([...SANDBOX_DENIAL_MARKERS], [
    "Read-only file system",
    "Operation not permitted",
    "Connection blocked by network allowlist",
    "blocked by sandbox-runtime",
    "connection not allowed by ruleset",
    "Could not resolve host",
  ])
})

test("non-shell tool events never touch pending state or annotate (Review Focus 4)", async () => {
  const { handler, recorded } = makeHandler()
  handler.begin("make", { commandId: "cid-make", cwd: CWD })
  const read = {
    tool: "read",
    input: { command: "make", path: "/workspace/proj/README.md" },
    status: "completed",
    result: { content: "file body" },
  }
  await handler.handleAfter(read)
  assert.equal(recorded.length, 0)
  assert.equal(read.result.metadata, undefined)
  assert.equal(read.result.content, "file body")
  // The pending entry survived the interleaved read execution: the shell
  // tool's own completion still annotates.
  const event = completedEvent("make")
  await handler.handleAfter(event)
  assert.deepEqual(event.result.metadata.sandbox, {
    mode: "sandbox",
    cwd: CWD,
    commandId: "cid-make",
  })
  assert.ok(event.result.content.endsWith(NOTE))
})

test("no pending entry is a no-op: nothing recorded, nothing annotated, other entries not consumed", async () => {
  const { handler, recorded } = makeHandler()
  // Completed with a denial marker in the content but no pending entry:
  // attribution is gated by the pending entry, not by the marker alone.
  const done = completedEvent("make", {
    result: { content: "rm: cannot remove '/x': Read-only file system" },
  })
  await handler.handleAfter(done)
  assert.equal(recorded.length, 0)
  assert.equal(done.result.metadata, undefined)
  assert.equal(done.result.content, "rm: cannot remove '/x': Read-only file system")
  // Errored with a marker in the message, still no pending entry.
  const failed = errorEvent("make", "make: *** [all] Error 1")
  await handler.handleAfter(failed)
  assert.equal(recorded.length, 0)
  assert.equal(failed.error.message, "make: *** [all] Error 1")
  assert.equal(failed.error.metadata, undefined)
  // A pending entry for a DIFFERENT command is not consumed by this one.
  handler.begin("go build", { commandId: "cid-go", cwd: CWD })
  const other = completedEvent("make")
  await handler.handleAfter(other)
  assert.equal(other.result.metadata, undefined)
  const own = completedEvent("go build")
  await handler.handleAfter(own)
  assert.notEqual(own.result.metadata, undefined)
})

test("completed: metadata.sandbox set and the note appended to string content", async () => {
  const { handler, recorded } = makeHandler()
  handler.begin("make", { commandId: "cid", cwd: CWD })
  const event = completedEvent("make", { result: { content: "built" } })
  await handler.handleAfter(event)
  assert.equal(recorded.length, 0)
  assert.deepEqual(event.result.metadata.sandbox, {
    mode: "sandbox",
    cwd: CWD,
    commandId: "cid",
  })
  assert.equal(event.result.content, `built\n${NOTE}`)
  // Pre-existing metadata is preserved, not replaced.
  handler.begin("make test", { commandId: "cid", cwd: CWD })
  const meta = completedEvent("make test", {
    result: { content: "ok", metadata: { exitCode: 0 } },
  })
  await handler.handleAfter(meta)
  assert.equal(meta.result.metadata.exitCode, 0)
  assert.deepEqual(meta.result.metadata.sandbox, { mode: "sandbox", cwd: CWD, commandId: "cid" })
  // Empty content gets the note without a leading blank line.
  handler.begin("true", { commandId: "cid", cwd: CWD })
  const empty = completedEvent("true", { result: { content: "" } })
  await handler.handleAfter(empty)
  assert.equal(empty.result.content, NOTE)
})

test("completed: a text-part content array gets the note as a new part", async () => {
  const { handler, recorded } = makeHandler()
  handler.begin("make", { commandId: "cid", cwd: CWD })
  const parts = [
    { type: "text", text: "line 1" },
    { type: "file", path: "/tmp/opencode/out.log" },
  ]
  const event = completedEvent("make", { result: { content: [...parts] } })
  await handler.handleAfter(event)
  assert.equal(recorded.length, 0)
  assert.equal(event.result.content.length, 3)
  assert.deepEqual(event.result.content[0], parts[0])
  assert.deepEqual(event.result.content[1], parts[1])
  assert.deepEqual(event.result.content[2], { type: "text", text: NOTE })
  assert.deepEqual(event.result.metadata.sandbox, { mode: "sandbox", cwd: CWD, commandId: "cid" })
})

test("error with attributed violations: recorded with the violation list, error annotated", async () => {
  const violations = [{ type: "network", domain: "denied.example", port: 443 }]
  const { handler, recorded } = makeHandler({
    violationsById: new Map([["cid", violations]]),
  })
  handler.begin("curl https://denied.example", { commandId: "cid", cwd: CWD })
  const event = errorEvent(
    "curl https://denied.example",
    "curl: (7) Failed to connect to denied.example port 443",
  )
  await handler.handleAfter(event)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].command, "curl https://denied.example")
  assert.deepEqual(recorded[0].evidence, violations)
  assert.ok(event.error.message.startsWith("[sandbox] "))
  assert.ok(event.error.message.includes("1 sandbox violation"))
  assert.ok(event.error.message.includes("retrying asks to run unsandboxed"))
  assert.ok(event.error.message.includes("curl: (7) Failed to connect"))
  assert.equal(event.error.metadata.sandbox.blocked, true)
  assert.deepEqual(event.error.metadata.sandbox.evidence, violations)
  assert.equal(event.error.metadata.sandbox.cwd, CWD)
  assert.equal(event.error.metadata.sandbox.commandId, "cid")
})

test("error without violations but a marker in the message: recorded with the marker as evidence (degraded mode)", async () => {
  const { handler, recorded } = makeHandler()
  handler.begin("echo hi && touch /etc/hosts", { commandId: "cid", cwd: CWD })
  const event = errorEvent(
    "echo hi && touch /etc/hosts",
    "touch: cannot touch '/etc/hosts': Read-only file system",
  )
  await handler.handleAfter(event)
  assert.equal(recorded.length, 1)
  // The FULL compound text is passed; the gate fans it out to its own
  // segment keys.
  assert.equal(recorded[0].command, "echo hi && touch /etc/hosts")
  assert.deepEqual(recorded[0].evidence, ["Read-only file system"])
  assert.ok(event.error.message.startsWith("[sandbox] "))
  assert.ok(event.error.message.includes("denial markers: Read-only file system"))
  assert.ok(event.error.message.includes("touch: cannot touch '/etc/hosts'"))
  assert.deepEqual(event.error.metadata.sandbox.evidence, ["Read-only file system"])
})

test("error with neither violations nor a marker: not recorded, event untouched", async () => {
  const { handler, recorded } = makeHandler()
  handler.begin("make", { commandId: "cid", cwd: CWD })
  const event = errorEvent("make", "make: *** [all] Error 1")
  await handler.handleAfter(event)
  assert.equal(recorded.length, 0)
  assert.equal(event.error.message, "make: *** [all] Error 1")
  assert.equal(event.error.metadata, undefined)
})

test("completed with a marker in the content: recorded with the marker evidence, annotated as blocked", async () => {
  const { handler, recorded } = makeHandler()
  handler.begin("rm /etc/hosts", { commandId: "cid", cwd: CWD })
  const event = completedEvent("rm /etc/hosts", {
    result: { content: "rm: cannot remove '/etc/hosts': Operation not permitted" },
  })
  await handler.handleAfter(event)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].command, "rm /etc/hosts")
  assert.deepEqual(recorded[0].evidence, ["Operation not permitted"])
  assert.equal(event.result.metadata.sandbox.blocked, true)
  assert.deepEqual(event.result.metadata.sandbox.evidence, ["Operation not permitted"])
  assert.equal(event.result.content, `rm: cannot remove '/etc/hosts': Operation not permitted\n${NOTE}`)
})

test("completed with violations but no marker: annotated, NOT recorded (a succeeded run must not unsandbox its retry)", async () => {
  const { handler, recorded } = makeHandler({
    violationsById: new Map([["cid", [{ type: "network", domain: "denied.example" }]]]),
  })
  handler.begin("curl -s https://denied.example || echo offline", { commandId: "cid", cwd: CWD })
  const event = completedEvent("curl -s https://denied.example || echo offline", {
    result: { content: "offline" },
  })
  await handler.handleAfter(event)
  assert.equal(recorded.length, 0)
  assert.deepEqual(event.result.metadata.sandbox, { mode: "sandbox", cwd: CWD, commandId: "cid" })
  assert.equal(event.result.content, `offline\n${NOTE}`)
})

test("completed with a marker in text-part content: recorded and scanned across parts", async () => {
  const { handler, recorded } = makeHandler()
  handler.begin("make", { commandId: "cid", cwd: CWD })
  const event = completedEvent("make", {
    result: {
      content: [
        { type: "text", text: "rm: cannot remove '/etc/hosts': Read-only file system" },
        { type: "file", path: "/tmp/opencode/log" },
      ],
    },
  })
  await handler.handleAfter(event)
  assert.equal(recorded.length, 1)
  assert.deepEqual(recorded[0].evidence, ["Read-only file system"])
  assert.equal(event.result.metadata.sandbox.blocked, true)
  assert.equal(event.result.content.length, 3)
  assert.deepEqual(event.result.content[2], { type: "text", text: NOTE })
})

test("missing result/error fields never throw", async () => {
  const violations = [{ type: "network", domain: "denied.example" }]
  const { handler, recorded } = makeHandler({
    violationsById: new Map([["cid", violations]]),
  })
  // Completed without a result: nothing to annotate or scan.
  handler.begin("make", { commandId: "cid", cwd: CWD })
  await handler.handleAfter(completedEvent("make", { result: undefined }))
  await handler.handleAfter(completedEvent("make", { result: null }))
  assert.equal(recorded.length, 0)
  // Errored without an error object: attribution alone still records; the
  // annotation is simply skipped.
  handler.begin("curl https://denied.example", { commandId: "cid", cwd: CWD })
  await handler.handleAfter(errorEvent("curl https://denied.example", "", { error: undefined }))
  assert.equal(recorded.length, 1)
  assert.deepEqual(recorded[0].evidence, violations)
  // Errored without an error object and without violations: untouched.
  handler.begin("make", { commandId: "cid2", cwd: CWD })
  await handler.handleAfter(errorEvent("make", "", { error: undefined }))
  assert.equal(recorded.length, 1)
})

test("frozen error/result objects: mutation failures swallowed, the records still happen", async () => {
  const { handler, recorded } = makeHandler()
  handler.begin("rm /x", { commandId: "cid", cwd: CWD })
  const frozenError = Object.freeze(
    new Error("rm: cannot remove '/x': Read-only file system"),
  )
  const event = errorEvent("rm /x", "", { error: frozenError })
  await handler.handleAfter(event)
  assert.equal(recorded.length, 1)
  assert.deepEqual(recorded[0].evidence, ["Read-only file system"])
  assert.equal(frozenError.message, "rm: cannot remove '/x': Read-only file system")

  handler.begin("rm /y", { commandId: "cid2", cwd: CWD })
  const frozenResult = Object.freeze({
    content: "rm: cannot remove '/y': Operation not permitted",
  })
  const completed = completedEvent("rm /y", { result: frozenResult })
  await handler.handleAfter(completed)
  assert.equal(recorded.length, 2)
  assert.equal(recorded[1].command, "rm /y")
  assert.deepEqual(recorded[1].evidence, ["Operation not permitted"])
  assert.equal(frozenResult.content, "rm: cannot remove '/y': Operation not permitted")
  assert.equal(frozenResult.metadata, undefined)
})

test("the pending entry is deleted on every terminal path", async () => {
  const { handler, recorded } = makeHandler()
  // Completed path.
  handler.begin("make", { commandId: "cid", cwd: CWD })
  await handler.handleAfter(completedEvent("make"))
  const doneAgain = completedEvent("make")
  await handler.handleAfter(doneAgain)
  assert.equal(doneAgain.result.metadata, undefined)
  assert.equal(doneAgain.result.content, "done")
  // Errored, not sandbox-caused.
  handler.begin("go build", { commandId: "cid", cwd: CWD })
  await handler.handleAfter(errorEvent("go build", "no Go files in directory"))
  const failedAgain = errorEvent("go build", "no Go files in directory")
  await handler.handleAfter(failedAgain)
  assert.equal(failedAgain.error.metadata, undefined)
  // Errored, sandbox-caused: recorded exactly once.
  handler.begin("touch /x", { commandId: "cid", cwd: CWD })
  await handler.handleAfter(errorEvent("touch /x", "touch: cannot touch '/x': Read-only file system"))
  await handler.handleAfter(errorEvent("touch /x", "touch: cannot touch '/x': Read-only file system"))
  assert.equal(recorded.length, 1)
  // Unknown status: nothing observed, entry still consumed.
  handler.begin("make -j4", { commandId: "cid", cwd: CWD })
  await handler.handleAfter({ tool: "bash", input: { command: "make -j4" }, status: "aborted" })
  const after = completedEvent("make -j4")
  await handler.handleAfter(after)
  assert.equal(after.result.metadata, undefined)
  assert.equal(recorded.length, 1)
})

test("unexpected input shape: return without doing anything (no throw, no annotation, no consume)", async () => {
  const { handler, recorded } = makeHandler()
  handler.begin("make", { commandId: "cid", cwd: CWD })
  await handler.handleAfter({
    tool: "bash",
    status: "completed",
    input: { cmd: "make" },
    result: { content: "x" },
  })
  await handler.handleAfter({
    tool: "bash",
    status: "completed",
    input: "make",
    result: { content: "x" },
  })
  await handler.handleAfter({ tool: "bash", status: "completed", result: { content: "x" } })
  await handler.handleAfter({
    tool: "bash",
    status: "error",
    input: { command: 42 },
    error: new Error("boom"),
  })
  assert.equal(recorded.length, 0)
  // The pending entry survived the malformed events: the well-shaped
  // completion still annotates.
  const event = completedEvent("make")
  await handler.handleAfter(event)
  assert.deepEqual(event.result.metadata.sandbox, {
    mode: "sandbox",
    cwd: CWD,
    commandId: "cid",
  })
})

test("failure text is duck-typed: error.metadata.output/stderr are scanned and preserved", async () => {
  const { handler, recorded } = makeHandler()
  handler.begin("cargo build", { commandId: "cid", cwd: CWD })
  const err = new Error("cargo build exited with code 1")
  err.metadata = {
    output: "touch: cannot touch '/x': Operation not permitted",
    stderr: "compilation terminated",
  }
  const event = errorEvent("cargo build", "", { error: err })
  await handler.handleAfter(event)
  assert.equal(recorded.length, 1)
  assert.deepEqual(recorded[0].evidence, ["Operation not permitted"])
  assert.ok(err.message.startsWith("[sandbox] "))
  // The pre-existing metadata keys survive the annotation.
  assert.equal(err.metadata.output, "touch: cannot touch '/x': Operation not permitted")
  assert.equal(err.metadata.stderr, "compilation terminated")
  assert.deepEqual(err.metadata.sandbox.evidence, ["Operation not permitted"])
})

test("a throwing or absent store and a throwing or absent gate never break the handler", async () => {
  // A store that throws when called: violations read as empty; the marker
  // path still records.
  const storeCallThrows = makeHandler({
    storeFn: () => {
      throw new Error("store blew up")
    },
  })
  storeCallThrows.handler.begin("rm /x", { commandId: "cid", cwd: CWD })
  await storeCallThrows.handler.handleAfter(
    errorEvent("rm /x", "rm: cannot remove '/x': Read-only file system"),
  )
  assert.equal(storeCallThrows.recorded.length, 1)
  // A store whose lookup throws: same.
  const lookupThrows = makeHandler({
    storeFn: () => ({
      getViolationsForCommand() {
        throw new Error("lookup blew up")
      },
    }),
  })
  lookupThrows.handler.begin("rm /x", { commandId: "cid", cwd: CWD })
  await lookupThrows.handler.handleAfter(
    errorEvent("rm /x", "rm: cannot remove '/x': Read-only file system"),
  )
  assert.equal(lookupThrows.recorded.length, 1)
  // No store at all: same.
  const noStore = makeHandler({ storeFn: () => undefined })
  noStore.handler.begin("rm /x", { commandId: "cid", cwd: CWD })
  await noStore.handler.handleAfter(
    errorEvent("rm /x", "rm: cannot remove '/x': Read-only file system"),
  )
  assert.equal(noStore.recorded.length, 1)
  // A store without getViolationsForCommand: same.
  const bareStore = makeHandler({ storeFn: () => ({}) })
  bareStore.handler.begin("rm /x", { commandId: "cid", cwd: CWD })
  await bareStore.handler.handleAfter(
    errorEvent("rm /x", "rm: cannot remove '/x': Read-only file system"),
  )
  assert.equal(bareStore.recorded.length, 1)
  // A gate that throws: swallowed and logged, annotation still attempted.
  const gateThrows = makeHandler({ gateThrows: true })
  gateThrows.handler.begin("rm /x", { commandId: "cid", cwd: CWD })
  const event = errorEvent("rm /x", "rm: cannot remove '/x': Read-only file system")
  await gateThrows.handler.handleAfter(event)
  assert.equal(gateThrows.recorded.length, 0)
  assert.equal(gateThrows.logs.length, 1)
  assert.ok(event.error.message.startsWith("[sandbox] "))
  // A gate without recordSandboxFailure: logged, no throw, no record.
  const gateMissing = makeHandler({ gate: {} })
  gateMissing.handler.begin("rm /x", { commandId: "cid", cwd: CWD })
  const untouched = errorEvent("rm /x", "rm: cannot remove '/x': Read-only file system")
  await gateMissing.handler.handleAfter(untouched)
  assert.equal(gateMissing.recorded.length, 0)
  assert.ok(gateMissing.logs.length >= 1)
})

test("begin is defensive: malformed commands and entries never throw", async () => {
  const { handler, recorded } = makeHandler()
  handler.begin(undefined, { commandId: "cid", cwd: CWD })
  handler.begin("", { commandId: "cid", cwd: CWD })
  handler.begin("make", undefined)
  handler.begin("make", { commandId: 42, cwd: CWD })
  // The last malformed-entry begin won: per-field duck-typing keeps the
  // valid cwd and empties the non-string commandId; a completion for that
  // command annotates with those fields and records nothing (no id, no
  // marker).
  const event = completedEvent("make", { result: { content: "done" } })
  await handler.handleAfter(event)
  assert.equal(recorded.length, 0)
  assert.deepEqual(event.result.metadata.sandbox, {
    mode: "sandbox",
    cwd: CWD,
    commandId: "",
  })
})

// --- v2: the dual-key pending index and the wrapped-string identity -------

test("isWrapped: exact-match membership in the wrapped-string index", () => {
  const { handler } = makeHandler()
  assert.equal(handler.isWrapped("SRT-WRAPPED[make]"), false) // nothing registered
  handler.begin("make", { commandId: "cid", cwd: CWD, wrapped: "SRT-WRAPPED[make]" })
  assert.equal(handler.isWrapped("SRT-WRAPPED[make]"), true)
  // Exact match only: the original text, prefixes, and superstrings are NOT wrapped.
  assert.equal(handler.isWrapped("make"), false)
  assert.equal(handler.isWrapped("SRT-WRAPPED[make"), false)
  assert.equal(handler.isWrapped("SRT-WRAPPED[make] "), false)
  // Defensive: non-strings are never wrapped, never throw.
  assert.equal(handler.isWrapped(""), false)
  assert.equal(handler.isWrapped(undefined), false)
  assert.equal(handler.isWrapped(42), false)
  assert.equal(handler.isWrapped(null), false)
  // A begin without a wrapped string indexes nothing.
  handler.begin("go build", { commandId: "cid2", cwd: CWD })
  assert.equal(handler.isWrapped("go build"), false)
})

test("handleAfter by the WRAPPED string (the v2 after-time shape): failure recorded under the ORIGINAL key, error annotated", async () => {
  const violations = [{ type: "network", domain: "denied.example", port: 443 }]
  const { handler, recorded } = makeHandler({
    violationsById: new Map([["cid", violations]]),
  })
  handler.begin("curl https://denied.example", {
    commandId: "cid",
    cwd: CWD,
    wrapped: "SRT-WRAPPED[curl https://denied.example]",
  })
  // The executed input is the wrapped string, so the after event carries it.
  const event = errorEvent(
    "SRT-WRAPPED[curl https://denied.example]",
    "curl: (7) Failed to connect to denied.example port 443",
  )
  await handler.handleAfter(event)
  assert.equal(recorded.length, 1)
  // The gate record keys on the ORIGINAL command text — the wrapped string
  // must never become a failure-memory key.
  assert.equal(recorded[0].command, "curl https://denied.example")
  assert.deepEqual(recorded[0].evidence, violations)
  assert.ok(event.error.message.startsWith("[sandbox] "))
  assert.ok(event.error.message.includes("1 sandbox violation"))
  assert.equal(event.error.metadata.sandbox.blocked, true)
  assert.equal(event.error.metadata.sandbox.cwd, CWD)
  assert.equal(event.error.metadata.sandbox.commandId, "cid")
})

test("handleAfter by the wrapped string: completed runs annotate; BOTH keys are consumed", async () => {
  const { handler, recorded } = makeHandler()
  handler.begin("make", { commandId: "cid", cwd: CWD, wrapped: "SRT-WRAPPED[make]" })
  const event = completedEvent("SRT-WRAPPED[make]", { result: { content: "built" } })
  await handler.handleAfter(event)
  assert.equal(recorded.length, 0)
  assert.deepEqual(event.result.metadata.sandbox, {
    mode: "sandbox",
    cwd: CWD,
    commandId: "cid",
  })
  assert.equal(event.result.content, `built\n${NOTE}`)
  // The entry is consumed under BOTH keys: neither the wrapped string nor
  // the original text processes again, and isWrapped is cleared.
  assert.equal(handler.isWrapped("SRT-WRAPPED[make]"), false)
  const againWrapped = completedEvent("SRT-WRAPPED[make]")
  await handler.handleAfter(againWrapped)
  assert.equal(againWrapped.result.metadata, undefined)
  const againOriginal = completedEvent("make")
  await handler.handleAfter(againOriginal)
  assert.equal(againOriginal.result.metadata, undefined)
})

test("handleAfter falls back to scanning pending entries by their wrapped field when the direct key is gone", async () => {
  // Construct the only public-API state in which the direct lookup misses
  // but an entry's `wrapped` matches: another entry's ORIGINAL-text key
  // collides with the first entry's wrapped key, and the second entry is
  // consumed first (deleting the shared key). Essentially impossible in
  // production (wrapped strings embed a random commandId) — the scan is
  // belt-and-braces — but it must recover the attribution when reached.
  const { handler, recorded } = makeHandler()
  handler.begin("cmd one", { commandId: "c1", cwd: CWD, wrapped: "WRAP1" })
  handler.begin("WRAP1", { commandId: "c2", cwd: CWD, wrapped: "WRAP2" })
  // Consume the second entry via its own wrapped key; the deletion takes
  // the "WRAP1" map key (its original text) with it.
  await handler.handleAfter(completedEvent("WRAP2"))
  // Now "WRAP1" is not a map key, but entry c1 still carries it as `wrapped`.
  const event = errorEvent("WRAP1", "touch: cannot touch '/x': Read-only file system")
  await handler.handleAfter(event)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].command, "cmd one") // recorded under the ORIGINAL key
  assert.deepEqual(recorded[0].evidence, ["Read-only file system"])
  assert.ok(event.error.message.startsWith("[sandbox] "))
  // The recovered entry is fully consumed.
  assert.equal(handler.isWrapped("WRAP1"), false)
  const again = completedEvent("cmd one")
  await handler.handleAfter(again)
  assert.equal(again.result.metadata, undefined)
})

test("the wrapped-string index survives an interleaved non-shell event; overwrite keeps latest-wins per key", async () => {
  const { handler, recorded } = makeHandler()
  handler.begin("make", { commandId: "c1", cwd: CWD, wrapped: "W1" })
  // An interleaved read execution must not consume the entry (Review Focus 4).
  await handler.handleAfter({
    tool: "read",
    input: { command: "W1", path: "/workspace/proj/README.md" },
    status: "completed",
    result: { content: "file body" },
  })
  assert.equal(handler.isWrapped("W1"), true)
  // Same original re-wrapped (a retry): latest wins on the original key.
  handler.begin("make", { commandId: "c2", cwd: CWD, wrapped: "W2" })
  assert.equal(handler.isWrapped("W2"), true)
  const event = completedEvent("W2")
  await handler.handleAfter(event)
  assert.deepEqual(event.result.metadata.sandbox, {
    mode: "sandbox",
    cwd: CWD,
    commandId: "c2",
  })
  assert.equal(handler.isWrapped("W2"), false)
  assert.equal(recorded.length, 0)
})
