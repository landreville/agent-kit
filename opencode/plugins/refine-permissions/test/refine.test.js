import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { runAnalyze, runApply, makeTool, STORAGE_KEY } from "../refine.js"

const makeCtx = (initial = {}) => {
  const map = new Map(Object.entries(initial))
  return {
    store: map,
    storage: {
      get: async (k) => map.get(k),
      set: async (k, v) => void map.set(k, v),
      remove: async (k) => void map.delete(k),
    },
  }
}

const seedDb = (n) => {
  const dir = mkdtempSync(join(tmpdir(), "refine-rt-"))
  const db = new DatabaseSync(join(dir, "opencode.db"))
  db.exec("CREATE TABLE session_message (session_id TEXT, time_created INTEGER, data TEXT)")
  for (let i = 0; i < n; i++) {
    db.prepare("INSERT INTO session_message (session_id, time_created, data) VALUES (?, ?, ?)").run(
      "ses_seed", Date.now() - 1000,
      JSON.stringify({ content: [{ type: "tool", name: "shell", state: { status: "completed", input: { command: "sort -u db.rb" } } }] }))
  }
  db.close()
  return { dir, path: join(dir, "opencode.db") }
}

const withConfig = () => {
  const dir = mkdtempSync(join(tmpdir(), "refine-cfg-"))
  const path = join(dir, "opencode.json")
  copyFileSync(new URL("./fixtures/config-v1.jsonc", import.meta.url), path)
  return { dir, path, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test("runAnalyze proposes rules and advances the marker", async () => {
  const db = seedDb(4)
  const cfg = withConfig()
  try {
    const ctx = makeCtx()
    const result = await runAnalyze(ctx, { dbPath: db.path, configPath: cfg.path, minCount: 3 })
    assert.deepEqual(result.proposals.map((p) => p.pattern), ["sort *"])
    assert.ok(Math.abs(ctx.store.get(STORAGE_KEY) - Date.now()) < 1000, "marker set")
  } finally { rmSync(db.dir, { recursive: true, force: true }); cfg.done() }
})

test("runAnalyze with a fresh marker proposes nothing and still advances", async () => {
  const db = seedDb(4)
  const cfg = withConfig()
  try {
    const before = Date.now()
    const ctx = makeCtx({ [STORAGE_KEY]: before })
    const result = await runAnalyze(ctx, { dbPath: db.path, configPath: cfg.path, minCount: 3 })
    assert.deepEqual(result.proposals, [])
    assert.ok(ctx.store.get(STORAGE_KEY) >= before, "marker advanced")
  } finally { rmSync(db.dir, { recursive: true, force: true }); cfg.done() }
})

test("runAnalyze missing DB returns no-history and leaves the marker untouched", async () => {
  const cfg = withConfig()
  try {
    const ctx = makeCtx()
    const result = await runAnalyze(ctx, { dbPath: "/nope/opencode.db", configPath: cfg.path })
    assert.equal(result.error, "no-history")
    assert.equal(ctx.store.has(STORAGE_KEY), false)
  } finally { cfg.done() }
})

test("runApply adds valid rules, skips denied ones, writes a backup", async () => {
  const cfg = withConfig()
  try {
    const ctx = makeCtx()
    const result = await runApply(ctx, { configPath: cfg.path }, ["sort *", "rm *"])
    assert.deepEqual(result.added, ["sort *"])
    assert.deepEqual(result.skippedForSafety, [{ pattern: "rm *", reason: "destructive filesystem mutation" }])
    assert.ok(readFileSync(cfg.path, "utf8").includes('"git fetch *"'))
    assert.ok(readFileSync(result.backupPath, "utf8").includes('"*": "ask"'))
  } finally { cfg.done() }
})

test("makeTool exposes analyze/apply modes", async () => {
  const cfg = withConfig()
  const db = seedDb(3)
  try {
    const ctx = makeCtx()
    const tool = makeTool(ctx, { dbPath: db.path, configPath: cfg.path, minCount: 3 })
    assert.equal(tool.name, "refine_permissions")
    assert.deepEqual(tool.input.required, ["mode"])
    const analyzed = JSON.parse((await tool.execute({ mode: "analyze" })).content)
    assert.deepEqual(analyzed.proposals.map((p) => p.pattern), ["sort *"])
    const applied = JSON.parse((await tool.execute({ mode: "apply", rules: ["sort *"] })).content)
    assert.deepEqual(applied.added, ["sort *"])
  } finally { rmSync(db.dir, { recursive: true, force: true }); cfg.done() }
})

test("execute returns a structured error instead of throwing when the config is unreadable", async () => {
  const ctx = makeCtx()
  const tool = makeTool(ctx, { configPath: "/nope/opencode.json", dbPath: "/nope/opencode.db" })
  const res = JSON.parse((await tool.execute({ mode: "apply", rules: ["sort *"] })).content)
  assert.equal(res.error, "config-unreadable")
  assert.deepEqual(res.added, [])
})

test("execute returns a structured error for an unparseable config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "refine-badcfg-"))
  const path = join(dir, "opencode.json")
  writeFileSync(path, "{ not json at all")
  try {
    const ctx = makeCtx()
    const tool = makeTool(ctx, { configPath: path })
    const res = JSON.parse((await tool.execute({ mode: "analyze" })).content)
    assert.equal(res.error, "config-unreadable")
    // nothing was written and the marker did not advance
    assert.equal(ctx.store.has(STORAGE_KEY), false)
    assert.equal(readFileSync(path, "utf8"), "{ not json at all")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("writeConfig names the backup per the README convention", async () => {
  const cfg = withConfig()
  try {
    const ctx = makeCtx()
    const result = await runApply(ctx, { configPath: cfg.path }, ["sort *"])
    assert.match(result.backupPath, /opencode\.json\.pre-refine-permissions-backup-\d+\.json$/)
  } finally { cfg.done() }
})
