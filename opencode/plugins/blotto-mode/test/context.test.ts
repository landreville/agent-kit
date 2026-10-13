import { test, expect } from "bun:test"
import { buildContext, fetchContext, INJECT_MARKER, estimateTokens } from "../src/context"
import { fakeClient, userMsg, assistantMsg } from "./fakes/client"
import { DEFAULTS } from "../src/config"

const base = { permissionMessageID: "a9", userMessageCount: 6, tokenBudget: 1500, projectName: "proj", worktree: "/w" }

test("keeps last N user messages oldest-first and picks intent from the permission's message", () => {
  const messages = [userMsg("one"), assistantMsg("thinking"), userMsg("two"), assistantMsg("I will run tests", { id: "a9", tool: "bash" })]
  const ctx = buildContext({ ...base, messages, userMessageCount: 1 })
  expect(ctx.userMessages).toEqual(["two"])
  expect(ctx.assistantIntent).toBe("I will run tests")
  expect(ctx.unavailable).toBe(false)
})

test("strips plugin-injected and synthetic messages", () => {
  const messages = [userMsg("real"), userMsg(`${INJECT_MARKER} Denied: x`), userMsg("hidden", { synthetic: true })]
  expect(buildContext({ ...base, messages }).userMessages).toEqual(["real"])
})

test("falls back to the last assistant text when the permission message is absent", () => {
  const messages = [userMsg("a"), assistantMsg("first"), assistantMsg("latest")]
  expect(buildContext({ ...base, messages, permissionMessageID: "nope" }).assistantIntent).toBe("latest")
})

test("respects the token budget by truncating oldest messages first", () => {
  const long = "x".repeat(4000)
  const messages = [userMsg(long), userMsg(long), userMsg("newest")]
  const ctx = buildContext({ ...base, messages, tokenBudget: 600 })
  const total = ctx.userMessages.reduce((n, m) => n + estimateTokens(m), 0)
  expect(total).toBeLessThanOrEqual(600)
  expect(ctx.userMessages[ctx.userMessages.length - 1]).toBe("newest")
})

test("caps assistant intent at 400 chars", () => {
  const messages = [assistantMsg("y".repeat(1000), { id: "a9" })]
  expect(buildContext({ ...base, messages }).assistantIntent!.length).toBe(400)
})

test("never includes tool output or file contents", () => {
  const asst = assistantMsg("intent text", { id: "a9", tool: "read", output: "SECRET_TOOL_OUTPUT" })
  asst.parts.push({ id: "a9f", sessionID: "s1", messageID: "a9", type: "file", mime: "text/plain", url: "file:///x", source: { type: "file", path: "/x", text: { value: "SECRET_FILE", start: 0, end: 1 } }, text: "SECRET_FILE" } as any)
  const user = userMsg("do it")
  user.parts.push({ id: "uf", sessionID: "s1", messageID: user.info.id, type: "file", text: "SECRET_FILE" } as any)
  const ctx = buildContext({ ...base, messages: [user, asst] })
  const json = JSON.stringify(ctx)
  expect(json).not.toContain("SECRET_TOOL_OUTPUT")
  expect(json).not.toContain("SECRET_FILE")
  expect(ctx.assistantIntent).toBe("intent text")
  expect(ctx.userMessages).toEqual(["do it"])
})

test("never exceeds the budget even when the intent consumes it", () => {
  const messages = [userMsg("hello"), assistantMsg("z".repeat(400), { id: "a9" })]
  const ctx = buildContext({ ...base, messages, tokenBudget: 100 })
  expect(ctx.userMessages).toEqual([])
})

test("fetchContext marks unavailable on client error", async () => {
  const { client } = fakeClient({ failMessages: true })
  const ctx = await fetchContext(client as any, { sessionID: "s1", messageID: "m" } as any, DEFAULTS.judge, { projectName: "p" })
  expect(ctx.unavailable).toBe(true)
  expect(ctx.userMessages).toEqual([])
})

test("fetchContext asks for a bounded number of messages", async () => {
  const seen: any[] = []
  // Final-review ruling I9: fetchContext resolves the root session via session.get first (a client
  // without it is a failure → unavailable), so this hand-rolled client gains a parentless session.get.
  const client = { session: { get: async (o: any) => ({ data: { id: o.path.id } }), messages: async (o: any) => { seen.push(o); return { data: [userMsg("hi")] } } } }
  const ctx = await fetchContext(client as any, { sessionID: "s1", messageID: "m", worktree: "/w" } as any, DEFAULTS.judge, { projectName: "p" })
  expect(seen[0].path.id).toBe("s1")
  expect(seen[0].query.limit).toBeGreaterThanOrEqual(DEFAULTS.judge.userMessageCount * 2)
  expect(ctx.userMessages).toEqual(["hi"])
})

// --- final review fix wave ---

const req = { sessionID: "child", messageID: "a9", worktree: "/w" } as any

test("I9: a subagent session reads user messages from its root session; intent from its own", async () => {
  const { client, calls } = fakeClient({
    parents: { child: "mid", mid: "root" },
    messagesBySession: {
      child: [userMsg("parent agent's prompt to the subagent"), assistantMsg("subagent will run tests", { id: "a9" })],
      root: [userMsg("please fix the failing test"), assistantMsg("delegating")],
    },
  })
  const ctx = await fetchContext(client as any, req, DEFAULTS.judge, { projectName: "p" })
  expect(ctx.unavailable).toBe(false)
  expect(ctx.userMessages).toEqual(["please fix the failing test"])
  expect(ctx.assistantIntent).toBe("subagent will run tests")
  expect(ctx.fromRootSession).toBe(true)
  expect(calls.get).toEqual(["child", "mid", "root"])
})

test("I9: a top-level session makes one messages call and is not marked fromRootSession", async () => {
  const { client, calls } = fakeClient({ messages: [userMsg("hi")] })
  const ctx = await fetchContext(client as any, { ...req, sessionID: "s1" }, DEFAULTS.judge, { projectName: "p" })
  expect(ctx.userMessages).toEqual(["hi"])
  expect(ctx.fromRootSession).toBeUndefined()
  expect(calls.messages).toEqual(["s1"])
})

test("I9: session.get failure, a chain longer than 5 hops, or a cycle marks context unavailable", async () => {
  const failing = fakeClient({ failGet: true, messages: [userMsg("hi")] })
  expect((await fetchContext(failing.client as any, req, DEFAULTS.judge, { projectName: "p" })).unavailable).toBe(true)
  const deep = fakeClient({ parents: { child: "p1", p1: "p2", p2: "p3", p3: "p4", p4: "p5", p5: "p6" }, messages: [userMsg("hi")] })
  expect((await fetchContext(deep.client as any, req, DEFAULTS.judge, { projectName: "p" })).unavailable).toBe(true)
  const five = fakeClient({ parents: { child: "p1", p1: "p2", p2: "p3", p3: "p4", p4: "p5" }, messages: [userMsg("hi")] })
  expect((await fetchContext(five.client as any, req, DEFAULTS.judge, { projectName: "p" })).unavailable).toBe(false)
  const cyclic = fakeClient({ parents: { child: "x", x: "child" }, messages: [userMsg("hi")] })
  expect((await fetchContext(cyclic.client as any, req, DEFAULTS.judge, { projectName: "p" })).unavailable).toBe(true)
  const noGet = { session: { messages: async () => ({ data: [userMsg("hi")] }) } }
  expect((await fetchContext(noGet as any, req, DEFAULTS.judge, { projectName: "p" })).unavailable).toBe(true)
})
