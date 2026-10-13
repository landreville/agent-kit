import type { DecisionLog } from "./log"
import type { LayaQuestion } from "./config"
import { DEFAULT_QUESTIONS } from "./laya-questions"
import { pct } from "./stats"

type Merged = ReturnType<typeof DecisionLog.merge>[number]
type Truth = "allow" | "block"
type FinalStatus = "allow" | "deny" | "ask"

export interface Report {
  total: number; settledBy: Record<string, number>; finalStatus: Record<string, number>
  laya: { mode: Record<string, number>; agreement: { compared: number; agree: number }; questions: Record<string, { fired: number; total: number; falseAllow?: number; falseBlock?: number }> }
  /** calls counts every judge invocation including errored ones; latency percentiles include errored calls' ms. */
  judge: { calls: number; tokensIn: number; tokensOut: number; estCostUsd: number; p50ms: number; p95ms: number }
  layaLatency: { p50ms: number; p95ms: number }
  userReplies: Record<string, number>
  confusion: Record<FinalStatus, Record<Truth | "unknown", number>>
  confidenceCurve: { threshold: number; wouldAllow: number; falseAllow: number }[]
}

/** "allow" | "block" | undefined — what we believe the right answer was. */
export function truthOf(r: Merged): Truth | undefined {
  if (r.userReply === "once" || r.userReply === "always") return "allow"
  if (r.userReply === "reject") return "block"
  if (r.final.settledBy === "rules") return "block"
  if (r.final.settledBy === "judge" || r.final.settledBy === "cache") return r.final.status === "allow" ? "allow" : r.final.status === "deny" ? "block" : undefined
  return undefined
}

function inc(m: Record<string, number>, k: string) { m[k] = (m[k] ?? 0) + 1 }

export function buildReport(records: Merged[], opts: { pricePerMTokIn?: number; pricePerMTokOut?: number; questions?: LayaQuestion[] } = {}): Report {
  const questions = opts.questions ?? DEFAULT_QUESTIONS
  const approveIds = new Set(questions.filter((q) => q.role === "approve").map((q) => q.id))
  const vetoIds = new Set(questions.filter((q) => q.role === "veto").map((q) => q.id))
  const verdictIds = new Set(questions.filter((q) => q.role === "verdict").map((q) => q.id))
  const row = () => ({ allow: 0, block: 0, unknown: 0 })
  const r: Report = {
    total: records.length, settledBy: {}, finalStatus: {},
    laya: { mode: {}, agreement: { compared: 0, agree: 0 }, questions: {} },
    judge: { calls: 0, tokensIn: 0, tokensOut: 0, estCostUsd: 0, p50ms: 0, p95ms: 0 },
    layaLatency: { p50ms: 0, p95ms: 0 }, userReplies: {},
    confusion: { allow: row(), deny: row(), ask: row() }, confidenceCurve: [],
  }
  const judgeMs: number[] = [], layaMs: number[] = []
  // One confidence per laya-evaluated record: the verdict question's allow confidence if answered,
  // otherwise the highest approve-question pTrue.
  const curvePoints: { conf: number; truth?: Truth }[] = []
  for (const rec of records) {
    inc(r.settledBy, rec.final.settledBy); inc(r.finalStatus, rec.final.status)
    if (rec.userReply) inc(r.userReplies, rec.userReply)
    const truth = truthOf(rec)
    r.confusion[rec.final.status][truth ?? "unknown"]++
    const j = rec.tiers.judge as any
    if (j) { r.judge.calls++; r.judge.tokensIn += j.tokensIn ?? 0; r.judge.tokensOut += j.tokensOut ?? 0; if (typeof j.ms === "number") judgeMs.push(j.ms) }
    const l = rec.tiers.laya as any
    if (l && l.answers) {
      inc(r.laya.mode, l.mode); if (typeof l.ms === "number") layaMs.push(l.ms)
      const would = l.mode === "shadow" ? l.wouldBe : l.status
      if (truth && would !== null && would !== undefined) { r.laya.agreement.compared++; if ((would === "allow") === (truth === "allow")) r.laya.agreement.agree++ }
      let verdictConf: number | undefined, approveMax = 0
      for (const [qid, ans] of Object.entries<any>(l.answers)) {
        const q = (r.laya.questions[qid] ??= { fired: 0, total: 0 })
        q.total++
        const fired = Array.isArray(l.fired) && l.fired.includes(qid)
        if (fired) q.fired++
        if (verdictIds.has(qid)) { verdictConf = ans.value === "allow" ? ans.confidence ?? 0 : 0; continue }
        if (approveIds.has(qid)) {
          q.falseAllow ??= 0
          if (fired && truth === "block") q.falseAllow++
          approveMax = Math.max(approveMax, ans.pTrue ?? 0)
        }
        if (vetoIds.has(qid)) { q.falseBlock ??= 0; if (fired && truth === "allow") q.falseBlock++ }
      }
      curvePoints.push({ conf: verdictConf ?? approveMax, truth })
    }
  }
  judgeMs.sort((a, b) => a - b); layaMs.sort((a, b) => a - b)
  r.judge.p50ms = pct(judgeMs, 0.5); r.judge.p95ms = pct(judgeMs, 0.95)
  r.layaLatency.p50ms = pct(layaMs, 0.5); r.layaLatency.p95ms = pct(layaMs, 0.95)
  const pin = opts.pricePerMTokIn ?? 0.2, pout = opts.pricePerMTokOut ?? 1.1
  r.judge.estCostUsd = (r.judge.tokensIn / 1e6) * pin + (r.judge.tokensOut / 1e6) * pout
  for (const threshold of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99]) {
    const would = curvePoints.filter((v) => v.conf >= threshold)
    r.confidenceCurve.push({ threshold, wouldAllow: would.length, falseAllow: would.filter((v) => v.truth === "block").length })
  }
  return r
}

