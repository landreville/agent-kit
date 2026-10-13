import type { RuleDef } from "./config"
import type { ActionRequest, Decision, Kind, Tier } from "./types"
import { globMatch } from "./glob"
import { evaluateRules } from "./rules/engine"
import { parseBash, carriesInlineCode, isInterpreter, SHELLS, WRAPPERS } from "./bash"

export function normalizePattern(p: string): string { return p.replace(/[ \t]+/g, " ").trim() }

/**
 * C1: a session glob may not start with anything that runs other code: shells, eval/source,
 * wrappers (sudo, env, xargs, timeout, ...), find, or an interpreter.
 */
const GLOB_FORBIDDEN_FIRST = new Set([...SHELLS, ...Object.keys(WRAPPERS), "eval", "source", ".", "find", "sudo", "su", "srt", "script", "exec", "busybox"])
function forbiddenFirstToken(t: string): boolean {
  const name = t.includes("/") ? t.slice(t.lastIndexOf("/") + 1) : t
  return GLOB_FORBIDDEN_FIRST.has(name) || isInterpreter(name)
}

/** Sorted-key JSON; anything unserializable gets a unique key so it is never shared. */
function stableJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x) ?? ""
  } catch { return `unserializable:${Math.random()}` }
}

/** C3: the permission type (server/tool for mcp) scopes both exact entries and globs. */
function scopeOf(req: ActionRequest): string {
  if (req.mcp) return `mcp:${req.mcp.server}__${req.mcp.tool}`
  return `${req.kind}:${req.permType ?? req.kind}`
}

interface SessionStore { exact: Map<string, Decision>; globs: { glob: string; kind: Kind; scope: string; decision: Decision }[] }

export interface CacheHit { decision: Decision; via: "exact" | "glob" }

export class SessionCache {
  private sessions = new Map<string, SessionStore>()
  private readonly max: number
  constructor(private opts: { rules: RuleDef[]; homedir: string; sessionPatterns: boolean; maxPerSession?: number }) { this.max = opts.maxPerSession ?? 500 }

  /** Exact key: scope + pattern, plus the tool arguments for mcp (the pattern is often "" or "*"). */
  private key(req: ActionRequest): string {
    const k = `${scopeOf(req)}\0${normalizePattern(req.pattern)}`
    return req.mcp ? `${k}\0${stableJson(req.metadata ?? {})}` : k
  }
  private store(id: string): SessionStore {
    let s = this.sessions.get(id)
    if (!s) { s = { exact: new Map(), globs: [] }; this.sessions.set(id, s) }
    return s
  }

  lookup(req: ActionRequest): Decision | undefined { return this.lookupHit(req)?.decision }

  lookupHit(req: ActionRequest): CacheHit | undefined {
    const s = this.sessions.get(req.sessionID)
    if (!s) return undefined
    const k = this.key(req)
    const exact = s.exact.get(k)
    if (exact) { s.exact.delete(k); s.exact.set(k, exact); return { decision: { ...exact, settledBy: "cache" }, via: "exact" } }
    if (!this.opts.sessionPatterns) return undefined
    // Globs only satisfy single, fully-parsed commands so "npm test *" never covers "npm test && rm -rf /".
    if (req.kind === "bash" && (req.opaque || (req.commands?.length ?? 0) !== 1 || req.commands![0]!.redirects.length > 0)) return undefined
    // I6: never let a glob cover inline code (bash -c, python -c, find -exec, ...).
    if (req.kind === "bash" && req.commands!.some(carriesInlineCode)) return undefined
    const norm = normalizePattern(req.pattern)
    const scope = scopeOf(req)
    for (let i = s.globs.length - 1; i >= 0; i--) {
      const g = s.globs[i]!
      if (g.kind === req.kind && g.scope === scope && globMatch(g.glob, norm)) {
        return { decision: { ...g.decision, settledBy: "cache", reason: `${g.decision.reason} (session pattern ${g.glob})` }, via: "glob" }
      }
    }
    return undefined
  }

  remember(req: ActionRequest, d: Decision): void {
    if (d.status === "ask") return
    // I3: denies are never cached. A judge deny must not block a later explicit user approval,
    // and rule denies are re-derived on every request anyway.
    if (d.status === "deny") return
    const s = this.store(req.sessionID)
    s.exact.set(this.key(req), d)
    while (s.exact.size > this.max) { const oldest = s.exact.keys().next().value; if (oldest === undefined) break; s.exact.delete(oldest) }
    if (d.status === "allow" && d.sessionPattern && this.opts.sessionPatterns && this.validateGlob(d.sessionPattern, req.kind, req)) {
      s.globs.push({ glob: normalizePattern(d.sessionPattern), kind: req.kind, scope: scopeOf(req), decision: { ...d, sessionPattern: undefined } })
      if (s.globs.length > this.max) s.globs.shift()
    }
  }

  dropSession(id: string): void { this.sessions.delete(id) }

  validateGlob(glob: string, kind: Kind, req: ActionRequest): boolean {
    const tokens = normalizePattern(glob).split(" ").filter(Boolean)
    if (tokens.length < 2) return false
    const isWild = (t: string) => t.includes("*") || t.includes("?")
    if (isWild(tokens[0]!)) return false
    if (tokens.filter((t) => !isWild(t)).length < 2) return false
    if (kind !== "bash") return true
    if (forbiddenFirstToken(tokens[0]!)) return false
    if (!globMatch(normalizePattern(glob), normalizePattern(req.pattern))) return false
    const firstWild = tokens.findIndex(isWild)
    const literalPrefix = tokens.slice(0, firstWild === -1 ? tokens.length : firstWild).join(" ")
    const probes = [literalPrefix, ...["/", "~", "../..", "/etc/x"].map((v) => tokens.map((t) => t.replaceAll("*", v)).join(" "))]
    for (const pattern of probes) {
      const probe = parseBash(pattern)
      const fake: ActionRequest = { ...req, pattern, commands: probe.commands, opaque: probe.opaque }
      if (evaluateRules(fake, this.opts.rules, this.opts.homedir) !== undefined) return false
    }
    return true
  }
}

export function cacheTier(cache: SessionCache): Tier {
  return async (req, env) => {
    const hit = cache.lookupHit(req)
    env.trace.cache = { hit: hit?.via ?? null }
    return hit?.decision
  }
}
