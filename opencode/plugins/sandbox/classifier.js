/**
 * The optional `litellm/jev-1.13` command pre-classifier for the OpenCode
 * `sandbox` plugin: before the permission gate flips an `ask`-listed shell
 * command into the sandbox, it asks a small model whether the command would
 * SUCCEED inside the sandbox's policy. `SAFE` (it would) lets the sandbox
 * attempt proceed — which can only fail into the permission ask afterwards;
 * `UNSAFE` (it would be blocked — denied network, writes outside the roots,
 * or reads of denied paths) skips the sandbox and leaves the decision to
 * the human.
 *
 * OPT-IN: default `{ enabled: false, providerID: "litellm", id: "jev-1.13" }`
 * (config.js's resolveOptions produces exactly that block); a disabled
 * classifier answers `SAFE` without touching `ctx.generate`.
 *
 * Fail TOWARD the sandbox attempt: any thrown error, empty answer, or
 * unparseable garbage parses to `{ verdict: "SAFE" }` — a sandboxed failure
 * can only escalate to a permission ask, never to a silent unsandboxed
 * run, so `SAFE` is the direction that cannot silently break containment.
 *
 * Verdicts are cached by command text for the classifier's lifetime,
 * TTL-free (a session is short, and the plugin — this classifier with it —
 * re-loads on config change). Failed generate calls are NOT cached, so a
 * recovered gateway is re-asked on the next attempt. Nothing here can
 * throw: the classifier must never be able to break the permission hook.
 */

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** An array of strings; a non-array or malformed entries are dropped.
 * Never throws. */
function stringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === "string")
}

/** One policy list for the prompt: the entries comma-joined, or `none`
 * when the list is empty (an empty allowedDomains means all network is
 * denied — the prompt must say so, not fall silent). */
function list(entries) {
  return entries.length > 0 ? entries.join(", ") : "none"
}

/**
 * The classifier's prompt: the exact sandbox policy the command would run
 * under (allowed network domains, writable paths, denied reads — "none"
 * when a list is empty), the command itself, the precise question — would
 * this command SUCCEED inside that sandbox — and the demanded strict
 * machine-checkable first line, `SAFE` or `UNSAFE: <one-line reason>`.
 * Reads outside the working directory are ALLOWED by policy, so the prompt
 * says so: they do not make a command unsafe; only denied network, writes
 * outside the roots, or reads of denied paths do.
 *
 * @param {string} command
 * @param {{ allowedDomains: string[], writeRoots: string[], deniedReads: string[] }} policy
 * @returns {string}
 */
export function buildPrompt(command, policy) {
  const p = isPlainObject(policy) ? policy : {}
  const cmd = typeof command === "string" ? command : String(command ?? "")
  return [
    "A shell command is about to run inside a sandbox. Decide whether the command would SUCCEED inside it.",
    "",
    "Sandbox policy the command would run under:",
    `- Network: only these domains may be contacted, all other network access is denied: ${list(stringArray(p.allowedDomains))}`,
    `- Writes: only these paths may be written, writes anywhere else are denied: ${list(stringArray(p.writeRoots))}`,
    `- Reads: reading these paths is denied: ${list(stringArray(p.deniedReads))}`,
    "- All other reads are ALLOWED: reading outside the working directory is allowed by policy and does NOT make a command unsafe.",
    "",
    "Command:",
    cmd,
    "",
    "Question: would this command SUCCEED inside that sandbox?",
    "It is UNSAFE only if it needs network to a domain not in the allowed list, writes outside the allowed paths, or reads a denied path.",
    "",
    "Answer with a strict machine-checkable first line, exactly one of:",
    "SAFE",
    "UNSAFE: <one-line reason>",
  ].join("\n")
}

/** The UNSAFE answer keyword: case-insensitive prefix of the first
 * non-empty line (the approved spec's parse rule). */
const UNSAFE_PREFIX = /^UNSAFE\b/i