export function renderReport(r: Report): string {
  const lines = [`blotto-mode report: ${r.total} decisions`, "", "settled by:"]
  for (const [k, v] of Object.entries(r.settledBy)) lines.push(`  ${k.padEnd(10)} ${v}`)
  lines.push("", "final status:"); for (const [k, v] of Object.entries(r.finalStatus)) lines.push(`  ${k.padEnd(10)} ${v}`)
  lines.push("", "user replies (when asked):"); for (const [k, v] of Object.entries(r.userReplies)) lines.push(`  ${k.padEnd(10)} ${v}`)
  lines.push("", `judge: ${r.judge.calls} calls (incl. errored), ${r.judge.tokensIn} in / ${r.judge.tokensOut} out, ~$${r.judge.estCostUsd.toFixed(4)}, p50 ${r.judge.p50ms}ms p95 ${r.judge.p95ms}ms (latency incl. errored calls)`)
  lines.push("", `laya: modes ${JSON.stringify(r.laya.mode)}, agreement ${r.laya.agreement.agree}/${r.laya.agreement.compared}, p50 ${r.layaLatency.p50ms}ms p95 ${r.layaLatency.p95ms}ms`)
  lines.push("  question            fired/total  falseAllow  falseBlock")
  for (const [q, s] of Object.entries(r.laya.questions)) lines.push(`  ${q.padEnd(20)}${String(s.fired).padStart(5)}/${String(s.total).padEnd(6)} ${String(s.falseAllow ?? "-").padStart(10)}  ${String(s.falseBlock ?? "-").padStart(10)}`)
  lines.push("", "confusion (final status x truth):", "  final      allow  block  unknown")
  for (const [st, c] of Object.entries(r.confusion)) lines.push(`  ${st.padEnd(8)} ${String(c.allow).padStart(6)} ${String(c.block).padStart(6)} ${String(c.unknown).padStart(8)}`)
  lines.push("", "confidence curve (threshold -> would allow / false allows):")
  for (const c of r.confidenceCurve) lines.push(`  ${c.threshold.toFixed(2)}  ${c.wouldAllow} / ${c.falseAllow}`)
  return lines.join("\n")
}

export function exportEvalCases(records: Merged[]): object[] {
  return records.filter((r) => r.final.status === "ask" && r.userReply).map((r) => ({
    id: `log-${r.permissionID}`, tags: ["from-log", r.requestKind],
    messages: [], assistantIntent: undefined, stateText: r.stateText,
    permission: { type: r.requestKind === "mcp" ? "mcp__unknown" : r.requestKind, pattern: r.pattern, title: r.pattern.slice(0, 40) },
    expect: r.userReply === "reject" ? { verdict: ["deny", "ask"], notAllow: true } : { verdict: ["allow"] },
  }))
}

export function exportLaya(records: Merged[]): object[] {
  return records.filter((r) => typeof r.stateText === "string").map((r) => {
    const truth = truthOf(r)
    return { state: r.stateText, labels: { verdict: truth === "allow" ? "allow" : truth === "block" ? "deny" : "ask" }, meta: { permissionID: r.permissionID, pattern: r.pattern, settledBy: r.final.settledBy, userReply: r.userReply } }
  })
}
