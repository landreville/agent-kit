import { test, expect } from "bun:test"
import { SessionCache, normalizePattern, cacheTier } from "../src/cache"
import { DEFAULT_RULES } from "../src/rules/defaults"
import { normalize } from "../src/request"
import type { Permission } from "@opencode-ai/sdk"
import type { TierEnv } from "../src/types"

const env = { worktree: "/home/u/proj", directory: "/home/u/proj", homedir: "/home/u" }
function req(cmd: string, session = "s1") {
  const p: Permission = { id: "p" + Math.random(), type: "bash", pattern: cmd, sessionID: session, messageID: "m", title: "t", metadata: {}, time: { created: 0 } }
  return normalize(p, env)!
}
function cache(sessionPatterns = true) { return new SessionCache({ rules: DEFAULT_RULES, homedir: "/home/u", sessionPatterns }) }

test("normalizePattern collapses whitespace", () => {
  expect(normalizePattern("  npm   test \n")).toBe("npm test")
})

test("exact hit within session, miss across sessions", () => {
  const c = cache()
  c.remember(req("npm test"), { status: "allow", reason: "ok", settledBy: "judge" })
  expect(c.lookup(req("npm  test"))?.status).toBe("allow")
  expect(c.lookup(req("npm test", "s2"))).toBeUndefined()
  expect(c.lookup(req("npm run build"))).toBeUndefined()
})

test("glob from decision is stored and matches later requests", () => {
  const c = cache()
  c.remember(req("npm test -- foo"), { status: "allow", reason: "ok", settledBy: "judge", sessionPattern: "npm test *" })
  expect(c.lookup(req("npm test -- bar"))?.settledBy).toBe("cache")
  expect(c.lookup(req("npm publish"))).toBeUndefined()
})

test("glob hits only for single, non-opaque commands", () => {
  const c = cache()
  c.remember(req("npm test -- foo"), { status: "allow", reason: "ok", settledBy: "judge", sessionPattern: "npm test *" })
  expect(c.lookup(req("npm test && docker system prune -af"))).toBeUndefined()
  expect(c.lookup(req("npm test -- x"))?.status).toBe("allow")
  const opaque = req("npm test $(")
  expect(opaque.opaque).toBe(true)
  expect(c.lookup(opaque)).toBeUndefined()
})

test("lookupHit reports exact vs glob", () => {
  const c = cache()
  c.remember(req("npm test -- foo"), { status: "allow", reason: "ok", settledBy: "judge", sessionPattern: "npm test *" })
  expect(c.lookupHit(req("npm test -- foo"))?.via).toBe("exact")
  expect(c.lookupHit(req("npm test -- bar"))?.via).toBe("glob")
  expect(c.lookupHit(req("npm publish"))).toBeUndefined()
})

test("cacheTier writes trace.cache.hit from hit type", async () => {
  const c = cache()
  c.remember(req("npm test -- foo"), { status: "allow", reason: "ok", settledBy: "judge", sessionPattern: "npm test *" })
  const tier = cacheTier(c)
  const mk = (): TierEnv => ({ context: async () => { throw new Error("no") }, signals: [], trace: {}, log: () => {} })
  for (const [cmd, want] of [["npm test -- foo", "exact"], ["npm test -- bar", "glob"], ["npm publish", null]] as const) {
    const e = mk()
    await tier(req(cmd), e)
    expect(e.trace.cache).toEqual({ hit: want })
  }
})

test("glob guard rejects broad or dangerous globs", () => {
  const c = cache()
  const r = req("rm -rf build")
  expect(c.validateGlob("*", "bash", r)).toBe(false)
  expect(c.validateGlob("rm *", "bash", r)).toBe(false)          // one literal token
  expect(c.validateGlob("* -rf build", "bash", r)).toBe(false)   // wildcard before first literal
  expect(c.validateGlob("rm -rf *", "bash", r)).toBe(false)      // controller ruling: probe expansions (/, ~, ../..) hit hard rules
  expect(c.validateGlob("sudo apt *", "bash", r)).toBe(false)    // literal prefix hits a hard rule
  expect(c.validateGlob("git push --force *", "bash", r)).toBe(false)
  expect(c.validateGlob("npm test *", "bash", req("npm test x"))).toBe(true) // request must be covered by glob (ruling 2)
})

