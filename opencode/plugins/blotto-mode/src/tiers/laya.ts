import type { Config, LayaQuestion } from "../config"
import type { ActionRequest, SessionContext, Status, Tier } from "../types"
import { activeQuestions } from "../laya-questions"
import { raceTimeout, TIMED_OUT } from "../context"

const STATE_CAP = 1800
export type LayaAnswer = { value: string | number | boolean; confidence: number; pTrue?: number }

export function renderState(req: ActionRequest, ctx: SessionContext): string {
  const users = ctx.userMessages.slice(-2).map((m) => m.length > 500 ? m.slice(0, 500) + "…" : m)
  const parts = [
    users.length ? "User said: " + users.map((u) => JSON.stringify(u)).join(" then ") : "User context unavailable.",
    ctx.assistantIntent ? "Agent intends: " + ctx.assistantIntent.slice(0, 200) : "",
    `Requested ${req.kind}: ${req.pattern}`,
    req.kind === "bash" && req.commands?.length ? "Commands: " + req.commands.map((c) => c.raw).join(" | ") : "",
    req.url ? `Host: ${req.url.hostname}` : "",
    req.path ? `Path: ${req.path}` : "",
  ].filter(Boolean)
  let s = parts.join("\n")
  if (s.length > STATE_CAP) s = s.slice(0, STATE_CAP - 1) + "…"
  return s
}

export function normalizeAnswers(raw: unknown, questions: LayaQuestion[]): Record<string, LayaAnswer> {
  const answers = (raw as any)?.answers ?? {}
  const out: Record<string, LayaAnswer> = {}
  for (const q of questions) {
    const a = answers[q.id]
    if (!a || typeof a !== "object") continue
    if (q.type === "noul") {
      let p = firstUnit(a.probability, a.p_true, a.pTrue, a.probabilities?.true)
      if (p === undefined && !hasAny(a.probability, a.p_true, a.pTrue, a.probabilities?.true)) {
        const c = unit(a.confidence)
        if (c !== undefined && c >= 0.5) {
          const label = typeof a.choice === "string" ? a.choice.toLowerCase() : typeof a.value === "boolean" ? String(a.value) : undefined
          if (label === "true") p = c
          else if (label === "false") p = 1 - c
        }
      }
      if (p === undefined) continue
      out[q.id] = { value: p >= 0.5, confidence: Math.max(p, 1 - p), pTrue: p }
    } else if (q.type === "choice") {
      if (typeof a.choice !== "string") continue
      if (a.confidence !== undefined && unit(a.confidence) === undefined) continue
      out[q.id] = { value: a.choice, confidence: unit(a.confidence) ?? unit(a.probabilities?.[a.choice]) ?? 0 }
    } else {
      const v = num(a.score) ?? num(a.expected) ?? num(a.value); if (v === undefined) continue
      out[q.id] = { value: v, confidence: num(a.confidence) ?? 0 }
    }
  }
  return out
}
function unit(v: unknown): number | undefined { return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined }
function hasAny(...vs: unknown[]): boolean { return vs.some((v) => v !== undefined) }
/** First present value, accepted only if it is a probability in [0,1]; an invalid first value drops the answer. */
function firstUnit(...vs: unknown[]): number | undefined { const first = vs.find((v) => v !== undefined); return unit(first) }
function num(v: unknown): number | undefined { return typeof v === "number" && Number.isFinite(v) ? v : undefined }

export function decide(answers: Record<string, LayaAnswer>, questions: LayaQuestion[], cfg: Config["laya"]): { status?: Status; fired: string[]; signals: string[]; reason: string } {
  const fired: string[] = [], signals: string[] = []
  let vetoDeny = false
  for (const q of questions) {
    const a = answers[q.id]; if (!a) continue
    const th = q.threshold ?? (q.role === "approve" ? 0.9 : q.role === "veto" ? 0.8 : 0.7)
    if (q.type === "noul" && (a.pTrue ?? 0) >= th) {
      if (q.role === "veto") { fired.push(q.id); if (q.allowDeny) vetoDeny = true }
      else if (q.role === "approve") fired.push(q.id)
      else if (q.role === "signal") signals.push(q.id)
    }
  }
  const vetoes = fired.filter((id) => questions.find((q) => q.id === id)?.role === "veto")
  const approves = fired.filter((id) => questions.find((q) => q.id === id)?.role === "approve")
  if (vetoes.length) return { status: vetoDeny && cfg.allowDeny ? "deny" : "ask", fired, signals, reason: `laya veto: ${vetoes.join(", ")}` }
  const missing = questions.filter((q) => q.role === "veto" && !answers[q.id]).map((q) => q.id)
  const incomplete = { fired, signals, reason: `laya incomplete: ${missing.join(", ")}` }
  if (approves.length) return missing.length ? incomplete : { status: "allow", fired, signals, reason: `laya approve: ${approves.join(", ")}` }
  const verdictQ = questions.find((q) => q.role === "verdict")
  const v = verdictQ && answers[verdictQ.id]
  if (v && v.value === "allow" && v.confidence >= cfg.verdictThreshold) return missing.length ? incomplete : { status: "allow", fired, signals, reason: `laya verdict allow (${v.confidence.toFixed(2)})` }
  return { fired, signals, reason: "laya pass" }
}

