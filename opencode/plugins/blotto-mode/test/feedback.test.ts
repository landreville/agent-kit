import { test, expect } from "bun:test"
import { sendFeedback, denialText } from "../src/feedback"
import { fakeClient } from "./fakes/client"
import { INJECT_MARKER } from "../src/context"
import type { ActionRequest } from "../src/types"

const req: ActionRequest = { id: "p", sessionID: "s1", messageID: "m", kind: "bash", pattern: "rm -rf /\necho", title: "rm", opaque: false, worktree: "/w", directory: "/w" }
const cfg = { injectDenialReason: true, toast: true }

test("denialText carries marker, kind, first line, reason, rule", () => {
  const t = denialText(req, { status: "deny", reason: "root delete", settledBy: "rules", ruleId: "rm-root-home" })
  expect(t.startsWith(INJECT_MARKER)).toBe(true)
  expect(t).toContain("Denied: root delete (rule rm-root-home)")
  expect(t).toContain("Action: bash")
  expect(t).toContain("rm -rf /")
  expect(t).not.toContain("echo")
})

test("deny injects a synthetic noReply user message and toasts", async () => {
  const { client, calls } = fakeClient()
  await sendFeedback(client, cfg, req, { status: "deny", reason: "r", settledBy: "judge" }, () => {})
  expect(calls.prompt.length).toBe(1)
  expect(calls.prompt[0].path.id).toBe("s1")
  expect(calls.prompt[0].body.noReply).toBe(true)
  expect(calls.prompt[0].body.parts[0]).toMatchObject({ type: "text", synthetic: true })
  expect(calls.prompt[0].body.parts[0].text.startsWith(INJECT_MARKER)).toBe(true)
  expect(calls.toast.length).toBe(1)
  expect(calls.toast[0].body.variant).toBe("error")
})

test("fallback ask toasts only; allow does nothing; config can silence both", async () => {
  const a = fakeClient()
  await sendFeedback(a.client, cfg, req, { status: "ask", reason: "no tier decided", settledBy: "fallback" }, () => {})
  expect(a.calls.prompt.length).toBe(0)
  expect(a.calls.toast.length).toBe(1)
  expect(a.calls.toast[0].body.variant).toBe("warning")

  const b = fakeClient()
  await sendFeedback(b.client, cfg, req, { status: "allow", reason: "", settledBy: "judge" }, () => {})
  expect(b.calls.prompt.length + b.calls.toast.length).toBe(0)

  const c = fakeClient()
  await sendFeedback(c.client, { injectDenialReason: false, toast: false }, req, { status: "deny", reason: "r", settledBy: "judge" }, () => {})
  expect(c.calls.prompt.length + c.calls.toast.length).toBe(0)
})

test("client failures are logged, not thrown", async () => {
  const logs: string[] = []
  const client = { session: { prompt: async () => { throw new Error("down") } }, tui: { showToast: async () => { throw new Error("no tui") } } }
  await sendFeedback(client, cfg, req, { status: "deny", reason: "r", settledBy: "judge" }, (_l, m) => logs.push(m))
  expect(logs.length).toBe(2)
})
