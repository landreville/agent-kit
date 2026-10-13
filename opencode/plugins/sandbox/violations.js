/**
 * Post-execution attribution and annotation for the OpenCode `sandbox`
 * plugin — the `tool.hook("execute.after")` body. The execute.before
 * wiring calls `begin(command, { commandId, cwd, wrapped })` when it
 * wraps a command; when the bash/shell tool call finishes,
 * `handleAfter(event)` decides whether a failure was SANDBOX-CAUSED — the
 * unsandboxed-retry escape hatch — and annotates the result so the model
 * sees what actually happened. `isWrapped(resource)` exact-matches the
 * wrapped-string index for the `permission.evaluate` hook.
 *
 * SANDBOX-CAUSED DETECTION (spec §Escape hatch + Risk 8): a failed run
 * AND (violations attributed to the pending `commandId` non-empty OR the
 * failure text matching SANDBOX_DENIAL_MARKERS). On this platform the two
 * signals are complementary (Task 1's probe finding): network denies
 * (proxy) and Unix-socket denies (seccomp) ARE attributed by the
 * violation store, while filesystem denials surface only as kernel
 * errnos ("Read-only file system", "Operation not permitted") that no
 * observer reports — hence the marker fallback. A denied read hiding a
 * path as "No such file or directory" is deliberately NOT a marker
 * (indistinguishable from a genuine missing path). "Could not resolve
 * host" is a weak marker kept because the sandbox's default deny-all DNS
 * makes it sandbox-indicative there; a false positive costs one extra
 * prompt (the safe direction — a false negative burns sandbox attempts
 * and re-fails).
 *
 * STATUS MAPPING (the verified published `execute.after` event shapes):
 *  - `status: "error"` — the tool call failed. Failure text is
 *    duck-typed, in order: `event.error.message`, string
 *    `event.error.metadata.output` / `.stderr` when present, and —
 *    defensively, if an errored event still carries one —
 *    `event.result.content`. Scan what exists; never assume a field.
 *    Attributed violations OR a marker → sandbox-caused → recorded +
 *    best-effort error annotation.
 *  - `status: "completed"` — the run's output is `result.content`. A
 *    marker IN the content is the failure signal (a hard denial surfaced
 *    in the run's own output; the verified shape carries no exit code)
 *    → sandbox-caused → recorded + annotated as blocked. Violations
 *    WITHOUT a marker are treated as non-fatal denials on a SUCCEEDED
 *    run — the spec's "violations with exit 0 → annotate lightly, do not
 *    record": recording a succeeded run would unsandbox its retry, which
 *    could then read deny-read secrets. Annotate only.
 *
 * Both statuses record through the gate's `recordSandboxFailure` with the
 * FULL command text (the gate fans it out to every `commandKeys` segment
 * itself) and the evidence — the attributed violation list (a copy) when
 * present, else the matched markers.
 *
 * ANNOTATION (best-effort, always inside try/catch — a frozen result or
 * error object must never break the bookkeeping; the failure-memory
 * record happens BEFORE the annotation, so even a mutation failure
 * leaves the retry asking):
 *  - completed → `result.metadata.sandbox = { mode: "sandbox", cwd,
 *    commandId }` (plus `blocked: true, evidence` when a marker fired)
 *    and a short note appended to string content or pushed as a text
 *    part: "(ran in sandbox: writes limited to <cwd>; network denied
 *    except configured domains)". No env values, no command output
 *    beyond the note.
 *  - error (sandbox-caused) → `event.error.message` prefixed with
 *    "[sandbox] blocked by the sandbox (<summary>) — retrying asks to
 *    run unsandboxed: " and `event.error.metadata.sandbox` carrying the
 *    evidence (a count in the message, the list in the metadata — never
 *    stringified unknown objects).
 *
 * BOOKKEEPING (v2 dual-key): the wrap now happens at
 * `tool.execute.before`, so the EXECUTED input — and therefore
 * `event.input.command` at after-time — is the WRAPPED string, while the
 * gate's failure/attempt state keys on the ORIGINAL command text.
 * `pending` therefore indexes each entry under BOTH keys: the original
 * command text AND the wrapped string (`begin(command, { commandId, cwd,
 * wrapped })`), and `wrappedSet` holds every wrapped string for the
 * evaluate hook's `isWrapped` exact-match recognition. `handleAfter`
 * looks the entry up by `event.input.command` — the wrapped key is the
 * primary path; if the direct lookup misses it ALSO scans pending entries
 * for one whose `wrapped` matches (belt-and-braces: the dual key makes
 * this unreachable in normal operation). The gate failure record always
 * uses the ORIGINAL text — the wrapped string must never become a
 * failure-memory key. Non-shell tool events (`isShellTool`) and
 * unexpected input shapes return WITHOUT touching pending state (an
 * interleaved read/edit/MCP execution must never consume a shell
 * command's entry); a shell event that finds its entry deletes BOTH keys
 * (and clears the wrapped-string index) on EVERY path (completed,
 * errored, unknown status, missing fields, annotation failures). `begin`
 * overwrites a same-text entry (latest wins — the shared-by-text
 * collision the spec accepts). Never throws: the whole body is wrapped,
 * and a logger failure is swallowed too.
 */

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The shell tool names whose executions this handler observes. Everything
 * else (`read`, `edit`, MCP tools, …) is a no-op that never touches
 * pending state.
 *
 * @param {string} tool
 * @returns {boolean}
 */
