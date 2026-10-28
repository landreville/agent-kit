import { describe, expect, test } from "bun:test"
import { RuntimeState } from "../src/state"
import { blottoModeTool, blottoModeToolNew } from "../src/tool"

describe("blotto_mode tool", () => {
  test("status action reports laya reachability", async () => {
    const state = new RuntimeState()
    const info = () => ({ enabled: true, layaMode: "shadow", layaReachable: false, judgeModel: "glm-5.3-flash" })
    const t: any = blottoModeTool(state, info)
    const out = await t.execute({ action: "status" }, { sessionID: "s1" })
    expect(out).toContain("laya: shadow (unreachable)")
  })

  test("laya_install reports missing binary and unset baseUrl", async () => {
    const state = new RuntimeState()
    const info = () => ({ enabled: true, layaMode: "shadow", layaReachable: false, judgeModel: "glm-5.3-flash" })
    const t: any = blottoModeTool(state, info, {
      checkPath: () => null,
      getCfg: () => ({ mode: "shadow", baseUrl: null }),
    })
    const out = await t.execute({ action: "laya_install" }, { sessionID: "s1" })
    expect(out).toContain("laya-serve not found on PATH")
    expect(out).toContain("laya.baseUrl is unset")
  })

  test("laya_install probes when baseUrl set and found binary", async () => {
    const state = new RuntimeState()
    let reachable = false
    const info = () => ({ enabled: true, layaMode: "shadow", layaReachable: reachable, judgeModel: "glm-5.3-flash" })
    const t: any = blottoModeTool(state, info, {
      checkPath: () => "/usr/bin/laya-serve",
      getCfg: () => ({ mode: "shadow", baseUrl: "http://127.0.0.1:9", timeoutMs: 50 }),
      probe: async () => true,
      setReachable: (v: boolean) => { reachable = v },
    })
    const out = await t.execute({ action: "laya_install" }, { sessionID: "s1" })
    expect(out).toContain("laya-serve found on PATH")
    expect(out).toContain("probe: reachable")
    expect(reachable).toBe(true)
  })

  test("v2 new tool shape laya_install", async () => {
    const state = new RuntimeState()
    const info = () => ({ enabled: true, layaMode: "active", layaReachable: true, judgeModel: "glm-5.3-flash" })
    const t: any = blottoModeToolNew(state, info, {
      checkPath: () => null,
      getCfg: () => ({ mode: "active", baseUrl: "http://x", timeoutMs: 50 }),
      probe: async () => false,
      setReachable: () => {},
    })
    const out: any = await t.execute({ action: "laya_install" }, { sessionID: "s1" })
    expect(out.output).toContain("probe: unreachable")
  })
})