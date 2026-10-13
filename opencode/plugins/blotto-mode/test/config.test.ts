import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadConfig, DEFAULTS, expandString, mergeConfig, ConfigSchema, RuleDefSchema, LayaQuestionSchema } from "../src/config"

function tmp() { return mkdtempSync(join(tmpdir(), "blotto-")) }

test("defaults validate and match the spec", () => {
  expect(ConfigSchema.parse(DEFAULTS)).toEqual(DEFAULTS)
  expect(DEFAULTS.judge.model).toBe("glm-5.3-flash")
  expect(DEFAULTS.laya.mode).toBe("shadow")
  expect(DEFAULTS.laya.verdictThreshold).toBe(0.95)
  expect(DEFAULTS.judge.timeoutMs).toBe(8000)
  expect(DEFAULTS.laya.timeoutMs).toBe(150)
})

test("expandString handles {env:VAR} and ~", () => {
  expect(expandString("{env:FOO}/x", { FOO: "bar" }, "/home/u")).toBe("bar/x")
  expect(expandString("~/.local", {}, "/home/u")).toBe("/home/u/.local")
  expect(expandString("{env:MISSING}", {}, "/home/u")).toBe("")
})

test("mergeConfig concatenates rule and question arrays, replaces others", () => {
  const out = mergeConfig(
    { rules: { custom: [{ id: "a" }], disable: ["x"] }, laya: { questions: [{ id: "q1" }] }, kinds: ["bash"] },
    { rules: { custom: [{ id: "b" }], disable: ["y"] }, laya: { questions: [{ id: "q2" }] }, kinds: ["webfetch"] },
  ) as any
  expect(out.rules.custom.map((r: any) => r.id)).toEqual(["a", "b"])
  expect(out.rules.disable).toEqual(["y"])
  expect(out.laya.questions.map((q: any) => q.id)).toEqual(["q1", "q2"])
  expect(out.kinds).toEqual(["webfetch"])
})

test("loadConfig layers global then project and expands env", () => {
  const home = tmp(); const wt = tmp()
  mkdirSync(join(home, ".config/opencode"), { recursive: true })
  mkdirSync(join(wt, ".opencode"), { recursive: true })
  writeFileSync(join(home, ".config/opencode/blotto-mode.json"), JSON.stringify({ judge: { model: "m1", apiKey: "{env:K}" } }))
  writeFileSync(join(wt, ".opencode/blotto-mode.json"), JSON.stringify({ judge: { model: "m2" }, laya: { mode: "active" } }))
  const cfg = loadConfig({ worktree: wt, homedir: home, env: { K: "secret" } })
  expect(cfg.judge.model).toBe("m2")
  expect(cfg.judge.apiKey).toBe("secret")
  expect(cfg.laya.mode).toBe("active")
  expect(cfg.log.path).toBe(join(home, ".local/share/blotto-mode/decisions.jsonl"))
})

test("invalid config falls back to defaults and reports", () => {
  const home = tmp(); const wt = tmp()
  mkdirSync(join(home, ".config/opencode"), { recursive: true })
  writeFileSync(join(home, ".config/opencode/blotto-mode.json"), JSON.stringify({ laya: { mode: "sometimes" } }))
  const msgs: string[] = []
  const cfg = loadConfig({ worktree: wt, homedir: home, env: {}, log: (m) => msgs.push(m) })
  expect(cfg.laya.mode).toBe("shadow")
  expect(msgs.join("\n")).toContain("laya.mode")
})

test("BLOTTO_MODE=off disables", () => {
  const cfg = loadConfig({ worktree: tmp(), homedir: tmp(), env: { BLOTTO_MODE: "off" } })
  expect(cfg.enabled).toBe(false)
})

test("a config file with a top-level $examples key loads and applies its other values", () => {
  const home = tmp()
  mkdirSync(join(home, ".config/opencode"), { recursive: true })
  writeFileSync(join(home, ".config/opencode/blotto-mode.json"), JSON.stringify({ judge: { model: "other-model" }, "$examples": { rule: { id: "x" } } }))
  const logs: string[] = []
  const cfg = loadConfig({ worktree: tmp(), homedir: home, env: {}, log: (m) => logs.push(m) })
  expect(logs).toEqual([])
  expect(cfg.judge.model).toBe("other-model")
  expect(cfg.laya.mode).toBe("shadow")
  expect("$examples" in cfg).toBe(false)
})

test("example config: $examples entries validate and the rest deep-equals DEFAULTS", () => {
  const file = JSON.parse(readFileSync(join(import.meta.dir, "../.opencode/blotto-mode.example.json"), "utf8"))
  const { $examples, ...rest } = file
  expect(RuleDefSchema.parse($examples.rule)).toEqual($examples.rule)
  expect(LayaQuestionSchema.parse($examples.layaQuestion)).toEqual($examples.layaQuestion)
  expect(rest).toEqual(DEFAULTS)
})

test("T8: laya question type must fit its role", () => {
  const q = { id: "q", instructions: "i", criteria: { true: "t", false: "f" } }
  expect(LayaQuestionSchema.safeParse({ ...q, type: "noul", role: "veto" }).success).toBe(true)
  expect(LayaQuestionSchema.safeParse({ ...q, type: "noul", role: "approve" }).success).toBe(true)
  expect(LayaQuestionSchema.safeParse({ ...q, type: "noul", role: "signal" }).success).toBe(true)
  expect(LayaQuestionSchema.safeParse({ ...q, type: "choice", role: "verdict", criteria: { allow: "a", ask: "b", deny: "c" } }).success).toBe(true)
  expect(LayaQuestionSchema.safeParse({ ...q, type: "choice", role: "veto" }).success).toBe(false)
  expect(LayaQuestionSchema.safeParse({ ...q, type: "score", role: "approve" }).success).toBe(false)
  expect(LayaQuestionSchema.safeParse({ ...q, type: "noul", role: "verdict" }).success).toBe(false)
})

test("M1: a custom rule with an invalid regex invalidates the config (defaults used)", () => {
  const dir = tmp()
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode/blotto-mode.json"), JSON.stringify({ rules: { custom: [{ id: "bad", kinds: ["bash"], reason: "r", match: { regex: "([" } }] } }))
  const logs: string[] = []
  const cfg = loadConfig({ worktree: dir, homedir: tmp(), env: {}, log: (m) => logs.push(m) })
  expect(cfg.rules.custom).toEqual([])
  expect(logs.join()).toContain("invalid regular expression")
})
