import { test, expect } from "bun:test"
import { DecisionLog } from "../src/log"
import { buildReport, renderReport, exportEvalCases, exportLaya } from "../src/report"
import { pct } from "../src/stats"

const merged = DecisionLog.merge(DecisionLog.read("test/fixtures/decisions.sample.jsonl"))

test("counts, agreement, and per-question rates", () => {
  const r = buildReport(merged)
  expect(r.total).toBe(4)
  expect(r.settledBy).toEqual({ rules: 1, judge: 2, fallback: 1 })
  expect(r.userReplies).toEqual({ reject: 1, once: 1 })
  expect(r.laya.agreement).toEqual({ compared: 3, agree: 3 })
  expect(r.laya.questions.read_only).toMatchObject({ fired: 2, total: 3, falseAllow: 1 })
  expect(r.laya.questions.irreversible).toMatchObject({ fired: 1, total: 2, falseBlock: 0 })
  expect(r.judge.calls).toBe(3); expect(r.judge.tokensIn).toBe(2900)
  expect(r.judge.estCostUsd).toBeGreaterThan(0)
})

test("approve/veto rows follow question roles, not hardcoded ids", () => {
  const questions = [
    { id: "custom_ok", type: "noul", role: "approve", instructions: "x", criteria: {} },
    { id: "custom_bad", type: "noul", role: "veto", instructions: "x", criteria: {} },
  ] as any
  const mk = (id: string, truth: "deny" | "allow") => ({
    kind: "decision", ts: "t", permissionID: id, sessionID: "s", requestKind: "bash", pattern: "p", opaque: false,
    tiers: { laya: { mode: "shadow", answers: { custom_ok: { value: true, confidence: 0.9, pTrue: 0.9 }, custom_bad: { value: true, confidence: 0.9, pTrue: 0.9 }, read_only: { value: true, confidence: 0.9, pTrue: 0.9 } }, fired: ["custom_ok", "custom_bad", "read_only"], wouldBe: "ask", ms: 1 } },
    final: { status: truth, settledBy: "judge", reason: "" },
  }) as any
  const r = buildReport([mk("a", "deny"), mk("b", "allow")], { questions })
  expect(r.laya.questions.custom_ok).toMatchObject({ falseAllow: 1 })
  expect(r.laya.questions.custom_ok!.falseBlock).toBeUndefined()
  expect(r.laya.questions.custom_bad).toMatchObject({ falseBlock: 1 })
  expect(r.laya.questions.custom_bad!.falseAllow).toBeUndefined()
  expect(r.laya.questions.read_only!.falseAllow).toBeUndefined()
})

test("confusion matrix counts final status by truth", () => {
  const r = buildReport(merged)
  expect(r.confusion.deny.block).toBe(1)   // #1 rules deny
  expect(r.confusion.allow.allow).toBe(1)  // #2 judge allow
  expect(r.confusion.ask.block).toBe(1)    // #3 ask, user rejected
  expect(r.confusion.ask.allow).toBe(1)    // #4 ask, user once
  const sum = Object.values(r.confusion).flatMap((row) => Object.values(row)).reduce((a, b) => a + b, 0)
  expect(sum).toBe(4)
})

test("confidence curve is non-increasing in threshold and non-trivial", () => {
  const mk = (id: string, conf: number, withVerdict: boolean, truth: "allow" | "deny") => ({
    kind: "decision", ts: "t", permissionID: id, sessionID: "s", requestKind: "bash", pattern: "p", opaque: false,
    tiers: { laya: { mode: "shadow", answers: withVerdict
      ? { verdict: { value: "allow", confidence: conf } }
      : { read_only: { value: true, confidence: conf, pTrue: conf } }, fired: [], wouldBe: "allow", ms: 1 } },
    final: { status: truth, settledBy: "judge", reason: "" },
  }) as any
  const recs = [mk("1", 0.55, true, "allow"), mk("2", 0.75, false, "deny"), mk("3", 0.92, true, "allow"), mk("4", 0.97, false, "deny")]
  const r = buildReport(recs)
  const allows = r.confidenceCurve.map((c) => c.wouldAllow)
  for (let i = 1; i < allows.length; i++) expect(allows[i]!).toBeLessThanOrEqual(allows[i - 1]!)
  const distinctNonzero = new Set(allows.filter((a) => a > 0))
  expect(distinctNonzero.size).toBeGreaterThanOrEqual(2)
  expect(r.confidenceCurve.find((c) => c.threshold === 0.5)!.wouldAllow).toBe(4)
  expect(r.confidenceCurve.find((c) => c.threshold === 0.95)!.falseAllow).toBe(1)
})

test("pct handles empty and picks percentiles", () => {
  expect(pct([], 0.5)).toBe(0)
  expect(pct([1, 2, 3, 4], 0.5)).toBe(3)
  expect(pct([1, 2, 3, 4], 0.95)).toBe(4)
})

test("renderReport is human-readable text", () => {
  const text = renderReport(buildReport(merged))
  expect(text).toContain("settled by"); expect(text).toContain("read_only"); expect(text).toContain("judge")
  expect(text).toContain("confusion")
})

test("exportEvalCases turns prompted decisions with replies into cases", () => {
  const cases = exportEvalCases(merged) as any[]
  expect(cases.length).toBe(2)
  const prune = cases.find((c) => c.permission.pattern === "docker system prune")
  expect(prune.expect).toEqual({ verdict: ["deny", "ask"], notAllow: true })
  const status = cases.find((c) => c.permission.pattern === "git status")
  expect(status.expect).toEqual({ verdict: ["allow"] })
})

test("exportLaya emits state + labels for records with state", () => {
  const rows = exportLaya(merged) as any[]
  expect(rows.length).toBe(3)
  expect(rows[0].state).toBeDefined(); expect(rows[0].labels.verdict).toBeDefined()
})
