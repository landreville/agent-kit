/**
 * Local permission-rule prediction for the OpenCode `sandbox` plugin's v2
 * reorder. The wrap decision moved to `tool.execute.before`, which fires
 * BEFORE OpenCode's permission decision exists for the command — so the
 * plugin must predict that outcome LOCALLY from the effective rules to
 * preserve the spec's core invariant: only would-ask commands get
 * sandboxed. An allow-listed command wrapped anyway would run behind the
 * plugin's own allow instead of the user's rule, and a denied command
 * would burn a sandbox attempt on an execution the rules will refuse
 * anyway. (`srt --` self-sandboxing and `excludedCommands` stay the
 * deliberate escape hatches, enforced downstream in the gate.)
 *
 * The semantics mirror OpenCode core EXACTLY, function by function:
 *
 *   - `wildcardMatch` mirrors `packages/core/src/util/wildcard.ts` `match`.
 *   - `evaluateRule` mirrors `packages/core/src/permission.ts:87-101`
 *     `evaluate` (the effect of the last rule whose action AND resource
 *     both match; no match → `"ask"`).
 *   - `predictPermission` collapses `evaluateInput`'s decision
 *     (`permission.ts:173-189`: any resource denied → deny, else any ask
 *     → ask, else allow) to one resource per SEGMENT of the command — a
 *     simple command's evaluate resources are exactly `[command]`
 *     (probe-verified), and a compound command is predicted over every
 *     segment segments.js emits (see policy.js step 1); predicting deny
 *     on any segment is enough to skip, predicting ask on any is enough
 *     to consider wrapping. v2 is no longer simple-commands-only: compound
 *     commands are supported whenever the segmenter accepts the shape.
 *   - `loadRules` mirrors `configured` (`permission.ts:158-163`): agent
 *     rules first, session rules appended (`merge` = flatten,
 *     `permission.ts:99-101`) — last match wins, so session rules
 *     override same-pattern agent rules; an agent that resolves with NO
 *     permissions array gets core's `missingAgentPermissions` default
 *     deny-everything ruleset (`permission.ts:19`).
 *
 * The distinction `loadRules` keeps from core: a RESOLVED agent without
 * permissions is the default-deny ruleset (core's `agent?.permissions ??
 * missingAgentPermissions`), while a THROWING ctx — the adapter's failure
 * channel, core's equivalent Effect failure — returns `{ ok: false }` and
 * the caller falls back to the real permission flow (status quo; nothing
 * is ever wrapped on a failed prediction).
 *
 * Known drift, accepted by the plan: core appends the project's SAVED
 * approvals to the rules at evaluate time (`permission.ts:176`,
 * `[...rules, ...savedRules()]`); this prediction sees only the
 * CONFIGURED rules (agent + session), so a saved-approved command can be
 * predicted `ask` and wrapped. The drift direction is the safe one (a
 * sandboxed run the user already approved once), and it is documented in
 * the README (Task 5).
 *
 * A SECOND drift channel (deferred item 1c): the `permission.evaluate`
 * PLUGIN hook. Another plugin's evaluate hook can shift the real effect
 * of an ask AFTER this plugin's prediction has already wrapped the
 * command. Direction, concretely: an ask→allow hook wraps an
 * already-allowed command (safe — the wrap is behaviour-neutral for an
 * allowed command), and an ask→deny hook at worst wastes one sandbox
 * attempt (the wrapped command is denied, and the retry follows the
 * normal flow). Neither direction breaks the user's rules, which is why
 * the channel is documented rather than defended against here.
 *
 * STATE IS PER PLUGIN INSTANCE (Important 3): the agent-ruleset cache
 * lives on a LOADER (`createRuleLoader()`), never on the module. A config
 * edit rebuilds the plugin INSTANCE inside the same process while leaving
 * the ESM module state untouched, so a module-scope cache would keep
 * predicting against stale rules for the rest of the session — a new deny
 * rule would be invisible (and, with the recognizer forced to never flip
 * a deny, a deny bypass). policy.js's `createGate` therefore owns one
 * loader per gate, and session rules are never cached at all.
 *
 * Totality: `loadRules` NEVER rejects — any throw, anywhere, becomes
 * `{ ok: false, reason }` — and admits only well-formed rules, so nothing
 * downstream of it can throw on garbage. `wildcardMatch` / `evaluateRule`
 * / `predictPermission` mirror core and trust their inputs like core
 * does (a non-string input throws, exactly as core's would); the plugin
 * calls them inside hook bodies whose own error direction is the status
 * quo.
 */