export function isShellTool(tool) {
  return tool === "bash" || tool === "shell"
}

/**
 * Sandbox-denial markers matched against the failure text. Linux
 * filesystem denials are unattributed kernel errnos, so the markers carry
 * them; the last entry is weak but sandbox-indicative under the default
 * deny-all DNS.
 */
export const SANDBOX_DENIAL_MARKERS = Object.freeze([
  "Read-only file system",
  "Operation not permitted",
  "Connection blocked by network allowlist",
  "blocked by sandbox-runtime",
  "connection not allowed by ruleset",
  "Could not resolve host",
])

/** The note appended to a completed run's content. No env values, no
 * command output — the fixed sentence with the pending cwd. */
function ranNote(cwd) {
  return `(ran in sandbox: writes limited to ${cwd}; network denied except configured domains)`
}

/**
 * Create the after handler. All state is in-memory, per plugin instance:
 * `pending`, keyed by the full command text. The store and the gate are
 * injected (the runtime's `store()` and the policy gate's
 * `recordSandboxFailure`); broken or absent deps degrade to "no
 * attribution" (the marker fallback still works) and are logged, never
 * thrown.
 *
 * @param {{
 *   store: () => { getViolationsForCommand(id: string): readonly unknown[] } | undefined,
 *   gate: { recordSandboxFailure(command: string, violations: readonly unknown[]): void },
 *   log?: (m: string) => void,
 * }} deps
 * @returns {{
 *   begin(command: string, entry: { commandId: string; cwd: string; wrapped?: string }): void,
 *   isWrapped(resource: unknown): boolean,
 *   handleAfter(event: Object): Promise<void>,
 * }}
 */
