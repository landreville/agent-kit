/**
 * The OpenCode `sandbox` plugin entry — hook wiring and lifecycle. Wires
 * the finished modules together on the three v2 hook points (verified
 * order per shell command: tool.execute.before → shell.create.before →
 * permission.evaluate → spawn — so execute.before is the only hook that
 * runs BEFORE the permission outcome exists):
 *
 *   ctx.tool.hook("execute.before")   — decide + wrap: policy.js's gate
 *                                       PREDICTS the permission outcome
 *                                       from the local rules and runs the
 *                                       eligibility chain; on "wrap" the
 *                                       wiring rewrites
 *                                       `event.input.command` to
 *                                       SandboxManager's wrapped string
 *   ctx.permission.hook("evaluate")   — recognize, don't decide: a
 *                                       resource that exact-matches a
 *                                       wrapped string this plugin
 *                                       produced flips to `allow` (the
 *                                       decision was made pre-wrap on the
 *                                       original command); otherwise the
 *                                       gate's stashed message (per call
 *                                       id) is surfaced. Shell-action
 *                                       events ONLY (prepare asks
 *                                       external_directory first, under
 *                                       the same call id) and never from
 *                                       a `deny` (the flip only answers
 *                                       an ask). Never flips otherwise.
 *   ctx.tool.hook("execute.after")    — observation + consent: the gate's
 *                                       `noteGranted(event.id)` proves an
 *                                       install consent ask was granted
 *                                       (fires the background install),
 *                                       then violations.js's attribution,
 *                                       failure memory, and result
 *                                       annotation
 *
 * FAILURE DIRECTION (the plugin's invariant): an error anywhere in a hook
 * body is logged and swallowed — the session is never broken, and a hook
 * body never rejects. Every failure path fails toward the STATUS QUO: a
 * command the plugin could not wrap runs exactly as the permissions grant
 * it (the ask reaches the human). There is no v1 fail-closed stub: in v2
 * the plugin never flipped a permission for an unwrapped command, so
 * there is no plugin-granted allow to honor — leaving the input untouched
 * is the whole failure semantics.
 *
 * EXECUTE.BEFORE ORDER IS LOAD-BEARING: `event.input.command = wrapped`
 * is the LAST mutation. `gate.recordAttempt` and `after.begin` fire only
 * once the wrapped string exists (a failed or barren wrap counts no
 * attempt and registers no run), and any throw before the assignment
 * leaves the input untouched. The ORIGINAL command text is captured
 * before the rewrite: `after.begin` (dual-indexed under the original text
 * AND the wrapped string) and `gate.recordAttempt` key on it — the
 * wrapped string must never become a gate state key.
 *
 * THE WRAP'S SHELL AND CWD: `wrapWithSandbox`'s binShell is `undefined` —
 * the library's default shell; v1's per-command `event.shell` died with
 * the shell hook. The cwd is `ctx.location.directory` (the session's
 * location); per-command workdir overrides (`input.workdir`) are not
 * honored in v2 — a command with an explicit workdir outside the location
 * gets the location-scoped sandbox (fails safe: writes outside the
 * location are denied, the command fails, the retry asks).
 *
 * `createSetup(overrides)` is the test seam: the module factories
 * (runtime, gate, classifier, after handler), the commandId minter, and
 * the logger are injectable; the default export wires the real ones, so
 * it stays production-real. `pluginDir` is derived from import.meta.url —
 * the consented npm install targets the plugin's own directory. The
 * plugin imports no package itself: runtime.js is the only touchpoint
 * with `@anthropic-ai/sandbox-runtime`, so this entry loads while the
 * package is absent (the consent-install flow's prerequisite).
 */

import { randomBytes } from "node:crypto"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveOptions, buildCustomConfig, isUnsandboxedInvocation, stripUnsandboxed } from "./config.js"
import { createRuntime } from "./runtime.js"
import { createClassifier } from "./classifier.js"
import { createGate } from "./policy.js"
import { createAfterHandler, isShellTool } from "./violations.js"

/** The plugin's own directory — the consented install's cwd. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Create the plugin's `setup(ctx)`. With no overrides the real modules
 * are wired; tests inject fakes that record call order.
 *
 * @param {{
 *   createRuntime?: typeof createRuntime,
 *   createGate?: typeof createGate,
 *   createClassifier?: typeof createClassifier,
 *   createAfterHandler?: typeof createAfterHandler,
 *   randomId?: () => string,
 *   log?: (m: string) => void,
 * }} [overrides] test injection; `randomId` defaults to
 *   `randomBytes(16).toString("base64url")` (the 128-bit attribution id).
 * @returns {(ctx: Object) => Promise<(() => Promise<void>) | undefined>}
 */
