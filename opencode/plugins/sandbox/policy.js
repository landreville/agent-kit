/**
 * The permission gate for the OpenCode `sandbox` plugin — the security
 * heart. `decide` runs at `tool.execute.before`, BEFORE the harness's
 * permission decision exists for the command (verified hook order:
 * tool.execute.before → shell.create.before → permission.evaluate →
 * spawn), so it PREDICTS that outcome locally from the effective rules
 * (rules.js, mirroring core semantics) and runs the eligibility chain only
 * for commands that would ASK: predicted allow/deny are the harness's to
 * enforce and are left untouched (deny-finality is absolute; allow-listed
 * commands run exactly as the user configured). It never touches the
 * sandbox package, a model, or the filesystem: the runtime (availability
 * self-test, install, decline flag) and the classifier are injected; the
 * clock and the logger are injectable.
 *
 * Decide chain (first match wins):
 *   0. `markInstallDeclined()` was called, or `enabled: false` → inert:
 *      always `{ kind: "skip" }`, without consulting rules or runtime.
 *   1. Segmentation via segments.js — `segmentCommand(command)`, the
 *      SINGLE parser the whole compound-command feature shares (quote
 *      aware, total, strictly fail-closed). An UNPARSEABLE shape —
 *      subshell `(…)`, `$(`, backtick, heredoc `<<`, background `&`, the
 *      bashisms `|&`/`&>`, `$'`, an unquoted `#`, unbalanced quotes, or
 *      an empty segment at an operator boundary (including the blank
 *      candidate at a mixed operator+newline boundary, `a &&\nb` —
 *      segments.js rejects it, and the gate treats that as unparseable)
 *      → skip: the command's permission outcome cannot be predicted
 *      faithfully over it, so it follows the normal permission flow
 *      (status quo). The reason is logged once per reason string (for
 *      operators, never in a message). This replaces the v2
 *      simple-command test (which skipped on raw newlines and any `&`):
 *      carrying the protectiveness now is segments.js's ANTI-DRIFT
 *      contract — its accept-set is deliberately narrower than the shell
 *      scanner's (`scan.ts:590,710`) and every segment it emits covers
 *      the scanner's resources for that shape.
 *   2. Prediction over BOTH assert sets core runs (in their order). The
 *      shell set: ONE resource per segment — core aggregates
 *      `permission.ts:173-189`, any resource denied → deny, else any ask.
 *      The set that runs BEFORE it: `authorizeExternal`
 *      (`file-access.ts:125-142`) under action `external_directory` for
 *      every cwd-set segment's directory — the resolved ABSOLUTE path
 *      (~ expansion, `file-access.ts:67-76`) against the same session cwd
 *      the wrap is scoped to — and a wrap suppresses it ENTIRELY (the
 *      wrapped command's scan sees only the sandbox runner: no
 *      directories), which is why the prediction must mirror it here.
 *      Aggregation across both, mirroring core: ANY deny → skip (core
 *      denies the invocation on either action before anything prompts);
 *      ALL allow → skip (the command runs exactly as the user's rules
 *      configured); ANY ask → fall through to the eligibility chain.
 *   3. `await runtime.availability({ options, requireSeccomp:
 *      options.requireSeccomp })` not ok → skip, with a one-time message
 *      naming the reason (the "messaged once" flag; subsequent commands
 *      stay silent) — EXCEPT the installable case (reason "not-installed",
 *      `install: "ask"`, runtime not declined), which falls through so a
 *      command caught by a later gate never sees the consent prompt.
 *   4. The command matches `excludedCommands` or invokes `srt` itself →
 *      skip (the agent is deliberately sandboxing on its own).
 *   5. The command is in the failure memory (TTL `failureMemorySec`, lazy
 *      expiry on read) → skip. This is the unsandboxed-retry escape hatch.
 *      `attempts[command] >= maxSandboxAttempts` → skip (lifetime-per-text
 *      cap, recorded by the wiring per sandboxed execution).
 *   6. Classifier enabled and verdict `UNSAFE` → skip with
 *      `Classifier: ${reason}` (a static fallback when the verdict carries
 *      no reason).
 *   7. The installable case from step 3 → the consent flow: approval of
 *      the upcoming ask runs THIS command with normal permissions and
 *      fires the background install (via `noteGranted` at execute.after),
 *      so SUBSEQUENT commands run sandboxed. The consent is stashed keyed
 *      by the call id and the verbatim INSTALL_CONSENT_MESSAGE is returned
 *      (and stashed for the evaluate hook to surface). CONSENT-RETRY
 *      INFERENCE: reaching this branch while ANY consent is still
 *      outstanding means the earlier ask was not granted — tool calls are
 *      sequential, so an approved ask's `noteGranted` would have cleared
 *      it before any later decide — → `markInstallDeclined()`, silent skip.
 *   8. Otherwise → `{ kind: "wrap" }` (the wiring wraps with
 *      `SandboxManager.wrapWithSandbox` and rewrites `event.input.command`).
 *
 * Messages a skip carries (steps 3/6/7) are ALSO stashed per call id:
 * `messageFor(callID)` returns the stashed `{ message }` exactly once
 * (consumed on read) so the evaluate hook can surface it on the ask.
 *
 * `commandKeys(command)` — the full text, its naive
 * `&&`/`||`/`;`/`|`-segments, AND (when the segmenter accepts) segments.js's
 * segments — remains the shared correlation contract for `recordAttempt` /
 * `recordSandboxFailure`: the wiring records with the FULL command text,
 * and the key union lines a compound's fragments up with a later decide
 * (a compound's retry finds the failure whichever shape it arrives in).
 * A non-string command normalizes to `[""]` (a key no real command ever
 * carries). It is a CORRELATION contract, not the decision — what
 * segments over would-ask/allow/deny is decided is `segmentCommand`'s
 * job (see step 1), and the naive split inside this union stays so v2-era
 * keys never alias away.
 *
 * STATE IS PER PLUGIN INSTANCE: every gate owns its rule loader (an
 * agent-ruleset cache that survives a config edit would keep predicting
 * against stale rules — see rules.js). `failures`, `attempts`,
 * `consentPending`, the message stash and the flags are all per gate too.
 *
 * `noteGranted(callID)` is the consent flow's approval signal — the
 * caller (index.js's execute.after) gates it on `status === "completed"`
 * AND on the shell tool: only a completed shell run proves that the shell
 * ask was granted, because a REJECTED ask also fires execute.after
 * (status "error", the command never spawned — Task 1's probe archive),
 * and treating a rejection as a grant would fire the consented install on
 * a denial. On a completed run with a pending
 * consent, the consent is cleared and the consented install fires in
 * the background (`runtime.install()`, fire-and-forget — the result is
 * ignored; the next command's availability re-probes). Without a
 * pending consent it is a no-op (a wrapped or untouched command never
 * triggers an install).
 *
 * `markInstallDeclined` is the one-way decline: the gate goes inert,
 * consent state (pending entries AND their stashed messages — a denial
 * must not outlive its ask) is swept, and the decline mirrors into the
 * runtime's own one-way flag (best-effort: step 3 reads
 * `runtime.declined()` as its backstop, so the two flags must agree).
 *
 * `decide` NEVER throws: the whole body is wrapped — rules.js's pure
 * functions throw on non-string inputs (faithful to core), so inputs are
 * vetted/stringified before crossing into them — and ANY internal error (a
 * rejecting availability probe, a throwing classifier, a malformed input)
 * returns `{ kind: "skip" }`: the status quo. An error must never wrap a
 * command.
 */

