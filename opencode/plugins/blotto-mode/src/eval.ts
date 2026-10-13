import { z } from "zod"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { createPlugin, type Logger } from "./plugin"
import type { Config } from "./config"
import type { Status } from "./types"
import { DecisionLog } from "./log"
import { pct } from "./stats"

export const EvalCaseSchema = z.object({
  id: z.string(), tags: z.array(z.string()).default([]),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).default([]),
  assistantIntent: z.string().optional(), stateText: z.string().optional(),
  permission: z.object({ type: z.string(), pattern: z.union([z.string(), z.array(z.string())]), title: z.string().optional() }),
  expect: z.object({ verdict: z.array(z.enum(["allow", "deny", "ask"])).min(1), notAllow: z.boolean().optional() }),
})
export type EvalCase = z.infer<typeof EvalCaseSchema>

/** Directories contribute their .jsonl files; any other path is loaded as a file. */
export function loadCases(paths: string[]): EvalCase[] {
  const files: string[] = []
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        if (f.endsWith(".jsonl")) files.push(join(p, f))
      }
    } else {
      files.push(p)
    }
  }
  const out: EvalCase[] = []
  for (const f of files) for (const line of readFileSync(f, "utf8").split("\n")) if (line.trim()) out.push(EvalCaseSchema.parse(JSON.parse(line)))
  return out
}

export interface EvalRunOpts { cases: EvalCase[]; cfg: Config; tiers: ("rules" | "cache" | "laya" | "judge")[]; fetchImpl?: typeof fetch; homedir?: string; concurrency?: number; logger?: Logger }
export interface EvalResult { id: string; tags: string[]; expected: Status[]; notAllow: boolean; got: Status; settledBy: string; ms: number; tokensIn?: number; pass: boolean; falseAllow: boolean; reason: string; judgeError?: boolean }

/**
 * M7: when the judge tier is selected and it errored (no verdict) on more than half the cases, the run
 * measured the fallback, not the judge. Returns a warning, or undefined when the run is usable.
 */
export function judgeErrorWarning(tiers: string[], results: EvalResult[]): string | undefined {
  if (!tiers.includes("judge") || results.length === 0) return undefined
  const errors = results.filter((r) => r.judgeError).length
  if (errors * 2 <= results.length) return undefined
  return `judge errored on ${errors}/${results.length} cases; check judge.baseUrl, apiKey, and model`
}

function fakeClient(c: EvalCase, permissionMessageID: string) {
  let t = 0
  const msgs = c.messages.map((m, i) => ({ info: { id: `m${i}`, sessionID: "eval", role: m.role, time: { created: ++t } }, parts: [{ id: `p${i}`, sessionID: "eval", messageID: `m${i}`, type: "text", text: m.text }] }))
  msgs.push({ info: { id: permissionMessageID, sessionID: "eval", role: "assistant", time: { created: ++t } }, parts: [{ id: "pi", sessionID: "eval", messageID: permissionMessageID, type: "text", text: c.assistantIntent ?? "" }] })
  return {
    session: { get: async () => ({ data: { id: "eval" } }), messages: async () => ({ data: msgs }), prompt: async () => ({ data: {} }) },
    tui: { showToast: async () => ({ data: true }) },
  }
}

export const TIER_NAMES = ["rules", "cache", "laya", "judge"] as const

/** Returns a list of problems; empty when the run would actually test something. */
export function validateRunArgs(a: { concurrency: unknown; tiers: string[]; caseCount: number }): string[] {
  const errs: string[] = []
  const c = typeof a.concurrency === "string" && a.concurrency.trim() !== "" ? Number(a.concurrency) : a.concurrency
  if (typeof c !== "number" || !Number.isInteger(c) || c < 1) errs.push(`concurrency must be a positive integer, got ${JSON.stringify(a.concurrency)}`)
  if (a.tiers.length === 0) errs.push("no tiers selected")
  for (const t of a.tiers) if (!(TIER_NAMES as readonly string[]).includes(t)) errs.push(`unknown tier "${t}" (expected ${TIER_NAMES.join(", ")})`)
  if (a.caseCount < 1) errs.push("no cases selected")
  return errs
}

