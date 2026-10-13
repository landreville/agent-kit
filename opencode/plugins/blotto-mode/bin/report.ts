#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { writeFileSync } from "node:fs"
import { DecisionLog } from "../src/log"
import { loadConfig } from "../src/config"
import { activeQuestions } from "../src/laya-questions"
import { buildReport, renderReport, exportEvalCases, exportLaya } from "../src/report"

const { values } = parseArgs({ options: { log: { type: "string" }, since: { type: "string" }, "export-eval": { type: "string" }, "export-laya": { type: "string" }, json: { type: "boolean" } } })
const cfg = loadConfig({ worktree: process.cwd() })
const path = values.log ?? cfg.log.path
let records = DecisionLog.merge(DecisionLog.read(path))
if (values.since) { const since = new Date(values.since).getTime(); records = records.filter((r) => new Date(r.ts).getTime() >= since) }
const report = buildReport(records, { questions: activeQuestions(cfg.laya) })
if (values["export-eval"]) writeFileSync(values["export-eval"], exportEvalCases(records).map((c) => JSON.stringify(c)).join("\n") + "\n")
if (values["export-laya"]) writeFileSync(values["export-laya"], exportLaya(records).map((c) => JSON.stringify(c)).join("\n") + "\n")
console.log(values.json ? JSON.stringify(report, null, 2) : renderReport(report))
