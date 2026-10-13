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
 *   1. Simple commands only — no `&&`/`||`/`;`/`|` segment, no raw
 *      newline, and NO `&` at all (a bare `&` backgrounds; `2>&1` is the
 *      deliberately conservative casualty — it is simply not wrapped);
 *      anything the shell SCANNER would fragment follows the normal
 *      permission flow unwrapped (see `isSimpleCommand` and the
 *      `SCANNER_SEPARATORS` note on `shell/scan.ts:590,710`).
 *   2. `loadRules(ctx, sessionID, agentID)` (this gate's own loader) not
 *      ok → skip (status quo: nothing is ever wrapped on a failed
 *      prediction). Predicted `deny` or `allow` → skip with NO
 *      runtime/classifier calls.
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
 * `commandKeys(command)` — full text plus its `&&`/`||`/`;`/`|`-segments —
 * remains the shared correlation contract for `recordAttempt` /
 * `recordSandboxFailure`: the wiring records with the FULL command text,
 * and the segment keys line a compound's fragments up with a later simple
 * decide (a compound's retry finds the failure whichever shape it arrives
 * in). A non-string command normalizes to `[""]` (a key no real command
 * ever carries). It is NOT the simple-command test on its own — see
 * `isSimpleCommand`, which unions it with the shell scanner's separator
 * set.
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

import { tmpdir } from "node:os"
import { isSrtInvocation, matchesExcludedCommand } from "./config.js"
import { createRuleLoader, predictPermission } from "./rules.js"

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

/** The segment split, mirroring config.js's `isSrtInvocation` segmentation. */
const SEGMENT_SPLIT = /&&|\|\||[;|]/

/** The SHELL SCANNER's separator set
 * (`packages/core/src/shell/scan.ts:590` — `"<>&|;\n".includes(char)` — and
 * `:710`, `const separator = operator ?? char`, with the newline's heredoc
 * re-processing): how the scanner decides that one input is MORE than one
 * command. It is a superset of `SEGMENT_SPLIT` above, which is why the
 * simple-command test cannot be `commandKeys(...).length === 1` alone.
 * THE TWO DEFINITIONS MUST NOT DRIFT APART: `isSimpleCommand` is the
 * conservative union of both (a raw newline or a `\r`, and ANY `&` —
 * `&&`, `||`'s cousins, a background `&`, and the redirect `2>&1`), so a
 * command the scanner fragments is never wrapped, while a command the
 * scanner sees as ONE command still is. */
const SCANNER_SEPARATORS = /[\n\r]/

/**
 * The shared state-key helper: `[command, ...its &&/||/;/|-separated
 * segments]` — the full text verbatim, then each segment trimmed (empty
 * segments dropped), deduped with first occurrence winning. The wiring
 * imports this so failure/attempt keys line up across hooks, and decide
 * uses its cardinality as part of the simple-command test: exactly one key
 * means no `&&`/`||`/`;`/`|` segments. A non-string command normalizes to
 * `[""]` (a key no real command ever carries).
 *
 * NOTE: this is a CORRELATION contract, not a scanner mirror — it is
 * deliberately narrower than the shell scanner's separator set (see
 * `SCANNER_SEPARATORS` and `isSimpleCommand`).
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
  return [...new Set(keys)]
}

/**
 * Is this ONE command, as far as the shell scanner is concerned? Only
 * then are the wrapped string and the scanner's fragments the same string,
 * which is what makes the permission prediction (rules evaluated on the
 * exact command text) and the evaluate recognizer (an exact match against
 * the wrapped string) both hold.
 *
 * Three conditions, all of which must hold:
 *   1. no `&&`/`||`/`;`/`|` segment (`commandKeys(command).length === 1`);
 *   2. no raw newline (`\n` / `\r`) — the scanner splits on them
 *      (`scan.ts:590,710`), so a multi-line input is several commands;
 *   3. no `&` AT ALL — a bare `&` backgrounds (the scanner splits there
 *      too), and this is deliberately conservative: `2>&1` and `&>file`
 *      are single commands the scanner does NOT fragment, yet they are
 *      left unwrapped. That fails safe (the normal permission flow asks,
 *      exactly as today), where wrapping them would strand the user with
 *      an unrecognizable bwrap prompt.
 *
 * @param {string} command
 * @returns {boolean}
 */
function isSimpleCommand(command) {
  if (typeof command !== "string") return false
  if (commandKeys(command).length !== 1) return false
  if (SCANNER_SEPARATORS.test(command)) return false
  if (command.includes("&")) return false
  return true
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
   * Returns `{ kind: "wrap" }` only for a simple, predicted-ask command
   * that clears the eligibility chain; every other path is
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

      // Step 1 — simple commands only: anything the shell SCANNER would
      // fragment follows the normal permission flow unwrapped, because
      // both the prediction (rules evaluated on the exact command text)
      // and the wrapped-resource exact match degrade the moment the
      // command is more than one command. `&&`/`||`/`;`/`|` AND a raw
      // newline AND any `&` (background, or the `2>&1` redirect — the
      // conservative direction) are all out of scope.
      if (!isSimpleCommand(command)) return { kind: "skip" }

      // Step 2 — predict the permission outcome locally. A failed
      // prediction (loadRules not ok) is the status quo: skip. A
      // predicted deny or allow is the harness's to enforce: skip with NO
      // runtime/classifier calls.
      const loaded = await ruleLoader.loadRules(raw.ctx, raw.sessionID, raw.agentID)
      if (loaded?.ok !== true) return { kind: "skip" }
      const predicted = predictPermission({ rules: loaded.rules, action: "shell", command })
      if (predicted !== "ask") return { kind: "skip" }

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