import { tmpdir, homedir } from "node:os"
import path from "node:path"
import { isSrtInvocation, isUnsandboxedInvocation, matchesExcludedCommand } from "./config.js"
import { createRuleLoader, predictPermission } from "./rules.js"
import { segmentCommand } from "./segments.js"

/** Step 7's message: approval of the ask runs this command with normal
 * permissions and consents to the local npm install (performed in the
 * background at execute.after); subsequent commands run sandboxed. Denial
 * leaves sandboxing off — and the repeat-ask inference makes it stick. */
const INSTALL_CONSENT_MESSAGE =
  "Sandbox runtime not installed. Approving runs this command with normal permissions and installs @anthropic-ai/sandbox-runtime into the plugin directory (local npm install, no sudo), so subsequent commands run sandboxed. Denying leaves sandboxing off."

/** Step 6's message when the model's UNSAFE verdict carries no reason. */
const CLASSIFIER_FALLBACK_REASON = "command would not succeed inside the sandbox"

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The NAIVE segment split, mirroring config.js's `isSrtInvocation`
 * segmentation. Still the correlation fallback inside `commandKeys` —
 * decide itself does NOT use it: the decision segments via
 * `segmentCommand` (segments.js), the feature's single shared parser. */
const SEGMENT_SPLIT = /&&|\|\||[;|]/

