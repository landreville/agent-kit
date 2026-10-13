import { test, expect } from "bun:test"
import { RuntimeState } from "../src/state"
import { blottoModeTool } from "../src/tool"

const text = (r: any): string => (typeof r === "string" ? r : r.output)
const mkInfo = (enabled = true) => () => ({ enabled, layaMode: "shadow", layaReachable: false, judgeModel: "glm-5.3-flash" })

test("overrides are per session and default to global", () => {
  const s = new RuntimeState()
  expect(s.isEnabled("a", true)).toBe(true)
  s.setEnabled("a", false)
  expect(s.isEnabled("a", true)).toBe(false)
  expect(s.isEnabled("b", true)).toBe(true)
  s.dropSession("a")
  expect(s.isEnabled("a", true)).toBe(true)
})

// Controller ruling: the global switch disables the plugin; a session override can only narrow it.
test("session override cannot re-enable when globally disabled", () => {
  const s = new RuntimeState()
  expect(s.isEnabled("a", false)).toBe(false)
  s.setEnabled("a", true)
  expect(s.isEnabled("a", false)).toBe(false)
})

test("global true: no override enables, off override disables", () => {
  const s = new RuntimeState()
  expect(s.isEnabled("a", true)).toBe(true)
  s.setEnabled("a", false)
  expect(s.isEnabled("a", true)).toBe(false)
})

test("counters accumulate by status and tier", () => {
  const s = new RuntimeState()
  s.count("a", { status: "allow", reason: "", settledBy: "cache" })
  s.count("a", { status: "deny", reason: "", settledBy: "rules" })
  s.count("a", { status: "ask", reason: "", settledBy: "fallback" })
  expect(s.summary("a")).toEqual({ allowed: 1, denied: 1, asked: 1, byTier: { cache: 1, rules: 1, fallback: 1 } })
})

test("tool reports status and toggles the session", async () => {
  const s = new RuntimeState()
  const t = blottoModeTool(s, mkInfo())
  const ctx = { sessionID: "a" } as any
  const off = await t.execute({ action: "off" }, ctx)
  expect(text(off)).toContain("off")
  expect(s.isEnabled("a", true)).toBe(false)
  const status = text(await t.execute({ action: "status" }, ctx))
  expect(status).toContain("glm-5.3-flash"); expect(status).toContain("shadow"); expect(status).toContain("disabled for this session")
  await t.execute({ action: "on" }, ctx)
  expect(s.isEnabled("a", true)).toBe(true)
})

test("tool `on` when globally disabled does not claim success", async () => {
  const s = new RuntimeState()
  const t = blottoModeTool(s, mkInfo(false))
  const ctx = { sessionID: "a" } as any
  const out = text(await t.execute({ action: "on" }, ctx))
  expect(out).toContain("disabled globally")
  expect(s.isEnabled("a", false)).toBe(false)
  expect(text(await t.execute({ action: "status" }, ctx))).toContain("disabled globally")
})