/** A permission rule — the shape OpenCode's schema guarantees upstream.
 * `loadRules` admits only entries of this shape.
 *
 * @typedef {object} Rule
 * @property {string} action
 * @property {string} resource
 * @property {"allow" | "ask" | "deny"} effect
 */

/** Core's `missingAgentPermissions` verbatim
 * (packages/core/src/permission.ts:19): the ruleset an agent that
 * resolves without a permissions array evaluates under — deny
 * everything. */
const MISSING_AGENT_PERMISSIONS = [{ action: "*", resource: "*", effect: "deny" }]

/** The valid effects (schema-constrained upstream; `loadRules` filters to
 * these so downstream matching can never see a malformed one). */
const EFFECTS = new Set(["allow", "ask", "deny"])

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A well-formed rule: plain object, string action and resource, valid
 * effect. Core guarantees this via its schema and would THROW on a
 * malformed rule at match time (`Wildcard.match` on a non-string
 * pattern); the plugin must never be able to break a hook, so malformed
 * entries are dropped at the source instead — `loadRules` admits only
 * entries of this shape. */
function isRule(value) {
  return (
    isPlainObject(value) &&
    typeof value.action === "string" &&
    typeof value.resource === "string" &&
    EFFECTS.has(value.effect)
  )
}

/** A safe non-empty reason string for the failure result — never throws,
 * so the catch itself cannot become a second failure. */
function messageOf(err) {
  try {
    const message = err?.message
    if (typeof message === "string" && message !== "") return message
    return String(err)
  } catch {
    return "loading permission rules failed"
  }
}

/**
 * Faithful mirror of core's matcher (`packages/core/src/util/wildcard.ts`,
 * `match`): backslashes become slashes on BOTH the input and the pattern
 * (a backslash is a path separator, never a regex escape); every regex
 * metacharacter in the pattern is escaped except `*` (→ `.*`) and `?`
 * (→ `.`); a pattern ending in ` *` — post-substitution ` .*` — also
 * matches the bare prefix (`git status *` matches `git status` as well
 * as `git status --short`, but not `git statusx`); the result is anchored
 * `^...$` and compiled with flag `s` so `.` spans newlines. Core's `i`
 * (case-insensitive) is win32-only and deliberately omitted here — the
 * plugin targets POSIX.
 *
 * @param {string} input the value being matched (an action or resource)
 * @param {string} pattern the rule's pattern
 * @returns {boolean}
 */
export function wildcardMatch(input, pattern) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", "s").test(normalized)
}

/**
 * Mirror of core's `evaluate` (`packages/core/src/permission.ts:87-101`):
 * the LAST rule whose action AND resource BOTH match (each through
 * `wildcardMatch`) wins; no match → the default effect `"ask"` (core's
 * fallback rule `{ action, resource: "*", effect: "ask" }`). Returns the
 * effect only — the prediction needs nothing else from the rule.
 *
 * Hardening over core (which trusts its schema): a non-array ruleset
 * reads as empty and malformed entries are skipped, so evaluation never
 * throws on garbage; for schema-valid rulesets the two are
 * indistinguishable.
 *
 * @param {string} action
 * @param {string} resource
 * @param {readonly Rule[]} rules
 * @returns {"allow" | "ask" | "deny"}
 */
export function evaluateRule(action, resource, rules) {
  const list = Array.isArray(rules) ? rules : []
  let matched
  for (const rule of list) {
    if (isRule(rule) && wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource)) {
      matched = rule
    }
  }
  return matched ? matched.effect : "ask"
}