/**
 * The shared state-key helper: `[command, ...its naive
 * &&/||/;/|-segments, ...segments.js's segments when the segmenter
 * accepts]` — the full text verbatim, then each key trimmed (empty keys
 * dropped), deduped with first occurrence winning. The segmenter's
 * segments are what makes a newline-separated script's fragments
 * correlate (the naive split does not see newlines); an unparseable shape
 * falls back to the naive keys alone — segments.js is total, so this
 * union never throws and never gains a fake segment. A non-string
 * command normalizes to `[""]` (a key no real command ever carries).
 *
 * NOTE: this is a CORRELATION contract, NOT the decision. The shell
 * scanner's separator set (`packages/core/src/shell/scan.ts:590` —
 * `"<>&|;\n".includes(char)` — and `:710`, `const separator = operator ??
 * char`) is wider than any of the key sets here. With the segment-level
 * gate, the old `isSimpleCommand` scanner-separator union is GONE: what
 * carries the decision's protectiveness now is `segmentCommand`'s
 * reject-set (see the module header, step 1), and this union only needs
 * to keep the naive keys so v2-era failure/attempt keys never alias away.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function commandKeys(command) {
  const text = typeof command === "string" ? command : ""
  const keys = [text]
  for (const segment of text.split(SEGMENT_SPLIT)) {
    const trimmed = segment.trim()
    if (trimmed !== "") keys.push(trimmed)
  }
  // The segmenter's segments join the union only when it ACCEPTS the
  // shape (its reject reasons are logs-only; `{ ok: false }` contributes
  // nothing).
  const segmented = segmentCommand(text)
  if (segmented.ok) keys.push(...segmented.segments)
  return [...new Set(keys)]
}

/** The cwd-command word set — VERBATIM transcription of
 * `packages/core/src/shell/parse.ts:14` (the scanner routes exactly these
 * commands into `directories`, which `authorizeExternal` then asserts
 * under `external_directory` BEFORE the shell assert; `push-location` and
 * `set-location` are the PowerShell aliases the same line carries — the
 * scanner only lowercases the word for PowerShell, so on a POSIX scan the
 * membership is the exact word). */
const CWD_COMMANDS = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])

/** True when the segment's FIRST whitespace-delimited word is a cwd
 * command — the route that carries an `external_directory` assert in
 * core (the design's fact 5: the cwd set routes into `directories`, not
 * shell resources). */
function isCwdCommand(segment) {
  return CWD_COMMANDS.has(segment.trim().split(/\s+/)[0])
}

/** Mirror of core's `resolvePath` home expansion
 * (`packages/core/src/file-access.ts:67-76`, the POSIX arms): a bare `~`
 * resolves to the home and a `~/…` to home/joined; anything else is
 * returned unchanged for the caller's `path.resolve(base, …)`. `home`
 * defaults to `os.homedir()` evaluated AT CALL TIME (on POSIX that is
 * `$HOME`), so a test injects a home through the environment. */
