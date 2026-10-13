#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { loadConfig } from "../src/config"
import { loadCases, runEval, summarize, renderSummary, validateRunArgs, judgeErrorWarning } from "../src/eval"

const { values } = parseArgs({ options: {
  cases: { type: "string", default: "eval/cases" }, tiers: { type: "string", default: "rules,cache,laya,judge" }, model: { type: "string" },
  "laya-mode": { type: "string" }, "laya-url": { type: "string" }, out: { type: "string" }, only: { type: "string" }, concurrency: { type: "string", default: "4" },
} })
let cfg = loadConfig({ worktree: process.cwd() })
if (values.model) cfg = { ...cfg, judge: { ...cfg.judge, model: values.model } }
if (values["laya-mode"]) cfg = { ...cfg, laya: { ...cfg.laya, mode: values["laya-mode"] as any } }
if (values["laya-url"]) cfg = { ...cfg, laya: { ...cfg.laya, baseUrl: values["laya-url"] } }
let cases = loadCases([values.cases!])
if (values.only) cases = cases.filter((c) => c.tags.includes(values.only!) || c.id === values.only)
const tiers = values.tiers!.split(",").map((t) => t.trim())
const errs = validateRunArgs({ concurrency: values.concurrency, tiers, caseCount: cases.length })
if (errs.length) { for (const e of errs) console.error(`eval: ${e}`); process.exit(2) }
const results = await runEval({ cases, cfg, tiers: tiers as any, concurrency: Number(values.concurrency) })
const summary = summarize(results)
console.log(renderSummary(summary, results))
const out = values.out ?? `eval/runs/${new Date().toISOString().replace(/[:.]/g, "-")}.json`
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ config: { model: cfg.judge.model, tiers: values.tiers, laya: cfg.laya.mode }, summary, results }, null, 2))
console.log(`\nwritten ${out}`)
// Exit codes: 0 ok, 1 false allows, 2 invalid arguments, 3 judge errored on most cases (run not meaningful).
const judgeWarning = judgeErrorWarning(tiers, results)
if (judgeWarning) console.error(`eval: warning: ${judgeWarning}`)
process.exit(judgeWarning ? 3 : summary.falseAllows > 0 ? 1 : 0)