/**
 * Parse a model answer: the first non-empty line; `/^UNSAFE\b/i` →
 * `{ verdict: "UNSAFE", reason }` with the rest of that line after the
 * keyword as the reason (an optional separating `:` stripped — the brief's
 * fixture pins the reason as `needs registry.npmjs.org`, no colon — and an
 * empty remainder omits the reason); anything else — a `SAFE` prefix or
 * garbage — → `{ verdict: "SAFE" }`. Never throws; a non-string is garbage.
 *
 * @param {string} text
 * @returns {{ verdict: "SAFE" | "UNSAFE", reason?: string }}
 */
export function parseVerdict(text) {
  const raw = typeof text === "string" ? text : ""
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "") ?? ""
  const unsafe = UNSAFE_PREFIX.exec(line)
  if (unsafe) {
    const reason = line
      .slice(unsafe[0].length)
      .trim()
      .replace(/^:\s*/, "")
      .trim()
    return reason === "" ? { verdict: "UNSAFE" } : { verdict: "UNSAFE", reason }
  }
  // A SAFE prefix and anything else both land SAFE — the spec's /^SAFE\b/i
  // branch is behaviorally indistinguishable from its fall-through.
  return { verdict: "SAFE" }
}

/**
 * Create the classifier. All model access goes through the given `ctx`
 * (`ctx.generate.text({ model: { providerID, id }, prompt })`, verified
 * against `@opencode/client@2.0.26`); tests inject a fake.
 *
 * @param {{ generate: { text(input: { model: { providerID: string, id: string }, prompt: string }): Promise<{ text: string }> } }} ctx
 * @param {{ enabled: boolean, providerID: string, id: string }} options the resolved classifier block (config.js's resolveOptions)
 * @param {{ log?: (m: string) => void }} [deps] test injection for the warning line
 * @returns {{ classify(command: string, policy: { allowedDomains: string[], writeRoots: string[], deniedReads: string[] }): Promise<{ verdict: "SAFE" | "UNSAFE", reason?: string }> }}
 */
export function createClassifier(ctx, options, deps) {
  const opts = isPlainObject(options) ? options : {}
  const enabled = opts.enabled === true
  const providerID = typeof opts.providerID === "string" ? opts.providerID : "litellm"
  const id = typeof opts.id === "string" ? opts.id : "jev-1.13"
  const log = typeof deps?.log === "function" ? deps.log : (m) => console.warn(m)

  /** Parsed verdicts by command text — TTL-free: a session is short, and
   * the plugin (this classifier with it) re-loads on config change. Keyed
   * by the command only, per the plan's interface. */
  const cache = new Map()

  /**
   * Classify one command against the policy it would run under. A disabled
   * classifier answers SAFE without calling generate; a cached verdict is
   * returned without calling generate; a failed generate answers SAFE
   * (fail toward the sandbox attempt) and is not cached; nothing here can
   * throw or reject with anything but a verdict.
   *
   * @param {string} command
   * @param {{ allowedDomains: string[], writeRoots: string[], deniedReads: string[] }} policy
   * @returns {Promise<{ verdict: "SAFE" | "UNSAFE", reason?: string }>}
   */
  async function classify(command, policy) {
    if (!enabled) return { verdict: "SAFE" }
    const key = typeof command === "string" ? command : String(command ?? "")
    const cached = cache.get(key)
    if (cached) return cached
    try {
      const res = await ctx.generate.text({
        model: { providerID, id },
        prompt: buildPrompt(command, policy),
      })
      const verdict = parseVerdict(typeof res?.text === "string" ? res.text : "")
      cache.set(key, verdict)
      return verdict
    } catch (err) {
      // Fail toward the sandbox attempt: a sandboxed failure can only
      // escalate to a permission ask, never to a silent unsandboxed run.
      // Not cached — a recovered gateway is re-asked on the next attempt.
      log(
        `[sandbox] classifier unavailable (${err?.message ?? String(err)}) — ` +
          `treating the command as sandbox-eligible`,
      )
      return { verdict: "SAFE" }
    }
  }

  return { classify }
}