export function createSetup(overrides) {
  const newRuntime =
    typeof overrides?.createRuntime === "function" ? overrides.createRuntime : createRuntime
  const newGate = typeof overrides?.createGate === "function" ? overrides.createGate : createGate
  const newClassifier =
    typeof overrides?.createClassifier === "function"
      ? overrides.createClassifier
      : createClassifier
  const newAfter =
    typeof overrides?.createAfterHandler === "function"
      ? overrides.createAfterHandler
      : createAfterHandler
  const randomId =
    typeof overrides?.randomId === "function"
      ? overrides.randomId
      : () => randomBytes(16).toString("base64url")
  const log = typeof overrides?.log === "function" ? overrides.log : (m) => console.warn(m)

  return async function setup(ctx) {
    const options = resolveOptions(ctx.options ?? {})
    if (!options.enabled) return // no registrations — the plugin is inert

    const runtime = newRuntime({ pluginDir: PLUGIN_DIR })
    const classifier = newClassifier(ctx, options.classifier)
    const gate = newGate({ options, runtime, classifier })
    const after = newAfter({ store: () => runtime.store(), gate, log })

    /** The session-location cwd the wrap is scoped to (per-command workdir
     * overrides are not honored in v2 — see the module header). */
    const sessionCwd = () =>
      typeof ctx?.location?.directory === "string" && ctx.location.directory !== ""
        ? ctx.location.directory
        : process.cwd()

    /**
     * Decide + wrap. The gate predicts the permission outcome for the
     * ORIGINAL command and runs the eligibility chain; only on
     * `{ kind: "wrap" }` does the wiring produce the sandboxed string and
     * rewrite `event.input.command` — as the LAST mutation, so any
     * failure (decide skip/error, availability not ok, no module, a
     * throwing or barren wrap) leaves the input untouched and the rules
     * decide normally (the status quo; there is no plugin-granted allow
     * to honor in v2). The availability re-check is memoized in the
     * runtime (the gate's identical call probed first) — it is a
     * defense-in-depth re-read, never a second probe, and it carries the
     * SAME input the gate passes (`{ options, requireSeccomp:
     * options.requireSeccomp }`) so the two can never disagree: a
     * re-check that dropped `requireSeccomp` would call an unreachable
     * sandbox available and let it degrade mid-session (M-4). Never
     * throws.
     */
    async function executeBeforeHook(event) {
      try {
        if (!isPlainObject(event)) return
        if (!isShellTool(event.tool)) return
        const input = isPlainObject(event.input) ? event.input : undefined
        if (!input || typeof input.command !== "string") return
        const command = input.command // the ORIGINAL text: begin/recordAttempt key on it

        // Agent-intentional escape hatch: a command (or any segment of a
        // compound) prefixed with `unsandboxed --` skips the sandbox and
        // runs through the normal permission flow (prompting the user). The
        // marker is stripped so the underlying command executes unchanged.
        if (isUnsandboxedInvocation(command)) {
          input.command = stripUnsandboxed(command)
          return
        }

        const decision = await gate.decide({
          command,
          ctx,
          sessionID: event.sessionID,
          agentID: event.agent,
          callID: event.id,
        })
        if (decision?.kind !== "wrap") return

        const ready = await runtime.availability({ options, requireSeccomp: options.requireSeccomp })
        if (!ready || ready.ok !== true) return

        const mod = await runtime.load()
        if (!mod || typeof mod.SandboxManager?.wrapWithSandbox !== "function") return

        const cwd = sessionCwd()
        const commandId = randomId()
        const wrapped = await mod.SandboxManager.wrapWithSandbox(
          command,
          undefined, // the library's default shell (v1's per-command shell died with the shell hook)
          buildCustomConfig(options, { cwd }),
          undefined,
          { commandId, commandText: command },
        )
        if (typeof wrapped !== "string") return
        // Defense-in-depth for the recognition invariant: a wrap that
        // returned the command verbatim would index the ORIGINAL text in
        // the wrapped set and let evaluate flip an unwrapped command to
        // allow. Leave it to the permissions instead.
        if (wrapped === command) {
          log(`[sandbox] wrap returned the command verbatim — leaving it to the permissions`)
          return
        }

        gate.recordAttempt(command)
        after.begin(command, { commandId, cwd, wrapped })
        // The LAST mutation: everything above leaves the input untouched.
        input.command = wrapped
      } catch (err) {
        try {
          log(
            `[sandbox] execute.before hook error — leaving the command to the permissions: ${err?.message ?? String(err)}`,
          )
        } catch {
          /* the logger must not break the hook either */
        }
      }
    }

    /**
     * Recognize, don't decide. GATED ON THE SHELL ACTION: the shell
     * tool's `prepare` evaluates the `external_directory` ask BEFORE the
     * shell ask, both under the SAME `source.id`
     * (`packages/core/src/tool/plugin/file-access.ts:125-142`, then
     * `shell.ts:138`), so only the action that actually carries the
     * command may run this hook — otherwise the external_directory
     * evaluate would consume the message stash (it deletes on read) and
     * the shell ask the user answers would be silent. Every other action
     * is a strict no-op here.
     *
     * A resource that exact-matches a wrapped string this plugin
     * produced flips to `allow` — the decision was made pre-wrap on the
     * original command, and the headless runner auto-rejects asks, so
     * the flip is mandatory for wrapped commands to run at all. NEVER
     * from a `deny`: a deny rule matching the WRAPPED resource (the
     * user's `"shell": { "bwrap *": "deny" }`) or another plugin's deny
     * is final; the flip only answers an `ask`. Otherwise the gate's
     * stashed message for this call id (the one-time unavailable
     * message, the classifier's UNSAFE reason, the install consent) is
     * surfaced on the ask. Never flips a command the plugin did not
     * wrap; never throws.
     */
    async function evaluateHook(event) {
      try {
        if (!isPlainObject(event)) return
        if (event.action !== "shell") return // only the shell action carries the command
        if (event.effect === "deny") return // never fight a deny — the flip only answers an ask
        const source = isPlainObject(event.source) ? event.source : undefined
        if (source?.type !== "tool") return
        const resources = Array.isArray(event.resources) ? event.resources : []
        if (resources.some((resource) => after.isWrapped(resource))) {
          event.effect = "allow"
          return
        }
        const stash = gate.messageFor(source.id)
        if (stash && typeof stash.message === "string" && stash.message !== "") {
          event.message = stash.message
        }
      } catch (err) {
        try {
          log(
            `[sandbox] evaluate hook error — leaving the decision to the permissions: ${err?.message ?? String(err)}`,
          )
        } catch {
          /* the logger must not break the hook either */
        }
      }
    }

    /**
     * Observation + consent. Only a COMPLETED run proves the ask was
     * granted: a rejected or auto-rejected call also fires
     * execute.after — with `status: "error"`, the command never spawned
     * (Task 1's probe archive) — so `noteGranted` is gated on
     * `status === "completed"`. It is gated on the SHELL TOOL as well
     * (M-1): the consent was stashed by the shell tool's decide, so only
     * a completed shell call can prove it — the scanner can reduce a
     * command (a comment-only one, say) to zero commands, in which case
     * no shell ask is ever shown and the consented install must never
     * fire on an unrelated completed event. With no consent pending for
     * the call id it is a no-op; with one, it clears the consent and
     * fires the background install. The consequence is deliberate: a
     * consent whose command was approved but then FAILED does not
     * install, and the surviving consent makes the next decide infer a
     * decline — the safe direction for a consent mechanism. Then the
     * after handler attributes violations, records sandbox-caused
     * failures under the original command text, and annotates the
     * result. Each dep is guarded separately so a broken one cannot keep
     * the other from running; never throws.
     */
    async function executeAfterHook(event) {
      try {
        if (event?.status === "completed" && isShellTool(event?.tool)) gate.noteGranted(event?.id)
      } catch (err) {
        try {
          log(`[sandbox] noteGranted error: ${err?.message ?? String(err)}`)
        } catch {
          /* the logger must not break the hook either */
        }
      }
      try {
        await after.handleAfter(event)
      } catch (err) {
        try {
          log(`[sandbox] execute.after hook error: ${err?.message ?? String(err)}`)
        } catch {
          /* the logger must not break the hook either */
        }
      }
    }

    // Register the three hooks and keep the registrations. The cleanup
    // deliberately does NOT unregister them — the host owns the hook
    // lifetimes; the plugin's only teardown is the manager reset. There
    // is NO shell.create.before registration: the v1 verdict/enforcement
    // split is gone with the verdict mechanism.
    const registrations = [
      ctx.tool.hook("execute.before", executeBeforeHook),
      ctx.permission.hook("evaluate", evaluateHook),
      ctx.tool.hook("execute.after", executeAfterHook),
    ]

    return async () => {
      // runtime.reset() inside try/catch, and nothing else (the
      // registrations above stay held by this closure).
      try {
        await runtime.reset()
      } catch (err) {
        try {
          log(`[sandbox] cleanup: sandbox reset failed: ${err?.message ?? String(err)}`)
        } catch {
          /* the logger must not break the cleanup either */
        }
      }
    }
  }
}

export default { id: "sandbox", setup: createSetup() }