export function createAfterHandler(deps) {
  const storeFn = typeof deps?.store === "function" ? deps.store : () => undefined
  const gate = isPlainObject(deps?.gate) ? deps.gate : {}
  const log = typeof deps?.log === "function" ? deps.log : (m) => console.warn(m)

  /** key → { commandId, cwd, wrapped, original } — written by begin under
   * BOTH the original command text and the wrapped string (v2: the
   * executed input at after-time is the wrapped string, the gate's state
   * keys on the original); read and deleted once by handleAfter. */
  const pending = new Map()
  /** The wrapped strings this instance produced — the evaluate hook's
   * exact-match recognition index. Cleared per entry on consume. */
  const wrappedSet = new Set()

  /**
   * Register a sandboxed execution: the entry is indexed under the
   * ORIGINAL command text AND — when a non-empty string — the wrapped
   * string (which also joins the `isWrapped` index). Overwrites a
   * same-text entry (latest wins). Defensive duck-typing; never throws.
   *
   * @param {string} command the ORIGINAL command text
   * @param {{ commandId: string, cwd: string, wrapped?: string }} [entry]
   */
  function begin(command, entry) {
    try {
      if (typeof command !== "string" || command === "") return
      const commandId =
        isPlainObject(entry) && typeof entry.commandId === "string" ? entry.commandId : ""
      const cwd = isPlainObject(entry) && typeof entry.cwd === "string" ? entry.cwd : ""
      const wrapped =
        isPlainObject(entry) && typeof entry.wrapped === "string" && entry.wrapped !== ""
          ? entry.wrapped
          : undefined
      const record = { commandId, cwd, wrapped, original: command }
      pending.set(command, record)
      if (wrapped !== undefined) {
        pending.set(wrapped, record)
        wrappedSet.add(wrapped)
      }
    } catch {
      /* never throw */
    }
  }

  /**
   * The evaluate hook's recognition: exact-match membership in the
   * wrapped-string index (a wrapped command's permission identity IS the
   * wrapped string — the harness evaluates what it is about to spawn).
   * Never throws.
   *
   * @param {unknown} resource
   * @returns {boolean}
   */
  function isWrapped(resource) {
    try {
      return typeof resource === "string" && wrappedSet.has(resource)
    } catch {
      return false
    }
  }

  /** The violations attributed to the commandId — a copied, truthy-filtered
   * array; empty whenever the store is absent, throws, or answers junk (a
   * falsy entry is not a denial). Never throws. */
  function violationsFor(commandId) {
    try {
      if (typeof commandId !== "string" || commandId === "") return []
      const store = storeFn()
      if (!isPlainObject(store) || typeof store.getViolationsForCommand !== "function") {
        return []
      }
      const list = store.getViolationsForCommand(commandId)
      return Array.isArray(list) ? list.filter(Boolean) : []
    } catch {
      return []
    }
  }

  /** The text of a completed run's `result.content` — the string itself, or
   * the text parts joined; "" when absent or unreadable. Never throws. */
  function contentText(result) {
    try {
      if (!isPlainObject(result)) return ""
      const content = result.content
      if (typeof content === "string") return content
      if (Array.isArray(content)) {
        return content
          .filter(
            (part) =>
              isPlainObject(part) && part.type === "text" && typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("\n")
      }
      return ""
    } catch {
      return ""
    }
  }

  /** A failed run's text, duck-typed in order: `error.message`, string
   * `error.metadata.output` / `.stderr`, and — defensively, if the event
   * still carries one — `result.content`. Scan what exists; never assume a
   * field. Never throws. */
  function failureText(event) {
    const parts = []
    try {
      const err = event.error
      if (err && typeof err === "object") {
        if (typeof err.message === "string") parts.push(err.message)
        if (isPlainObject(err.metadata)) {
          if (typeof err.metadata.output === "string") parts.push(err.metadata.output)
          if (typeof err.metadata.stderr === "string") parts.push(err.metadata.stderr)
        }
      }
      const content = contentText(event.result)
      if (content !== "") parts.push(content)
    } catch {
      /* a throwing getter just leaves earlier parts */
    }
    return parts.filter((part) => part !== "").join("\n")
  }

  /** Every marker contained in the text (kept in list order). */
  function matchedMarkers(text) {
    if (typeof text !== "string" || text === "") return []
    return SANDBOX_DENIAL_MARKERS.filter((marker) => text.includes(marker))
  }

  /** Record a sandbox-caused failure with the gate — the FULL command text
   * and the evidence (the gate fans the text out to its own segment keys
   * and copies the evidence). A broken gate is logged, never thrown. */
  function recordFailure(command, evidence) {
    try {
      if (typeof gate.recordSandboxFailure !== "function") {
        log("[sandbox] gate.recordSandboxFailure is unavailable — the retry will re-sandbox")
        return
      }
      gate.recordSandboxFailure(command, evidence)
    } catch (err) {
      try {
        log(`[sandbox] recordSandboxFailure failed: ${err?.message ?? String(err)}`)
      } catch {
        /* the logger must not break the handler either */
      }
    }
  }

  /**
   * Annotate a completed run: `metadata.sandbox` (+ `blocked`/`evidence`
   * when a marker fired) and the note appended to string content or pushed
   * as a text part. Reassignments only (a frozen nested object is left
   * intact); any mutation failure is swallowed — annotation is
   * best-effort.
   */
  function annotateResult(result, cwd, commandId, evidence) {
    try {
      if (!isPlainObject(result)) return
      const metadata = isPlainObject(result.metadata) ? result.metadata : {}
      const sandbox = evidence
        ? { mode: "sandbox", cwd, commandId, blocked: true, evidence }
        : { mode: "sandbox", cwd, commandId }
      result.metadata = { ...metadata, sandbox }
      const note = ranNote(cwd)
      if (typeof result.content === "string") {
        result.content = result.content === "" ? note : `${result.content}\n${note}`
      } else if (Array.isArray(result.content)) {
        result.content = [...result.content, { type: "text", text: note }]
      }
    } catch {
      /* swallowed — a frozen result must not break the bookkeeping */
    }
  }

  /**
   * Annotate a sandbox-caused error: the message prefixed with the
   * "[sandbox]" evidence line and `metadata.sandbox` carrying the evidence
   * list. Pre-existing metadata keys are preserved. Any mutation failure
   * (a frozen error object) is swallowed — the failure-memory record has
   * already happened, so the retry still asks.
   */
  function annotateError(error, cwd, commandId, evidence, summary) {
    try {
      if (!error || typeof error !== "object") return
      if (typeof error.message === "string") {
        error.message =
          `[sandbox] blocked by the sandbox (${summary}) — ` +
          `retrying asks to run unsandboxed: ${error.message}`
      }
      const metadata = isPlainObject(error.metadata) ? error.metadata : {}
      error.metadata = {
        ...metadata,
        sandbox: { mode: "sandbox", cwd, commandId, blocked: true, evidence },
      }
    } catch {
      /* swallowed — a frozen error must not break the bookkeeping */
    }
  }

  /**
   * Observe a tool `execute.after` event. Non-shell tools and unexpected
   * input shapes are strict no-ops that never touch pending state; a
   * shell event that finds its pending entry — by the wrapped string (the
   * v2 after-time shape; the direct map hit is the primary path, the
   * `wrapped`-field scan the fallback) or by the original text —
   * processes it (annotate completed / attribute + record + annotate
   * errored) and deletes BOTH its keys on every path. The gate failure
   * record always keys on the ORIGINAL command text. Never throws.
   *
   * @param {Object} event the verified `execute.after` shape
   * @returns {Promise<void>}
   */
  async function handleAfter(event) {
    let command
    try {
      if (!isPlainObject(event)) return
      if (!isShellTool(event.tool)) return
      const input = isPlainObject(event.input) ? event.input : undefined
      if (!input || typeof input.command !== "string") return
      command = input.command
      let entry = pending.get(command)
      if (!entry) {
        // Fallback: recover an entry whose wrapped string matches even if
        // its direct map key is gone (defensive — the dual-key index makes
        // this unreachable in normal operation).
        for (const candidate of pending.values()) {
          if (candidate.wrapped === command) {
            entry = candidate
            break
          }
        }
      }
      if (!entry) return
      // The gate's failure memory keys on the ORIGINAL command text; the
      // wrapped string must never become a state key.
      const original = typeof entry.original === "string" ? entry.original : command
      try {
        if (event.status === "completed") {
          const violations = violationsFor(entry.commandId)
          const markers = matchedMarkers(contentText(event.result))
          // Completed: a marker in the run's own output is the failure
          // signal; violations alone are non-fatal denials on a succeeded
          // run ("violations with exit 0 → annotate lightly, do not
          // record" — recording a succeeded run would unsandbox a retry
          // that could read deny-read secrets).
          if (markers.length > 0) {
            const evidence = violations.length > 0 ? violations : markers
            recordFailure(original, evidence)
            annotateResult(event.result, entry.cwd, entry.commandId, evidence)
          } else {
            annotateResult(event.result, entry.cwd, entry.commandId)
          }
        } else if (event.status === "error") {
          const violations = violationsFor(entry.commandId)
          const markers = matchedMarkers(failureText(event))
          if (violations.length > 0 || markers.length > 0) {
            const evidence = violations.length > 0 ? violations : markers
            const summary =
              violations.length > 0
                ? `${violations.length} sandbox violation${violations.length === 1 ? "" : "s"}`
                : `denial markers: ${markers.join("; ")}`
            recordFailure(original, evidence)
            annotateError(event.error, entry.cwd, entry.commandId, evidence, summary)
          }
          // Not sandbox-caused: no record, no annotation — event untouched.
        }
        // Any other status: nothing to observe; the entry is still consumed.
      } finally {
        // Consume BOTH of the entry's keys (original + wrapped) and clear
        // the wrapped-string index; `command` covers the lookup key when
        // the entry was found by the original text.
        pending.delete(command)
        pending.delete(original)
        if (typeof entry.wrapped === "string") {
          pending.delete(entry.wrapped)
          wrappedSet.delete(entry.wrapped)
        }
      }
    } catch (err) {
      try {
        log(`[sandbox] after-hook error: ${err?.message ?? String(err)}`)
      } catch {
        /* the logger must not break the handler either */
      }
    }
  }

  return { begin, isWrapped, handleAfter }
}