// Final-review ruling I3: judge denies are no longer cached (exactly or as globs), so a later explicit
// user approval reaches the judge. The brief-era expectation "cached exactly" is reversed here.
test("deny decisions are never cached, exactly or as globs", () => {
  const c = cache()
  c.remember(req("rm -rf build"), { status: "deny", reason: "no", settledBy: "judge", sessionPattern: "rm -rf *" })
  expect(c.lookup(req("rm -rf build"))).toBeUndefined()
  expect(c.lookup(req("rm -rf dist"))).toBeUndefined()
})

test("sessionPatterns=false ignores globs", () => {
  const c = cache(false)
  c.remember(req("npm test a"), { status: "allow", reason: "ok", settledBy: "judge", sessionPattern: "npm test *" })
  expect(c.lookup(req("npm test b"))).toBeUndefined()
})

test("dropSession clears and LRU caps at maxPerSession", () => {
  const c = new SessionCache({ rules: DEFAULT_RULES, homedir: "/home/u", sessionPatterns: true, maxPerSession: 2 })
  c.remember(req("a1"), { status: "allow", reason: "", settledBy: "judge" })
  c.remember(req("a2"), { status: "allow", reason: "", settledBy: "judge" })
  c.remember(req("a3"), { status: "allow", reason: "", settledBy: "judge" })
  expect(c.lookup(req("a1"))).toBeUndefined()
  expect(c.lookup(req("a3"))).toBeDefined()
  c.dropSession("s1")
  expect(c.lookup(req("a3"))).toBeUndefined()
})

test("exact key preserves newlines", () => {
  const c = cache()
  c.remember(req("echo a rm -rf build"), { status: "allow", reason: "ok", settledBy: "judge" })
  expect(c.lookup(req("echo a rm -rf build"))?.status).toBe("allow")
  expect(c.lookup(req("echo a\nrm -rf build"))).toBeUndefined()
})

test("validateGlob requires glob to cover its own request", () => {
  const c = cache()
  expect(c.validateGlob("git push origin *", "bash", req("git status"))).toBe(false)
  expect(c.validateGlob("npm test *", "bash", req("npm test x"))).toBe(true)
})

test("validateGlob probes wildcard expansions against rules", () => {
  const c = cache()
  expect(c.validateGlob("chmod -R 777 *", "bash", req("chmod -R 777 build"))).toBe(false)
  expect(c.validateGlob("npm test *", "bash", req("npm test x"))).toBe(true)
})

test("globs do not match commands with redirects", () => {
  const c = cache()
  c.remember(req("npm test -- foo"), { status: "allow", reason: "ok", settledBy: "judge", sessionPattern: "npm test *" })
  expect(c.lookup(req("npm test x > /home/u/proj/foo.sh"))).toBeUndefined()
  expect(c.lookup(req("npm test x &"))?.status).toBe("allow")
})

// --- final review fix wave ---

function mcpReq(type: string, pattern: string | undefined, metadata: Record<string, unknown> = {}, session = "s1") {
  const p = { id: "p" + Math.random(), type, pattern, sessionID: session, messageID: "m", title: "t", metadata, time: { created: 0 } } as unknown as Permission
  return normalize(p, env)!
}

test("C3: two MCP tools with identical patterns do not share a cache entry", () => {
  const c = cache()
  c.remember(mcpReq("playwright__browser_snapshot", undefined), { status: "allow", reason: "ok", settledBy: "judge" })
  expect(c.lookup(mcpReq("playwright__browser_snapshot", undefined))?.status).toBe("allow")
  expect(c.lookup(mcpReq("github__delete_repository", undefined))).toBeUndefined()
  c.remember(mcpReq("slack__post_message", "*"), { status: "allow", reason: "ok", settledBy: "judge" })
  expect(c.lookup(mcpReq("github__delete_repository", "*"))).toBeUndefined()
})

test("C3: an MCP exact entry is keyed on the tool arguments too", () => {
  const c = cache()
  c.remember(mcpReq("github__delete_repository", "", { repo: "scratch" }), { status: "allow", reason: "ok", settledBy: "judge" })
  expect(c.lookup(mcpReq("github__delete_repository", "", { repo: "scratch" }))?.status).toBe("allow")
  expect(c.lookup(mcpReq("github__delete_repository", "", { repo: "prod" }))).toBeUndefined()
})