export async function runEval(opts: EvalRunOpts): Promise<EvalResult[]> {
  const concurrency = opts.concurrency ?? 4
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`concurrency must be a positive integer, got ${concurrency}`)
  const results: EvalResult[] = []
  const queue = [...opts.cases]
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const c = queue.shift()!
      let settledBy = "none"
      let reason = ""
      let tokensIn: number | undefined
      let judgeError = false
      const log = new DecisionLog({ path: "/dev/null", maxMb: 1 })
      const plugin = createPlugin({
        config: { ...opts.cfg, enabled: true, feedback: { injectDenialReason: false, toast: false } },
        fetchImpl: opts.fetchImpl, homedir: opts.homedir ?? "/home/u", log, tiers: opts.tiers, logger: opts.logger,
        onDecision: (_req, result) => {
          settledBy = result.decision.settledBy
          reason = result.decision.reason
          const t = result.trace.judge?.tokensIn
          tokensIn = typeof t === "number" ? t : undefined
          judgeError = result.trace.judge?.error === true
        },
      })
      const hooks: any = await plugin({ client: fakeClient(c, "intent"), project: { id: "eval", worktree: "/home/u/proj" }, directory: "/home/u/proj", worktree: "/home/u/proj", serverUrl: new URL("http://localhost:1"), $: {} as any, experimental_workspace: { register() {} } } as any)
      const output = { status: "ask" as Status }
      const t0 = performance.now()
      await hooks["permission.ask"]({ id: c.id, type: c.permission.type, pattern: c.permission.pattern, sessionID: "eval", messageID: "intent", title: c.permission.title ?? "", metadata: {}, time: { created: 0 } }, output)
      const ms = +(performance.now() - t0).toFixed(0)
      const got = output.status
      const falseAllow = got === "allow" && (c.expect.notAllow === true || !c.expect.verdict.includes("allow"))
      results.push({ id: c.id, tags: c.tags, expected: c.expect.verdict, notAllow: c.expect.notAllow === true, got, settledBy, ms, tokensIn, pass: c.expect.verdict.includes(got) && !falseAllow, falseAllow, reason, ...(judgeError ? { judgeError } : {}) })
    }
  })
  await Promise.all(workers)
  return results.sort((a, b) => a.id.localeCompare(b.id))
}

export function summarize(results: EvalResult[]) {
  const onlyAllow = (r: EvalResult) => r.expected.length === 1 && r.expected[0] === "allow"
  const ms = results.map((r) => r.ms).sort((a, b) => a - b)
  const byTier: Record<string, number> = {}
  for (const r of results) byTier[r.settledBy] = (byTier[r.settledBy] ?? 0) + 1
  return {
    total: results.length, pass: results.filter((r) => r.pass).length,
    falseAllows: results.filter((r) => r.falseAllow).length,
    falseBlocks: results.filter((r) => onlyAllow(r) && r.got === "deny").length,
    unnecessaryAsks: results.filter((r) => onlyAllow(r) && r.got === "ask").length,
    byTier, p50ms: pct(ms, 0.5), p95ms: pct(ms, 0.95), tokensIn: results.reduce((n, r) => n + (r.tokensIn ?? 0), 0),
  }
}

export function renderSummary(s: ReturnType<typeof summarize>, results: EvalResult[]): string {
  const lines = [`eval: ${s.pass}/${s.total} pass · false allows ${s.falseAllows} · false blocks ${s.falseBlocks} · unnecessary asks ${s.unnecessaryAsks} · p50 ${s.p50ms}ms p95 ${s.p95ms}ms`, ""]
  for (const r of results) lines.push(`${r.pass ? "PASS" : r.falseAllow ? "FALSE-ALLOW" : "FAIL"}  ${r.id.padEnd(28)} expected ${r.expected.join("|").padEnd(14)} got ${r.got.padEnd(5)} ${r.settledBy.padEnd(8)} ${r.ms}ms`)
  return lines.join("\n")
}
