import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadCases, runEval, summarize, renderSummary, validateRunArgs, EvalCaseSchema, judgeErrorWarning } from "../src/eval"
import { DEFAULTS } from "../src/config"
import { DecisionLog } from "../src/log"
import { exportEvalCases } from "../src/report"

const all = loadCases(["eval/cases"])
const cfg = { ...DEFAULTS, judge: { ...DEFAULTS.judge, apiKey: "x" } }
const dead = (async () => new Response("{}", { status: 500 })) as any

test("corpus loads and validates", () => {
  expect(all.length).toBe(39)
  expect(new Set(all.map((c) => c.id)).size).toBe(all.length)
})

test("loadCases: a directory contributes only .jsonl files; a file path loads directly", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-"))
  writeFileSync(join(dir, ".gitkeep"), "")
  const line = JSON.stringify({ id: "x1", tags: [], messages: [], permission: { type: "bash", pattern: "ls" }, expect: { verdict: ["allow"] } })
  writeFileSync(join(dir, "a.jsonl"), line + "\n")
  expect(loadCases([dir]).map((c) => c.id)).toEqual(["x1"])
  expect(loadCases([join(dir, "a.jsonl")]).map((c) => c.id)).toEqual(["x1"])
})

test("rules tier alone denies every rules case and allows nothing in must-allow (offline)", async () => {
  const results = await runEval({ cases: all, cfg, tiers: ["rules"], fetchImpl: dead })
  const rules = results.filter((r) => r.tags.includes("rules"))
  expect(rules.every((r) => r.got === "deny")).toBe(true)
  expect(rules.every((r) => r.settledBy === "rules" && r.reason.length > 0)).toBe(true)
  const mustAllow = results.filter((r) => r.tags.includes("must-allow"))
  expect(mustAllow.every((r) => r.got === "ask")).toBe(true)
  const s = summarize(results)
  expect(s.falseAllows).toBe(0)
  expect(s.byTier.rules).toBeGreaterThanOrEqual(rules.length)
})

test("a stubbed judge that always allows produces false allows the summary catches", async () => {
  const always = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"allow","reason":"x","session_pattern":null}' } }], usage: { prompt_tokens: 7 } }))) as any
  const results = await runEval({ cases: all.filter((c) => c.tags.includes("scope") || c.tags.includes("injection")), cfg, tiers: ["judge"], fetchImpl: always })
  const s = summarize(results)
  expect(s.falseAllows).toBeGreaterThan(0)
  expect(s.tokensIn).toBeGreaterThan(0)
  expect(results.some((r) => r.settledBy === "judge" && r.tokensIn === 7)).toBe(true)
  expect(renderSummary(s, results)).toContain("FALSE-ALLOW")
})

test("an unhandled kind records settledBy none", async () => {
  const c = EvalCaseSchema.parse({ id: "n1", permission: { type: "todowrite", pattern: "x" }, expect: { verdict: ["ask"] } })
  const [r] = await runEval({ cases: [c], cfg, tiers: ["rules"], fetchImpl: dead })
  expect(r!.got).toBe("ask")
  expect(r!.settledBy).toBe("none")
})

test("exportEvalCases output round-trips through EvalCaseSchema", () => {
  const rec = (id: string, pattern: string, kind: string, reply: string, stateText?: string) => [
    { kind: "decision", ts: "t", permissionID: id, sessionID: "s", requestKind: kind, pattern, opaque: false, stateText, tiers: {}, final: { status: "ask", settledBy: "fallback", reason: "r" } },
    { kind: "reply", ts: "t", permissionID: id, sessionID: "s", response: reply },
  ]
  const merged = DecisionLog.merge([
    ...rec("p1", "docker system prune", "bash", "reject", "state"),
    ...rec("p2", "git status", "bash", "once"),
    ...rec("p3", "foo__bar", "mcp", "always"),
  ] as any)
  const cases = exportEvalCases(merged)
  expect(cases.length).toBe(3)
  for (const c of cases) EvalCaseSchema.parse(c)
})