test("C3: edit and write permission types do not share exact entries", () => {
  const c = cache()
  const mk = (type: string) => normalize({ id: "p", type, pattern: "src/a.ts", sessionID: "s1", messageID: "m", title: "t", metadata: {}, time: { created: 0 } } as Permission, env)!
  c.remember(mk("edit"), { status: "allow", reason: "ok", settledBy: "judge" })
  expect(c.lookup(mk("edit"))?.status).toBe("allow")
  expect(c.lookup(mk("write"))).toBeUndefined()
})

test("C3: MCP globs apply only within the same server/tool", () => {
  const c = cache()
  c.remember(mcpReq("fs__read_file", "read file a"), { status: "allow", reason: "ok", settledBy: "judge", sessionPattern: "read file *" })
  expect(c.lookup(mcpReq("fs__read_file", "read file b"))?.status).toBe("allow")
  expect(c.lookup(mcpReq("fs__write_file", "read file b"))).toBeUndefined()
})

test("C1: glob guard rejects globs whose first token runs other code", () => {
  const c = cache()
  for (const [glob, cmd] of [
    ["bash -lc *", "bash -lc 'npm test'"], ["sh -c *", "sh -c 'npm test'"], ["/bin/bash -c *", "/bin/bash -c 'npm test'"],
    ["eval npm *", "eval npm test"], ["source ./env *", "source ./env x"], [". ./env *", ". ./env x"],
    ["env FOO=1 *", "env FOO=1 make"], ["xargs -n1 *", "xargs -n1 echo"], ["find . *", "find . -name x"],
    ["sudo -n *", "sudo -n ls"], ["python3 -m *", "python3 -m pytest"], ["node scripts/*", "node scripts/a.js"],
    ["perl -ne *", "perl -ne x"], ["ruby -e *", "ruby -e x"], ["php -r *", "php -r x"], ["deno run *", "deno run a.ts"], ["bun run *", "bun run test"],
    ["zsh -c *", "zsh -c x"], ["fish -c *", "fish -c x"], ["timeout 60 *", "timeout 60 make"],
  ] as const) expect([glob, c.validateGlob(glob, "bash", req(cmd))]).toEqual([glob, false])
  expect(c.validateGlob("npm test *", "bash", req("npm test x"))).toBe(true)
})

test("C1: bash -lc payload never rides a glob, even one stored before the fix", () => {
  const c = cache()
  // Simulate a glob that slipped in: lookup still refuses a request that carries inline code.
  ;(c as any).sessions.set("s1", { exact: new Map(), globs: [{ glob: "bash -lc *", kind: "bash", scope: "bash:bash", decision: { status: "allow", reason: "x", settledBy: "judge" } }] })
  expect(c.lookup(req("bash -lc 'rm -rf build'"))).toBeUndefined()
})

test("I6: a single command carrying inline code is excluded from glob hits", () => {
  const c = cache()
  ;(c as any).sessions.set("s1", { exact: new Map(), globs: [
    { glob: "python3 *", kind: "bash", scope: "bash:bash", decision: { status: "allow", reason: "x", settledBy: "judge" } },
    { glob: "find . *", kind: "bash", scope: "bash:bash", decision: { status: "allow", reason: "x", settledBy: "judge" } },
  ] })
  expect(c.lookup(req("python3 -c 'import os'"))).toBeUndefined()
  expect(c.lookup(req("find . -name x -exec ls \\;"))).toBeUndefined()
  expect(c.lookup(req("find . -name x -execdir ls \\;"))).toBeUndefined()
  expect(c.lookup(req("python3 script.py"))?.status).toBe("allow")
  expect(c.lookup(req("find . -name x"))?.status).toBe("allow")
})

test("C2: a nested substitution never hits a git log glob", () => {
  const c = cache()
  c.remember(req("git log --oneline"), { status: "allow", reason: "ok", settledBy: "judge", sessionPattern: "git log *" })
  expect(c.lookup(req("git log -5"))?.status).toBe("allow")
  expect(c.lookup(req("git log ${x:-$(rm -rf ~)}"))).toBeUndefined()
})