function resolveDirectory(dir, home = homedir()) {
  return dir === "~" ? home : dir.startsWith("~/") ? path.join(home, dir.slice(2)) : dir
}

/** Quote-aware word split for ONE segment — the same quote state machine
 * segments.js uses ('…' literal, "…" with backslash escapes, an unquoted
 * backslash escapes the next character), with top-level whitespace as the
 * only separator. This is how a cwd segment's directory argument is pinned
 * down the way core's tree-sitter word list would present it
 * (`parse.ts:309ff` walks parts; a quoted string is ONE part, so
 * `cd "my dir"` yields the argument `my dir`, not `"my`). Only ever
 * called on a segment segments.js ACCEPTED, so the segment's overall
 * quote balance is guaranteed. */
function segmentWords(segment) {
  const words = []
  let current = ""
  let quote = null
  let open = false
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (quote === "'") {
      current += c
      if (c === "'") quote = null // literal: a backslash escapes nothing
      continue
    }
    if (quote === '"') {
      if (c === "\\") {
        current += c + (segment[i + 1] ?? "")
        i += 1 // hop: the escape pair is one word text
        continue
      }
      current += c
      if (c === '"') quote = null
      continue
    }
    if (c === "\\") {
      current += c + (segment[i + 1] ?? "")
      i += 1
      open = true
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      current += c
      open = true
      continue
    }
    if (c === " " || c === "\t") {
      if (open) {
        words.push(current)
        current = ""
        open = false
      }
      continue
    }
    current += c
    open = true
  }
  if (open) words.push(current)
  return words
}

/**
 * The cwd segment's directory arguments, mirroring core's POSIX
 * extraction: EVERY word after the command name that is not a flag
 * (`parse.ts:309-315` maps all of them, filtering `startsWith("-")`),
 * its matching quotes stripped (`:338-343` `directoryArgument`), and —
 * the DROP, mirroring `expandKnownDirectory` `:360-362` — a value that
 * contains a `$` or a backtick is skipped (unknowable at
 * permission-analysis time: core produces NO directory assert for that
 * argument, so the gate produces no external_directory prediction for it
 * either — the segment's own shell prediction remains the gate's
 * protection). A bare `cd` with no argument resolves "." against the
 * gate's session cwd (an over-prediction: core asserts nothing).
 *
 * @param {string} segment
 * @returns {string[]}
 */
function directoryArgs(segment) {
  const words = segmentWords(segment).slice(1).filter((word) => !word.startsWith("-"))
  if (words.length === 0) return ["."]
  const dirs = []
  for (const word of words) {
    const quote = word[0]
    const text =
      (quote === '"' || quote === "'") && word.at(-1) === quote ? word.slice(1, -1) : word
    if (text.includes("$") || text.includes("`")) continue
    dirs.push(text)
  }
  return dirs
}

/**
 * Create the gate. All state is in-memory, per plugin instance: `failures`
 * (TTL `failureMemorySec`) and `attempts` (lifetime-per-text) keyed by
 * command text; `consentPending` and the message stash keyed by call id;
 * plus the one-time unavailable-message flag and the one-way
 * install-declined flag.
 *
 * @param {{
 *   options: import("./config.js").SandboxOptions,
 *   runtime: {
 *     availability(input?: { requireSeccomp?: boolean, options?: Object }): Promise<{ ok: true, mode: string } | { ok: false, reason: string }>,
 *     install(): Promise<{ ok: true } | { ok: false, reason: string }>,
 *     declined(): boolean,
 *     markDeclined(): void,
 *   },
 *   classifier?: { classify(command: string, policy: { allowedDomains: string[], writeRoots: string[], deniedReads: string[] }): Promise<{ verdict: "SAFE" | "UNSAFE", reason?: string }> },
 *   log?: (m: string) => void,
 *   now?: () => number,
 * }} deps
 * @returns {{
 *   decide(input: { command: string, ctx: Object, sessionID: string, agentID: string, callID: string }): Promise<{ kind: "wrap" } | { kind: "skip", message?: string }>,
 *   noteGranted(callID: string): void,
 *   messageFor(callID: string): { message?: string } | undefined,
 *   commandKeys(command: string): string[],
 *   recordAttempt(command: string): void,
 *   recordSandboxFailure(command: string, violations: readonly unknown[]): void,
 *   markInstallDeclined(): void,
 *   declined(): boolean,
 * }}
 */