/**
 * The pre-permission prediction for ONE simple command — core's
 * `evaluateInput` decision (`permission.ts:173-189`: any resource denied
 * → deny; else any resource asking → ask; else allow) collapsed to the
 * single resource a simple command evaluates to (probe-verified: exactly
 * `[command]`). A predicted `deny` or `allow` means the command is not
 * the plugin's to wrap — the rules already decided it; a predicted `ask`
 * is the wrap candidate.
 *
 * An effect outside the three (impossible via `loadRules`, which filters
 * to valid effects) reads as `"ask"` — the direction that engages the
 * eligibility chain, whose own failures fall back to the status quo, so
 * neither containment nor the user's rules can be silently broken.
 *
 * @param {{ rules: readonly Rule[], action: string, command: string }} input
 * @returns {"allow" | "ask" | "deny"}
 */
export function predictPermission({ rules, action, command }) {
  const effect = evaluateRule(action, command, rules)
  if (effect === "deny") return "deny"
  if (effect === "allow") return "allow"
  return "ask"
}

/**
 * Create a rule loader: the PREDICTION's stateful half, owning the
 * agent-ruleset cache. One loader per plugin instance (policy.js's
 * `createGate` creates and owns exactly one and passes it into its
 * `loadRules` calls) — see the module header on why the cache must not
 * outlive one plugin instance. Session rules are NOT cached: only an
 * explicit `session.update({ permissions })` ever sets them, at runtime.
 *
 * @returns {{
 *   loadRules(
 *     ctx: Object,
 *     sessionID: string,
 *     agentID: string,
 *   ): Promise<{ ok: true, rules: Rule[] } | { ok: false, reason: string }>,
 * }} the loader — its `loadRules(ctx, sessionID, agentID)` keeps the
 *   standalone function's signature
 */
export function createRuleLoader() {
  /** agentID → Rule[] — this loader's rulesets, already resolved. Scoped
   * to the instance, so a config edit that rebuilds the plugin (without
   * rebuilding the ESM module) re-reads the agent rules from scratch. */
  const agentRulesCache = new Map()

  /**
   * Load the effective rules for a session — core's `configured`
   * (`permission.ts:158-163`) over the probe-verified ctx shapes: the
   * agent ruleset at `ctx.agent.get({ agentID }).data.permissions` (base
   * policy first, the user's config rules appended; ~220 entries for the
   * `build` agent), the session's runtime rules at
   * `ctx.session.get({ sessionID }).permissions` — normally ABSENT (the
   * field is optional and only `session.update({ permissions })` sets it)
   * → `[]`. Final rules = `[...agentRules, ...sessionRules]`: agent
   * first, session appended — last match wins, so session rules override
   * same-pattern agent rules.
   *
   * The agent ruleset is resolved once per agentID and cached FOR THIS
   * LOADER (a config edit rebuilds the plugin, and with it a fresh loader
   * with a cold cache); the session rules are fetched fresh on every call.
   * Every returned array is a fresh copy — a caller can never mutate the
   * cache. Malformed entries are dropped at the source.
   *
   * NEVER rejects: any throw — a rejecting or throwing `agent.get` /
   * `session.get`, a missing ctx namespace, a null ctx — returns
   * `{ ok: false, reason }` and leaves the decision to the real permission
   * flow. A resolved agent with no permissions array is NOT a failure: it
   * gets the default-deny ruleset (`ok: true`), mirroring core.
   *
   * @param {{
   *   agent: { get(input: { agentID: string }): Promise<{ location: unknown, data: { permissions?: unknown } }> },
   *   session: { get(input: { sessionID: string }): Promise<{ permissions?: unknown }> },
   * }} ctx the plugin ctx
   * @param {string} sessionID
   * @param {string} agentID
   * @returns {Promise<{ ok: true, rules: Rule[] } | { ok: false, reason: string }>}
   */
  async function loadRules(ctx, sessionID, agentID) {
    try {
      let agentRules = agentRulesCache.get(agentID)
      if (agentRules === undefined) {
        const result = await ctx.agent.get({ agentID })
        const raw = result?.data?.permissions
        agentRules = Array.isArray(raw) ? raw.filter(isRule) : [...MISSING_AGENT_PERMISSIONS]
        agentRulesCache.set(agentID, agentRules)
      }
      const session = await ctx.session.get({ sessionID })
      const sessionRules = Array.isArray(session?.permissions) ? session.permissions.filter(isRule) : []
      return { ok: true, rules: [...agentRules, ...sessionRules] }
    } catch (err) {
      return { ok: false, reason: messageOf(err) }
    }
  }

  return { loadRules }
}
