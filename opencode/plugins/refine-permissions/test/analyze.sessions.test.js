import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, existsSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DAY_MS, resolveStartMs, analyzeSessions } from "../analyze.js"

const NOW = 1_800_000_000_000

test("resolveStartMs caps the window at 7 days and clamps clock skew", () => {
  assert.equal(resolveStartMs(null, NOW), NOW - 7 * DAY_MS)
  assert.equal(resolveStartMs(NOW - DAY_MS, NOW), NOW - DAY_MS)
  assert.equal(resolveStartMs(NOW - 30 * DAY_MS, NOW), NOW - 7 * DAY_MS)
  assert.equal(resolveStartMs(NOW + 3_600_000, NOW), NOW)
})

const seed = (commands) => {
  const dir = mkdtempSync(join(tmpdir(), "refine-sess-"))
  const db = new DatabaseSync(join(dir, "opencode.db"))
  db.exec("CREATE TABLE session_message (session_id TEXT, time_created INTEGER, data TEXT)")
  const t = NOW - 1000
  for (const c of commands) {
    db.prepare("INSERT INTO session_message (session_id, time_created, data) VALUES (?, ?, ?)").run(
      "ses_1",
      t,
      JSON.stringify({ content: [{ type: "tool", name: "bash", state: { status: "completed", input: { command: c } } }] }),
    )
  }
  db.close()
  return { dir, path: join(dir, "opencode.db") }
}

test("analyzeSessions proposes uncovered safe families and reports skipped ones", () => {
  const { dir, path } = seed([
    "git fetch origin", "git fetch upstream", "git fetch origin", "git fetch filtered",
    "ls -la", // covered below
    "rm -rf build", "rm -rf build", "rm -rf build", // denied, above minCount
    "sleep 1", // below minCount
  ])
  try {
    const result = analyzeSessions({ dbPath: path, startMs: NOW - DAY_MS, endMs: NOW, existingRules: ["ls *"], minCount: 3 })
    assert.equal(result.error, undefined)
    assert.equal(result.commandsScanned, 9) // 4 fetch + 1 ls + 3 rm + 1 sleep
    assert.deepEqual(result.proposals.map((p) => p.pattern), ["git fetch *"])
    assert.equal(result.proposals[0].count, 4)
    assert.equal(result.skipped.covered[0], "ls")
    assert.equal(result.skipped.denied[0].family, "rm")
    assert.deepEqual(result.skipped.rare, [{ family: "sleep", count: 1 }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("analyzeSessions returns no-history without throwing when the DB is missing", () => {
  const result = analyzeSessions({ dbPath: "/nonexistent/opencode.db", startMs: NOW - DAY_MS, endMs: NOW, existingRules: [], minCount: 3 })
  assert.equal(result.error, "no-history")
  assert.deepEqual(result.proposals, [])
  assert.equal(result.commandsScanned, 0)
})

test("analyzeSessions reports no-history and creates nothing when the DB is missing inside an existing dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "refine-missing-"))
  const path = join(dir, "opencode.db")
  try {
    const result = analyzeSessions({ dbPath: path, startMs: NOW - DAY_MS, endMs: NOW, existingRules: [], minCount: 3 })
    assert.equal(result.error, "no-history")
    assert.equal(existsSync(path), false, "must not create an empty database")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("analyzeSessions reports db-unreadable for a corrupt file", () => {
  const dir = mkdtempSync(join(tmpdir(), "refine-corrupt-"))
  const path = join(dir, "opencode.db")
  writeFileSync(path, "this is definitely not a sqlite database")
  try {
    const result = analyzeSessions({ dbPath: path, startMs: NOW - DAY_MS, endMs: NOW, existingRules: [], minCount: 3 })
    assert.equal(result.error, "db-unreadable")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("analyzeSessions reports layout drift when rows exist but no shell calls are recognized", () => {
  const { dir, path } = seed(["ls -la"])
  const db = new DatabaseSync(path)
  // rewrite the rows so the shell tool is unrecognizably named
  db.exec("DELETE FROM session_message")
  db.prepare("INSERT INTO session_message (session_id, time_created, data) VALUES (?, ?, ?)").run(
    "ses_x",
    NOW - 1000,
    JSON.stringify({ content: [{ type: "tool", name: "mystery", state: { status: "completed", input: { command: "ls -la" } } }] }),
  )
  db.close()
  try {
    const result = analyzeSessions({ dbPath: path, startMs: NOW - DAY_MS, endMs: NOW, existingRules: [], minCount: 3 })
    assert.equal(result.error, "no-shell-records")
    assert.equal(result.rowsScanned, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("analyzeSessions counts distinct sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "refine-multi-"))
  const db = new DatabaseSync(join(dir, "opencode.db"))
  db.exec("CREATE TABLE session_message (session_id TEXT, time_created INTEGER, data TEXT)")
  const add = (sid, cmd) => db.prepare("INSERT INTO session_message VALUES (?, ?, ?)").run(
    sid, NOW - 1000,
    JSON.stringify({ content: [{ type: "tool", name: "shell", state: { status: "completed", input: { command: cmd } } }] }),
  )
  add("ses_a", "git fetch origin")
  add("ses_a", "git fetch upstream")
  add("ses_b", "sort -u f")
  add("ses_b", "cut -f1 f")
  db.close()
  try {
    const result = analyzeSessions({ dbPath: join(dir, "opencode.db"), startMs: NOW - DAY_MS, endMs: NOW, existingRules: [], minCount: 1 })
    assert.equal(result.sessionsScanned, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