export function createGate(deps) {
  const options = isPlainObject(deps?.options) ? deps.options : {}
  const runtime = isPlainObject(deps?.runtime) ? deps.runtime : {}
  const classifier = isPlainObject(deps?.classifier) ? deps.classifier : undefined
  const log = typeof deps?.log === "function" ? deps.log : (m) => console.warn(m)
  const now = typeof deps?.now === "function" ? deps.now : () => Date.now()

  const maxAttempts =
    Number.isInteger(options.maxSandboxAttempts) && options.maxSandboxAttempts >= 1
      ? options.maxSandboxAttempts
      : 3
  const failureTtlMs =
    (Number.isInteger(options.failureMemorySec) && options.failureMemorySec >= 1
      ? options.failureMemorySec
      : 1800) * 1000

  /** cmd → { violations: unknown[], at } — written by the after hook on a
   * sandbox-caused failure; read here (skip). Lazy expiry on read. */
  const failures = new Map()
  /** cmd → count — sandboxed executions per command text; lifetime cap. */
  const attempts = new Map()
  /** callID → { command, at } — an install consent ask this gate stashed
   * and no execute.after grant has cleared yet. */
  const consentPending = new Map()
  /** callID → { message } — the message the evaluate hook surfaces for
   * this call's ask; consumed (deleted) on read. */
  const messages = new Map()
  /** This gate's rule loader — one per plugin instance, NEVER shared
   * through the module (Important 3: a config edit rebuilds the plugin
   * instance inside the same process, and a module-scope agent-ruleset
   * cache would keep predicting against stale rules — a new deny rule
   * would be invisible, and with the recognizer never flipping a deny
   * that is a deny bypass). */
  const ruleLoader = createRuleLoader()
  /** One-time "sandbox unavailable" message flag. */
  let unavailableMessaged = false
  /** One-way install-decline flag: once set, the gate is inert. */
  let installDeclined = false
  /** The segmenter's rejection reasons already logged (once per distinct
   * reason — the reason vocabulary is a fixed small set, so this is
   * bounded). */
  const rejectionLogged = new Set()

  /** The policy summary handed to the classifier, built from options.
   * Decide carries no cwd, so the write root renders as the honest
   * placeholder string plus the real tmpdir. */
  function policySummary() {
    return {
      allowedDomains: Array.isArray(options.network?.allowedDomains)
        ? options.network.allowedDomains
        : [],
      writeRoots: ["<command working directory>", tmpdir()],
      deniedReads: Array.isArray(options.filesystem?.denyRead) ? options.filesystem.denyRead : [],
    }
  }

  /** True while the command's failure-memory entry exists and has not
   * expired; expired entries are dropped on read (lazy expiry). */
  function failureMarked(command) {
    const entry = failures.get(command)
    if (!entry) return false
    if (now() - entry.at >= failureTtlMs) {
      failures.delete(command)
      return false
    }
    return true
  }

  /** Stash a skip's message for the evaluate hook (keyed by the call id,
   * consumed on read). Empty/non-string messages are never stashed. */
  function stashMessage(callID, message) {
    if (typeof message !== "string" || message === "") return
    messages.set(callID, { message })
  }

  /** Count one sandboxed execution of the command (called by the wiring
   * after wrapping): recorded under EVERY key of `commandKeys(command)`,
   * so a compound's fragments accumulate the attempts and the cap trips
   * whichever shape the next decide carries. Lifetime-per-text; never
   * throws. */
  function recordAttempt(command) {
    try {
      for (const key of commandKeys(command)) {
        attempts.set(key, (attempts.get(key) ?? 0) + 1)
      }
    } catch {
      /* never throw */
    }
  }

  /**
   * Record a sandbox-caused failure under EVERY key of
   * `commandKeys(command)`: the command — whole or as a fragment of a
   * later compound — follows the normal permission flow (and runs
   * unsandboxed on approval) for the next `failureMemorySec`. Attempts
   * stay counted. Never throws.
   *
   * @param {string} command
   * @param {readonly unknown[]} violations the attribution evidence
   */
  function recordSandboxFailure(command, violations) {
    try {
      const evidence = Array.isArray(violations) ? [...violations] : []
      const at = now()
      for (const key of commandKeys(command)) {
        failures.set(key, { violations: [...evidence], at })
      }
    } catch {
      /* never throw */
    }
  }

  /** The one-way install-decline flag: once declined, the gate is inert
   * (every decide returns `{ kind: "skip" }`) and no further
   * install-consent messages are produced. Also sweeps every outstanding
   * consent — pending entries AND their stashed messages: the consent the
   * user just denied must not outlive the denial — and mirrors the decline
   * into the runtime's own one-way flag (best-effort: step 3 reads
   * `runtime.declined()` as its backstop, so the two flags must agree).
   * Idempotent. */
  function markInstallDeclined() {
    installDeclined = true
    try {
      runtime?.markDeclined?.()
    } catch {
      /* the runtime mirror is best-effort; the gate's flag is authoritative */
    }
    for (const key of consentPending.keys()) {
      messages.delete(key)
    }
    consentPending.clear()
  }

  /**
   * The approval signal for the consent flow: the command with this call
   * id ran to COMPLETION, so its ask was granted. (The caller gates on
   * `status === "completed"`: a rejected ask fires execute.after with
   * status "error" and must never reach here.) Clears the pending
   * consent and fires the consented install in the background —
   * fire-and-forget: the result is ignored (a successful install clears
   * the runtime's availability memo, so the NEXT command's availability
   * re-probes; a failed one leaves the status quo and is logged only if
   * the promise rejects). No-op without a pending consent. Never throws.
   *
   * @param {string} callID
   */
  function noteGranted(callID) {
    try {
      const key = typeof callID === "string" ? callID : ""
      if (!consentPending.has(key)) return
      consentPending.delete(key)
      if (typeof runtime.install !== "function") return
      Promise.resolve()
        .then(() => runtime.install())
        .catch((err) => {
          try {
            log(`[sandbox] background install failed: ${err?.message ?? String(err)}`)
          } catch {
            /* the logger must not break the gate either */
          }
        })
    } catch {
      /* never throw */
    }
  }

  /**
   * The message stashed for this call id — consumed (deleted) on read, so
   * the evaluate hook surfaces it exactly once per message occurrence.
   * `undefined` when nothing is stashed. Never throws.
   *
   * @param {string} callID
   * @returns {{ message?: string } | undefined}
   */
  function messageFor(callID) {
    try {
      const key = typeof callID === "string" ? callID : ""
      const entry = messages.get(key)
      if (entry !== undefined) messages.delete(key)
      return entry
    } catch {
      return undefined
    }
  }

  /**
   * The pre-permission decision (see the module header for the chain).
   * Returns `{ kind: "wrap" }` only for a command the gate segmented
   * faithfully whose segments clear BOTH assert-set predictions (no deny,
   * at least one ask) and then the eligibility chain; every other path is
   * `{ kind: "skip" }` — with a `message` when the user should be told why
   * (also stashed under the call id for the evaluate hook). Never throws:
   * any internal error returns `{ kind: "skip" }` — the status quo.
   *
   * @param {{ command: string, ctx: Object, sessionID: string, agentID: string, callID: string }} input
   * @returns {Promise<{ kind: "wrap" } | { kind: "skip", message?: string }>}
   */
  async function decide(input) {
    try {
      if (installDeclined) return { kind: "skip" }
      if (options.enabled === false) return { kind: "skip" }
      const raw = isPlainObject(input) ? input : {}
      // Vet before rules.js: its pure functions throw on non-strings
      // (faithful to core), so only a non-empty string command crosses.
      const command = typeof raw.command === "string" ? raw.command : ""
      if (command.trim() === "") return { kind: "skip" }
      const callID = typeof raw.callID === "string" ? raw.callID : ""

      // Step 1 — segment (segments.js, the single parser the whole
      // compound-command feature shares). An unparseable shape — subshell,
      // `$(…)`, heredoc, background `&`, `$'`, an unquoted comment,
      // unbalanced quotes, an empty segment at an operator boundary
      // (including the blank candidate at a mixed operator+newline
      // boundary like `a &&\nb`) → skip: the command's permission outcome
      // cannot be predicted faithfully over it, so it follows the normal
      // permission flow (status quo, today's ask exactly). The reason is
      // logged once per distinct reason string — for the operator, never
      // in a message.
      const segmented = segmentCommand(command)
      if (!segmented.ok) {
        if (!rejectionLogged.has(segmented.reason)) {
          rejectionLogged.add(segmented.reason)
          log(`[sandbox] gate: unparseable command (${segmented.reason}) — leaving the decision to the permissions`)
        }
        return { kind: "skip" }
      }
      const segments = segmented.segments

      // Step 2 — predict the permission outcome BOTH ways core will assert
      // it. The shell set: one resource per segment under `shell`
      // (core's aggregated decision, permission.ts:173-189 — any resource
      // denied → deny; else any ask). The set that runs BEFORE it:
      // `authorizeExternal` (file-access.ts:125-142) under action
      // `external_directory` for every cwd-set segment's directory,
      // resolved ABSOLUTE against the same session cwd the wrap is scoped
      // to (mirrors index.js's sessionCwd()). A wrap suppresses the
      // external assert entirely (the wrapped command's scan sees only
      // the sandbox runner: no directories), so the prediction must
      // mirror it here. Aggregation mirrors core's ANY-deny/ANY-ask across
      // both: ANY deny → skip (core denies the invocation on either
      // action, before anything prompts); ALL allow → skip (the command
      // runs exactly as the user's rules configured); ANY ask → the
      // eligibility chain. No runtime or classifier call on the first
      // two outcomes.
      const loaded = await ruleLoader.loadRules(raw.ctx, raw.sessionID, raw.agentID)
      if (loaded?.ok !== true) return { kind: "skip" }
      const base =
        typeof raw.ctx?.location?.directory === "string" && raw.ctx.location.directory !== ""
          ? raw.ctx.location.directory
          : process.cwd()
      let denied = false
      let asked = false
      for (const segment of segments) {
        const effect = predictPermission({ rules: loaded.rules, action: "shell", command: segment })
        if (effect === "deny") {
          denied = true
          break
        }
        if (effect === "ask") asked = true
      }
      if (!denied) {
        directories: for (const segment of segments) {
          if (!isCwdCommand(segment)) continue
          // A `$`/backtick argument is already dropped inside
          // directoryArgs (mirrored core drop: no assert, no prediction).
          for (const arg of directoryArgs(segment)) {
            const resolved = path.resolve(base, resolveDirectory(arg))
            // The resource form core ACTUALLY asserts for an external
            // directory is the resolved path joined with "/*"
            // (file-access.ts:117 — `resource: slash(path.join(directory,
            // "*"))`) — NOT the bare path (a `/tmp/**` deny matches the
            // asserted `/*` form; the bare `/tmp` would predict ask again).
            const effect = predictPermission({
              rules: loaded.rules,
              action: "external_directory",
              command: path.join(resolved, "*"),
            })
            if (effect === "deny") {
              denied = true
              break directories
            }
            if (effect === "ask") asked = true
          }
        }
      }
      if (denied) return { kind: "skip" }
      if (!asked) return { kind: "skip" }

      // Step 3 — availability (memoized in the runtime: the first
      // eligible command pays the self-test once, initializing the
      // manager with the production base config).
      const availability = await runtime.availability({
        options,
        requireSeccomp: options.requireSeccomp,
      })
      const ok = availability?.ok === true
      const reason = ok
        ? undefined
        : typeof availability?.reason === "string"
          ? availability.reason
          : "unknown"
      // The installable case falls through so exclusions, failure memory,
      // the cap, and the classifier can skip without ever raising the
      // consent prompt; only an otherwise-wrapping command reaches step 7.
      const installable =
        !ok &&
        reason === "not-installed" &&
        options.install === "ask" &&
        (typeof runtime.declined !== "function" || runtime.declined() !== true)
      if (!ok && !installable) {
        if (!unavailableMessaged) {
          unavailableMessaged = true
          const message = `Sandbox unavailable (${reason}) — approving runs the command unsandboxed (normal permissions).`
          stashMessage(callID, message)
          return { kind: "skip", message }
        }
        return { kind: "skip" }
      }

      // Step 4 — exclusions and self-sandboxing.
      if (matchesExcludedCommand(command, options.excludedCommands)) return { kind: "skip" }
      if (isSrtInvocation(command)) return { kind: "skip" }
      if (isUnsandboxedInvocation(command)) return { kind: "skip" }

      // Step 5 — failure memory (the unsandboxed-retry escape hatch) and
      // the lifetime attempt cap. Before the classifier: a sandbox-burned
      // command must not spend a model call.
      if (failureMarked(command)) return { kind: "skip" }
      if ((attempts.get(command) ?? 0) >= maxAttempts) return { kind: "skip" }

      // Step 6 — the opt-in classifier (never throws here; a throwing one
      // lands in the catch → skip, the status quo).
      if (options.classifier?.enabled === true && typeof classifier?.classify === "function") {
        const verdict = await classifier.classify(command, policySummary())
        if (verdict?.verdict === "UNSAFE") {
          const why =
            typeof verdict.reason === "string" && verdict.reason !== ""
              ? verdict.reason
              : CLASSIFIER_FALLBACK_REASON
          const message = `Classifier: ${why}`
          stashMessage(callID, message)
          return { kind: "skip", message }
        }
      }

      // Step 7 — package missing, consent to install: approval of the ask
      // runs THIS command with normal permissions and IS the install
      // consent; `noteGranted` (at execute.after) fires the background
      // install so subsequent commands run sandboxed.
      //
      // CONSENT-RETRY INFERENCE (session-wide): a consent ask already
      // outstanding for ANY call means the earlier ask was not granted —
      // tool calls are SEQUENTIAL, so an approved call's noteGranted would
      // have cleared its consent before any later decide could run. The
      // repeat is the only denial signal the plugin can see: go inert
      // (markInstallDeclined also sweeps the stale consent) and skip
      // SILENTLY — the spec's "no repeat prompts".
      if (!ok) {
        if (consentPending.size > 0) {
          markInstallDeclined()
          return { kind: "skip" }
        }
        consentPending.set(callID, { command, at: now() })
        stashMessage(callID, INSTALL_CONSENT_MESSAGE)
        return { kind: "skip", message: INSTALL_CONSENT_MESSAGE }
      }

      // Step 8 — wrap: the wiring rewrites `event.input.command` with the
      // sandboxed string and records the attempt.
      return { kind: "wrap" }
    } catch (err) {
      try {
        log(`[sandbox] gate error — leaving the decision to the permissions: ${err?.message ?? String(err)}`)
      } catch {
        /* the logger must not be able to break the gate either */
      }
      return { kind: "skip" }
    }
  }

  return {
    decide,
    noteGranted,
    messageFor,
    commandKeys,
    recordAttempt,
    recordSandboxFailure,
    markInstallDeclined,
    // Read-only accessor for the one-way flag (the wiring may want to
    // know whether the gate inferred a consent denial). The method name
    // is a property key; the body reads the outer `let` binding.
    declined() {
      return installDeclined
    },
  }
}
