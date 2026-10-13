import { test, expect } from "bun:test"
import { runPipeline, InFlight } from "../src/pipeline"
import { rulesTier } from "../src/rules/engine"
import { DEFAULTS } from "../src/config"
import { layaTier } from "../src/tiers/laya"
import { judgeTier } from "../src/tiers/judge"
import type { ActionRequest, SessionContext, Tier } from "../src/types"

const req: ActionRequest = { id: "p", sessionID: "s", messageID: "m", kind: "bash", pattern: "x", title: "x", opaque: false, worktree: "/w", directory: "/w", commands: [] }
const ctx: SessionContext = { userMessages: [], projectName: "p", worktree: "/w", unavailable: false }
const pass: Tier = async () => undefined
const decide = (status: "allow" | "deny" | "ask", name: string): Tier => async () => ({ status, reason: name, settledBy: name as any })

test("first deciding tier wins and later tiers do not run", async () => {
  let ran = 0
  const spy: Tier = async () => { ran++; return undefined }
  const r = await runPipeline({ req, tiers: [{ name: "a", run: pass }, { name: "b", run: decide("deny", "rules") }, { name: "c", run: spy }], context: async () => ctx, log: () => {} })
  expect(r.decision.status).toBe("deny"); expect(ran).toBe(0)
})

test("falls back to ask when nothing decides", async () => {
  const r = await runPipeline({ req, tiers: [{ name: "a", run: pass }], context: async () => ctx, log: () => {} })
  expect(r.decision).toEqual({ status: "ask", reason: "no tier decided", settledBy: "fallback" })
})

test("a throwing tier is logged and skipped", async () => {
  const logs: string[] = []
  const boom: Tier = async () => { throw new Error("kaboom") }
  const r = await runPipeline({ req, tiers: [{ name: "boom", run: boom }, { name: "j", run: decide("allow", "judge") }], context: async () => ctx, log: (_l, m) => logs.push(m) })
  expect(r.decision.status).toBe("allow"); expect(logs.join()).toContain("kaboom")
})

test("context is fetched once and shared; prefetch starts at the named tier", async () => {
  let fetches = 0
  const order: string[] = []
  const context = async () => { fetches++; order.push("ctx-start"); await new Promise((r) => setTimeout(r, 20)); order.push("ctx-done"); return ctx }
  const laya: Tier = async (_r, env) => { order.push("laya"); await env.context(); return undefined }
  const judge: Tier = async (_r, env) => { order.push("judge"); await env.context(); return { status: "allow", reason: "", settledBy: "judge" } }
  const r = await runPipeline({ req, tiers: [{ name: "rules", run: async () => { order.push("rules"); return undefined } }, { name: "laya", run: laya }, { name: "judge", run: judge }], context, log: () => {} })
  expect(fetches).toBe(1)
  expect(order.indexOf("ctx-start")).toBeGreaterThan(order.indexOf("rules"))
  expect(order.indexOf("ctx-start")).toBeLessThanOrEqual(order.indexOf("laya"))
  expect(r.decision.status).toBe("allow")
})

test("signals written by one tier are visible to the next and returned", async () => {
  const a: Tier = async (_r, env) => { env.signals.push("injection_driven"); return undefined }
  let seen: string[] = []
  const b: Tier = async (_r, env) => { seen = [...env.signals]; return undefined }
  const r = await runPipeline({ req, tiers: [{ name: "a", run: a }, { name: "b", run: b }], context: async () => ctx, log: () => {} })
  expect(seen).toEqual(["injection_driven"]); expect(r.signals).toEqual(["injection_driven"])
})

