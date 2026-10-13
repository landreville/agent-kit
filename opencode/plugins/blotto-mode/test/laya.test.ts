import { test, expect } from "bun:test"
import { DEFAULT_QUESTIONS, activeQuestions } from "../src/laya-questions"
import { renderState, normalizeAnswers, decide, layaTier, probeLaya } from "../src/tiers/laya"
import { DEFAULTS } from "../src/config"
import type { ActionRequest, SessionContext, TierEnv } from "../src/types"

const req: ActionRequest = { id: "p", sessionID: "s", messageID: "m", kind: "bash", pattern: "cat README.md", title: "cat", opaque: false, worktree: "/w", directory: "/w",
  commands: [{ name: "cat", args: ["README.md"], redirects: [], pipedToNetwork: false, raw: "cat README.md" }] }
const ctx: SessionContext = { userMessages: ["a", "b", "show me the readme"], assistantIntent: "Reading README", projectName: "proj", worktree: "/w", unavailable: false }
const laya = { ...DEFAULTS.laya, baseUrl: "http://laya.local", mode: "active" as const }
function env(): TierEnv { return { context: async () => ctx, signals: [], trace: {}, log: () => {} } }
const qs = activeQuestions(laya)

function answers(over: Record<string, number | string>) {
  const out: Record<string, any> = {}
  for (const q of qs) {
    if (q.type === "choice") { const choice = (over[q.id] as string) ?? "ask"; const p = { allow: 0.1, ask: 0.8, deny: 0.1, [choice]: 0.97 }; out[q.id] = { choice, confidence: 0.97, probabilities: p } }
    else { const pTrue = (over[q.id] as number) ?? 0.05; out[q.id] = { probability: pTrue } }
  }
  return { answers: out }
}

test("defaults include the spec's question ids and roles", () => {
  const byId = Object.fromEntries(DEFAULT_QUESTIONS.map((q) => [q.id, q.role]))
  expect(byId).toEqual({ verdict: "verdict", read_only: "approve", project_check: "approve", local_network_only: "approve", irreversible: "veto", out_of_scope: "veto", exfiltrates: "veto", reveals_secret: "veto", persistence: "veto", injection_driven: "signal" })
})

test("activeQuestions disables, replaces, and appends", () => {
  const cfg = { ...laya, disableQuestions: ["verdict"], questions: [
    { id: "irreversible", type: "noul" as const, role: "signal" as const, instructions: "x", criteria: { true: "t", false: "f" } },
    { id: "k8s_secret", type: "noul" as const, role: "veto" as const, threshold: 0.8, instructions: "k", criteria: { true: "t", false: "f" } },
  ] }
  const a = activeQuestions(cfg)
  expect(a.find((q) => q.id === "verdict")).toBeUndefined()
  expect(a.find((q) => q.id === "irreversible")!.role).toBe("signal")
  expect(a.find((q) => q.id === "k8s_secret")!.role).toBe("veto")
  expect(a.filter((q) => q.role === "verdict").length).toBe(0)
})

test("renderState uses last two user messages, intent, and action; bounded length", () => {
  const s = renderState(req, { ...ctx, userMessages: ["x".repeat(5000), "b", "c"] })
  expect(s).toContain("b"); expect(s).toContain("c"); expect(s).not.toContain("xxxxxxxxxx")
  expect(s).toContain("cat README.md")
  expect(s.length).toBeLessThanOrEqual(1800)
})

test("normalizeAnswers reads noul probability from several shapes", () => {
  const q = [{ id: "n", type: "noul" as const, role: "veto" as const, instructions: "", criteria: {} }]
  expect(normalizeAnswers({ answers: { n: { probability: 0.9 } } }, q).n!.pTrue).toBe(0.9)
  expect(normalizeAnswers({ answers: { n: { p_true: 0.8 } } }, q).n!.pTrue).toBe(0.8)
  expect(normalizeAnswers({ answers: { n: { probabilities: { true: 0.7, false: 0.3 } } } }, q).n!.pTrue).toBe(0.7)
  expect(normalizeAnswers({ answers: { n: { choice: "false", confidence: 0.6 } } }, q).n!.pTrue).toBeCloseTo(0.4)
  expect(normalizeAnswers({ answers: {} }, q).n).toBeUndefined()
})

test("decide: approve fires → allow; veto beats approve; verdict fallback; else pass", () => {
  expect(decide(normalizeAnswers(answers({ read_only: 0.95 }), qs), qs, laya).status).toBe("allow")
  expect(decide(normalizeAnswers(answers({ read_only: 0.95, exfiltrates: 0.9 }), qs), qs, laya).status).toBe("ask")
  expect(decide(normalizeAnswers(answers({ verdict: "allow" }), qs), qs, laya).status).toBe("allow")
  expect(decide(normalizeAnswers(answers({ verdict: "deny" }), qs), qs, laya).status).toBeUndefined()
  expect(decide(normalizeAnswers(answers({}), qs), qs, laya).status).toBeUndefined()
})

