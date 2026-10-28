import { test, expect } from "bun:test"
import { setup } from "../src/v2"

test("v2 setup loads and registers an evaluate hook without throwing", async () => {
  const calls: any[] = []
  const ctx: any = {
    location: { directory: "/tmp/proj", project: { id: "p", directory: "/tmp/proj" } },
    options: {},
    app: { log: async (o: any) => { calls.push(o); return { data: true } } },
    session: {
      get: async (o: any) => ({ id: o.sessionID }),
      message: { list: async () => ({ data: [] }) },
      synthetic: async () => ({}),
    },
    permission: {
      hook: async (name: string, cb: any) => { ctx._cb = cb; return { dispose: async () => {} } },
    },
    event: { subscribe: async function* () {} },
  }
  // The decision log is derived from homedir; without injection the v2 path
  // would write the real ~/.local/share/blotto-mode/decisions.jsonl (verified
  // live in the Phase 4 drill). Tests must isolate it.
  const home = `/tmp/opencode/blotto-smoke-${process.pid}-${Math.floor(Math.random() * 1e6)}`
  const cleanup = await setup(ctx, { homedir: home })
  expect(typeof cleanup).toBe("function")
  expect(typeof ctx._cb).toBe("function")
  // hard rule deny flows through
  const ev2: any = { sessionID: "s1", action: "bash", resources: ["rm -rf ~"], metadata: {}, effect: "ask" }
  await ctx._cb(ev2)
  expect(ev2.effect).toBe("deny")

  // the decision landed under the injected homedir, not the real one
  const { existsSync } = await import("node:fs")
  const { join } = await import("node:path")
  const os = await import("node:os")
  const realHome = os.homedir()
  if (existsSync(join(realHome, ".local", "share", "blotto-mode", "decisions.jsonl"))) {
    const real = (await import("node:fs")).readFileSync(
      join(realHome, ".local", "share", "blotto-mode", "decisions.jsonl"),
      "utf8",
    )
    expect(real.includes('"s1"')).toBe(false)
  }
  expect(existsSync(join(home, ".local", "share", "blotto-mode", "decisions.jsonl"))).toBe(true)
  await import("node:fs").then((fs) => fs.rmSync(home, { recursive: true, force: true }))

  await cleanup()
})