function toQuestions(questions: LayaQuestion[]) {
  return Object.fromEntries(questions.map((q) => [q.id, { type: q.type, instructions: q.instructions, criteria: q.criteria }]))
}

export async function probeLaya(cfg: Config["laya"], fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!cfg.baseUrl || cfg.mode === "off") return false
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), Math.max(cfg.timeoutMs * 10, 2000))
  try {
    const res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}/v1/systemone`, { method: "POST", signal: ctrl.signal, headers: headers(cfg), body: JSON.stringify({ state: { text: "ping" }, questions: { ok: { type: "noul", instructions: "Is this a ping?", criteria: { true: "ping", false: "other" } } } }) })
    return res.ok
  } catch { return false } finally { clearTimeout(t) } // M6: cleared on rejection too
}

function headers(cfg: Config["laya"]): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" }
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`
  return h
}

/**
 * `reachable` reports the startup probe. It may return the probe's promise (I4): the tier waits for it at
 * most timeoutMs; if it is still pending the tier skips this request without warning or marking the session.
 */
export function layaTier(opts: { cfg: Config["laya"]; fetchImpl?: typeof fetch; reachable?: () => boolean | Promise<boolean> }): Tier {
  const fetchImpl = opts.fetchImpl ?? fetch
  const reachable = opts.reachable ?? (() => true)
  const questions = activeQuestions(opts.cfg)
  const warned = new Set<string>()
  const warnOnce = (sessionID: string, log: (level: "warn", msg: string) => void, msg: string) => {
    if (warned.has(sessionID)) return
    warned.add(sessionID)
    log("warn", msg)
  }
  return async (req, env) => {
    if (opts.cfg.mode === "off" || !opts.cfg.baseUrl) return undefined
    let ok: boolean | typeof TIMED_OUT
    try { ok = await raceTimeout(Promise.resolve(reachable()), opts.cfg.timeoutMs) } catch { ok = false }
    if (ok === TIMED_OUT) { env.trace.laya = { skipped: "probe pending" }; return undefined }
    if (!ok) {
      env.trace.laya = { skipped: "unreachable" }
      warnOnce(req.sessionID, env.log, "laya unreachable at startup; tier skipped for this session")
      return undefined
    }
    const t0 = performance.now()
    // I1: context wait and the request share one timeoutMs budget.
    const deadline = Date.now() + opts.cfg.timeoutMs
    try {
      const ctx = await raceTimeout(env.context(), deadline - Date.now())
      if (ctx === TIMED_OUT) throw new Error("laya: context timed out")
      const state = renderState(req, ctx)
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), Math.max(1, deadline - Date.now()))
      try {
        const res = await fetchImpl(`${opts.cfg.baseUrl.replace(/\/$/, "")}/v1/systemone`, { method: "POST", signal: ctrl.signal, headers: headers(opts.cfg), body: JSON.stringify({ state: { text: state }, questions: toQuestions(questions) }) })
        if (!res.ok) throw new Error(`laya http ${res.status}`)
        const answers = normalizeAnswers(await res.json(), questions)
        const d = decide(answers, questions, opts.cfg)
        for (const s of d.signals) if (!env.signals.includes(s)) env.signals.push(s)
        const ms = +(performance.now() - t0).toFixed(0)
        if (opts.cfg.mode === "shadow") { env.trace.laya = { mode: "shadow", state, answers, fired: d.fired, signals: d.signals, wouldBe: d.status ?? null, ms }; return undefined }
        env.trace.laya = { mode: "active", state, answers, fired: d.fired, signals: d.signals, status: d.status ?? null, ms }
        return d.status ? { status: d.status, reason: d.reason, settledBy: "laya" } : undefined
      } finally { clearTimeout(timer) }
    } catch (e) {
      env.trace.laya = { mode: opts.cfg.mode, error: String(e), ms: +(performance.now() - t0).toFixed(0) }
      warnOnce(req.sessionID, env.log, `laya skipped: ${String(e)}`)
      return undefined
    }
  }
}