// Real tiers. Laya warns once (deduped per session); the judge warns once per failed model
// call, and its shared deadline means the fallback model is not attempted after the first abort.
test("real laya (network error) and real judge (hangs until abort) fall to ask within the judge timeout, no throw, one laya warning", async () => {
  const logs: { level: string; msg: string }[] = []
  const layaFetch = (async () => { throw new TypeError("fetch failed") }) as unknown as typeof fetch
  const judgeFetch = ((_url: any, init?: RequestInit) => new Promise((_res, rej) => {
    const sig = init?.signal
    const fail = () => rej(new DOMException("aborted", "AbortError"))
    if (sig?.aborted) return fail()
    sig?.addEventListener("abort", fail)
  })) as unknown as typeof fetch
  const tiers = [
    { name: "laya", run: layaTier({ cfg: { ...DEFAULTS.laya, mode: "active", baseUrl: "http://laya.invalid", timeoutMs: 50 }, fetchImpl: layaFetch }) },
    { name: "judge", run: judgeTier({ cfg: { ...DEFAULTS.judge, timeoutMs: 200, fallbackModel: "fb" }, validateGlob: () => true, fetchImpl: judgeFetch }) },
  ]
  const t0 = Date.now()
  const r = await runPipeline({ req, tiers, context: async () => ctx, log: (level, msg) => logs.push({ level, msg }) })
  const elapsed = Date.now() - t0
  expect(r.decision).toMatchObject({ status: "ask", settledBy: "fallback" })
  expect(elapsed).toBeLessThan(300)
  expect(r.trace.laya).toBeDefined(); expect(r.trace.judge).toBeDefined()
  expect(logs.filter((l) => l.level === "warn" && l.msg.startsWith("laya")).length).toBe(1)
})

test("a context function that throws synchronously does not escape the pipeline", async () => {
  const syncThrow = (() => { throw new Error("sync boom") }) as unknown as () => Promise<SessionContext>
  const r = await runPipeline({ req, tiers: [{ name: "laya", run: pass }, { name: "j", run: decide("allow", "judge") }], context: syncThrow, log: () => {} })
  expect(r.decision.status).toBe("allow")
})

test("a tier awaiting a rejected context is logged as threw and the pipeline falls back to ask", async () => {
  const logs: string[] = []
  const awaiting: Tier = async (_r, env) => { await env.context(); return undefined }
  const r = await runPipeline({ req, tiers: [{ name: "t", run: awaiting }], context: async () => { throw new Error("ctx fail") }, log: (_l, m) => logs.push(m) })
  expect(r.decision).toEqual({ status: "ask", reason: "no tier decided", settledBy: "fallback" })
  expect(r.trace.t?.threw).toContain("ctx fail")
  expect(logs.join()).toContain("ctx fail")
})

// --- final review fix wave ---

test("M1: a throwing rules tier ends in ask; later allow-capable tiers do not run", async () => {
  let judged = 0
  const boom: Tier = async () => { throw new Error("bad rule") }
  const judge: Tier = async () => { judged++; return { status: "allow", reason: "", settledBy: "judge" } }
  const r = await runPipeline({ req, tiers: [{ name: "rules", run: boom }, { name: "judge", run: judge }], context: async () => ctx, log: () => {} })
  expect(r.decision).toMatchObject({ status: "ask", settledBy: "fallback" })
  expect(judged).toBe(0)
  expect(r.trace.rules?.threw).toContain("bad rule")
})

test("M1: the real rules tier with an invalid custom regex fails closed", async () => {
  const bad = [{ id: "bad", kinds: ["bash" as const], reason: "r", match: { regex: "([" } }]
  const allow: Tier = async () => ({ status: "allow", reason: "", settledBy: "judge" })
  const r = await runPipeline({ req, tiers: [{ name: "rules", run: rulesTier(bad, "/home/u") }, { name: "judge", run: allow }], context: async () => ctx, log: () => {} })
  expect(r.decision.status).toBe("ask")
})

test("M6: InFlight cleanup timers are unref'd", async () => {
  const real = globalThis.setTimeout
  const timers: any[] = []
  globalThis.setTimeout = ((fn: any, ms?: number) => { const t = real(fn, ms); timers.push(t); return t }) as any
  try {
    const f = new InFlight()
    const p = Promise.resolve({} as any)
    f.set("x", p)
    await p; await Bun.sleep(0)
  } finally { globalThis.setTimeout = real }
  expect(timers.length).toBe(1)
  expect(timers[0].hasRef()).toBe(false)
  clearTimeout(timers[0])
})