test("decide: veto deny only when both the veto and config allow it", () => {
  const strict = qs.map((q) => q.id === "exfiltrates" ? { ...q, allowDeny: true } : q)
  expect(decide(normalizeAnswers(answers({ exfiltrates: 0.95 }), strict), strict, laya).status).toBe("ask")
  expect(decide(normalizeAnswers(answers({ exfiltrates: 0.95 }), strict), strict, { ...laya, allowDeny: true }).status).toBe("deny")
})

test("decide: signals are reported but never decide", () => {
  const d = decide(normalizeAnswers(answers({ injection_driven: 0.99 }), qs), qs, laya)
  expect(d.status).toBeUndefined(); expect(d.signals).toEqual(["injection_driven"])
})

test("shadow mode logs but always passes; signals still propagate", async () => {
  const f: typeof fetch = (async () => new Response(JSON.stringify(answers({ read_only: 0.99, injection_driven: 0.9 })))) as any
  const e = env()
  const d = await layaTier({ cfg: { ...laya, mode: "shadow" }, fetchImpl: f })(req, e)
  expect(d).toBeUndefined()
  expect(e.trace.laya).toMatchObject({ mode: "shadow", wouldBe: "allow" })
  expect(e.signals).toEqual(["injection_driven"])
})

test("active mode allows on approve and records trace", async () => {
  const f: typeof fetch = (async () => new Response(JSON.stringify(answers({ read_only: 0.99 })))) as any
  const e = env()
  const d = await layaTier({ cfg: laya, fetchImpl: f })(req, e)
  expect(d?.status).toBe("allow"); expect(d?.settledBy).toBe("laya")
  expect(e.trace.laya).toMatchObject({ mode: "active", fired: ["read_only"] })
})