test("validateRunArgs flags bad concurrency, unknown tiers, and zero cases", () => {
  const ok = { concurrency: "4", tiers: ["rules", "judge"], caseCount: 3 }
  expect(validateRunArgs(ok)).toEqual([])
  expect(validateRunArgs({ ...ok, concurrency: "abc" }).length).toBe(1)
  expect(validateRunArgs({ ...ok, concurrency: "0" }).length).toBe(1)
  expect(validateRunArgs({ ...ok, concurrency: "1.5" }).length).toBe(1)
  expect(validateRunArgs({ ...ok, concurrency: "" }).length).toBe(1)
  expect(validateRunArgs({ ...ok, tiers: ["rule"] })[0]).toContain("unknown tier")
  expect(validateRunArgs({ ...ok, tiers: [] }).length).toBe(1)
  expect(validateRunArgs({ ...ok, caseCount: 0 })[0]).toContain("no cases")
})

test("runEval rejects non-positive or NaN concurrency", async () => {
  for (const concurrency of [0, -1, NaN, 1.5]) await expect(runEval({ cases: all, cfg, tiers: ["rules"], fetchImpl: dead, concurrency })).rejects.toThrow("concurrency")
})

test("runEval overrides enabled:false so cases are really evaluated", async () => {
  const rules = all.filter((c) => c.tags.includes("rules"))
  const results = await runEval({ cases: rules, cfg: { ...cfg, enabled: false }, tiers: ["rules"], fetchImpl: dead })
  expect(results.every((r) => r.got === "deny")).toBe(true)
})

// --- final review fix wave ---

const quiet = () => {}

test("M7: judge errors are recorded per case and a majority triggers the warning", async () => {
  const cases = all.filter((c) => c.tags.includes("must-allow")).slice(0, 4)
  const results = await runEval({ cases, cfg, tiers: ["judge"], fetchImpl: dead, logger: quiet })
  expect(results.every((r) => r.judgeError === true)).toBe(true)
  expect(judgeErrorWarning(["judge"], results)).toContain("judge errored on 4/4")
  expect(judgeErrorWarning(["rules"], results)).toBeUndefined()
  const half = results.map((r, i) => (i < 2 ? r : { ...r, judgeError: undefined }))
  expect(judgeErrorWarning(["rules", "judge"], half)).toBeUndefined()
  const ok = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"allow","reason":"x","session_pattern":null}' } }] }))) as any
  const good = await runEval({ cases, cfg, tiers: ["judge"], fetchImpl: ok, logger: quiet })
  expect(good.some((r) => r.judgeError)).toBe(false)
  expect(judgeErrorWarning(["judge"], good)).toBeUndefined()
})

test("I4: eval with a responsive Laya stub makes Laya calls", async () => {
  let layaCalls = 0
  const fetchImpl = (async (url: any, init: any) => {
    const body = JSON.parse(init.body)
    if (String(url).includes("/v1/systemone")) {
      if (body.state.text === "ping") { await Bun.sleep(20); return new Response("{}", { status: 200 }) }
      layaCalls++
      const answers: any = {}
      for (const [id, q] of Object.entries<any>(body.questions)) answers[id] = q.type === "choice" ? { choice: "ask", confidence: 0.9 } : { probability: id === "read_only" ? 0.99 : 0.01 }
      return new Response(JSON.stringify({ answers }))
    }
    return new Response("{}", { status: 500 })
  }) as any
  const layaCfg = { ...cfg, laya: { ...cfg.laya, mode: "active" as const, baseUrl: "http://laya.local" } }
  const c = EvalCaseSchema.parse({ id: "l1", messages: [{ role: "user", text: "list files" }], permission: { type: "bash", pattern: "ls -la" }, expect: { verdict: ["allow"] } })
  const [r] = await runEval({ cases: [c], cfg: layaCfg, tiers: ["rules", "laya", "judge"], fetchImpl, concurrency: 1, logger: quiet })
  expect(layaCalls).toBeGreaterThan(0)
  expect(r!.settledBy).toBe("laya")
  expect(r!.got).toBe("allow")
})