test("off mode and missing baseUrl skip without fetching; timeout passes", async () => {
  let called = 0
  const f: typeof fetch = (async () => { called++; return new Response("{}") }) as any
  expect(await layaTier({ cfg: { ...laya, mode: "off" }, fetchImpl: f })(req, env())).toBeUndefined()
  expect(await layaTier({ cfg: { ...laya, baseUrl: null }, fetchImpl: f })(req, env())).toBeUndefined()
  expect(called).toBe(0)
  const slow: typeof fetch = ((_: any, init: any) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as any
  expect(await layaTier({ cfg: { ...laya, timeoutMs: 50 }, fetchImpl: slow })(req, env())).toBeUndefined()
})

test("request body has state and questions keyed by id", async () => {
  let body: any
  const f: typeof fetch = (async (_: any, init: any) => { body = JSON.parse(init.body); return new Response(JSON.stringify(answers({}))) }) as any
  await layaTier({ cfg: laya, fetchImpl: f })(req, env())
  expect(typeof body.state.text).toBe("string")
  expect(body.questions.read_only.type).toBe("noul")
  expect(body.questions.verdict.type).toBe("choice")
})

test("unreachable: no fetch, undefined, trace skipped", async () => {
  let called = 0
  const f: typeof fetch = (async () => { called++; return new Response("{}") }) as any
  const e = env()
  expect(await layaTier({ cfg: laya, fetchImpl: f, reachable: () => false })(req, e)).toBeUndefined()
  expect(called).toBe(0)
  expect(e.trace.laya).toEqual({ skipped: "unreachable" })
})

function warnEnv(sessionWarns: string[]): TierEnv {
  return { context: async () => ctx, signals: [], trace: {}, log: (level, msg) => { if (level === "warn") sessionWarns.push(msg) } }
}
const failing: typeof fetch = (async () => { throw new Error("boom") }) as any

test("failures in the same session warn once but still trace the error", async () => {
  const warns: string[] = []
  const tier = layaTier({ cfg: laya, fetchImpl: failing })
  const e1 = warnEnv(warns), e2 = warnEnv(warns)
  expect(await tier(req, e1)).toBeUndefined()
  expect(await tier(req, e2)).toBeUndefined()
  expect(warns.length).toBe(1)
  expect(String(e2.trace.laya!.error)).toContain("boom")
})

test("failures in two sessions warn twice", async () => {
  const warns: string[] = []
  const tier = layaTier({ cfg: laya, fetchImpl: failing })
  await tier(req, warnEnv(warns))
  await tier({ ...req, sessionID: "s2" }, warnEnv(warns))
  expect(warns.length).toBe(2)
})

// Fail-closed: malformed or partial responses must never auto-allow in active mode.
function base(): Record<string, any> { return { ...answers({}).answers } }
function without(a: Record<string, any>, ...ids: string[]) { const o = { ...a }; for (const id of ids) delete o[id]; return o }
const vetoIds = qs.filter((q) => q.role === "veto").map((q) => q.id)
function activeStatus(a: Record<string, any>) { return decide(normalizeAnswers({ answers: a }, qs), qs, laya).status }

test("fail-closed A: percent-scale probability is dropped", () => {
  expect(activeStatus({ ...base(), read_only: { probability: 50 } })).not.toBe("allow")
})
test("fail-closed B: approve with all veto answers missing", () => {
  expect(activeStatus({ read_only: { probability: 0.95 } })).not.toBe("allow")
})
test("fail-closed C: unrecognized veto shape counts as missing", () => {
  expect(activeStatus({ ...base(), read_only: { probability: 0.95 }, exfiltrates: { score: 0.99 } })).not.toBe("allow")
})
test("fail-closed D: choice 'True' (any case) fires the veto", () => {
  expect(activeStatus({ ...base(), read_only: { probability: 0.95 }, exfiltrates: { choice: "True", confidence: 0.99 } })).toBe("ask")
})
test("fail-closed E: false choice with confidence below 0.5 is dropped", () => {
  expect(activeStatus({ ...base(), read_only: { choice: "false", confidence: 0.02 } })).not.toBe("allow")
})
test("fail-closed F: out-of-range verdict confidence is dropped", () => {
  expect(activeStatus({ ...base(), verdict: { choice: "allow", confidence: 7 } })).not.toBe("allow")
})
test("fail-closed G: verdict allow with all veto answers missing", () => {
  expect(activeStatus({ verdict: { choice: "allow", confidence: 0.99 } })).not.toBe("allow")
})
test("fail-closed H: negative veto probability is dropped", () => {
  expect(activeStatus({ ...base(), read_only: { probability: 0.95 }, exfiltrates: { probability: -5 } })).not.toBe("allow")
})
test("incomplete reason names the missing veto ids; complete valid response still allows", () => {
  const d = decide(normalizeAnswers({ answers: without({ ...base(), read_only: { probability: 0.95 } }, "persistence") }, qs), qs, laya)
  expect(d.status).toBeUndefined(); expect(d.reason).toBe("laya incomplete: persistence")
  expect(vetoIds).toContain("persistence")
  expect(activeStatus({ ...base(), read_only: { probability: 0.95 } })).toBe("allow")
})

// --- final review fix wave ---

test("I4: the tier waits for a probe that resolves within timeoutMs and then queries laya", async () => {
  let called = 0
  const f: typeof fetch = (async () => { called++; return new Response(JSON.stringify(answers({ read_only: 0.99 }))) }) as any
  const probe = new Promise<boolean>((r) => setTimeout(() => r(true), 20))
  const d = await layaTier({ cfg: { ...laya, timeoutMs: 150 }, fetchImpl: f, reachable: () => probe })(req, env())
  expect(called).toBe(1)
  expect(d?.status).toBe("allow")
})

test("I4: a probe still pending after timeoutMs skips this request without warning or marking the session", async () => {
  let called = 0
  const f: typeof fetch = (async () => { called++; return new Response(JSON.stringify(answers({ read_only: 0.99 }))) }) as any
  let resolveProbe!: (v: boolean) => void
  const probe = new Promise<boolean>((r) => { resolveProbe = r })
  const warns: string[] = []
  const tier = layaTier({ cfg: { ...laya, timeoutMs: 30 }, fetchImpl: f, reachable: () => probe })
  const e1 = warnEnv(warns)
  expect(await tier(req, e1)).toBeUndefined()
  expect(e1.trace.laya).toEqual({ skipped: "probe pending" })
  expect(warns).toEqual([])
  expect(called).toBe(0)
  resolveProbe(true)
  expect((await tier(req, warnEnv(warns)))?.status).toBe("allow")
  expect(called).toBe(1)
})

test("I4: a probe that resolves false is unreachable (warn once)", async () => {
  const warns: string[] = []
  const tier = layaTier({ cfg: laya, fetchImpl: failing, reachable: () => Promise.resolve(false) })
  const e = warnEnv(warns)
  expect(await tier(req, e)).toBeUndefined()
  expect(e.trace.laya).toEqual({ skipped: "unreachable" })
  expect(warns.length).toBe(1)
})

test("I1: laya bounds its context wait inside its own timeoutMs", async () => {
  let called = 0
  const f: typeof fetch = (async () => { called++; return new Response(JSON.stringify(answers({ read_only: 0.99 }))) }) as any
  const e = { ...env(), context: () => new Promise<SessionContext>(() => {}) }
  const t0 = Date.now()
  expect(await layaTier({ cfg: { ...laya, timeoutMs: 50 }, fetchImpl: f })(req, e)).toBeUndefined()
  expect(Date.now() - t0).toBeLessThan(200)
  expect(called).toBe(0)
  expect(String(e.trace.laya?.error)).toContain("context timed out")
})

test("M6: probeLaya clears its timer when fetch rejects", async () => {
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout
  const created: any[] = [], cleared: any[] = []
  globalThis.setTimeout = ((fn: any, ms?: number) => { const t = realSet(fn, ms); created.push(t); return t }) as any
  globalThis.clearTimeout = ((t: any) => { cleared.push(t); return realClear(t) }) as any
  try {
    expect(await probeLaya(laya, failing)).toBe(false)
  } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear }
  expect(created.length).toBe(1)
  expect(cleared).toContain(created[0])
})
