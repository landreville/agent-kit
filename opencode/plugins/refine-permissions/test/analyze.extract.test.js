import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { openDatabase, extractCommands } from "../analyze.js"

const seedDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "refine-db-"))
  const db = new DatabaseSync(join(dir, "opencode.db"))
  db.exec("CREATE TABLE session_message (session_id TEXT, time_created INTEGER, data TEXT)")
  db.exec("CREATE TABLE part (session_id TEXT, time_created INTEGER, data TEXT)")
  const t = 1_700_000_000_000
  const add = (table, time, data, sid = "ses_seed") =>
    db.prepare(`INSERT INTO ${table} (session_id, time_created, data) VALUES (?, ?, ?)`).run(sid, time, data)
  // in-window, completed, bash → included
  add("session_message", t + 10, JSON.stringify({ content: [
    { type: "tool", name: "bash", state: { status: "completed", input: { command: "git fetch origin" } } },
  ] }))
  // in-window, still running → excluded
  add("session_message", t + 20, JSON.stringify({ content: [
    { type: "tool", name: "bash", state: { status: "running", input: { command: "git fetch" } } },
  ] }))
  // in-window, wrong tool → excluded
  add("session_message", t + 30, JSON.stringify({ content: [
    { type: "tool", name: "read", state: { status: "completed", input: { filePath: "/x" } } },
  ] }))
  // legacy layout, in-window → included
  add("part", t + 40, JSON.stringify({ type: "tool", tool: "bash", state: { status: "completed", input: { command: "sort x | uniq" } } }))
  // v2 layout on this OpenCode names the shell tool "shell" → included
  add("session_message", t + 45, JSON.stringify({ content: [
    { type: "tool", name: "shell", state: { status: "completed", input: { command: "wc -l f" } } },
  ] }))
  // Code Mode executor carries code, not a command → excluded
  add("session_message", t + 46, JSON.stringify({ content: [
    { type: "tool", name: "execute", state: { status: "completed", input: { code: "git reset --hard" } } },
  ] }))
  // outside window → excluded
  add("session_message", t - 1_000, JSON.stringify({ content: [
    { type: "tool", name: "bash", state: { status: "completed", input: { command: "head -1 f" } } },
  ] }))
  // unparseable → skipped
  add("part", t + 50, "{not json")
  db.close()
  return { dir, path: join(dir, "opencode.db") }
}

test("extractCommands unions both layouts, completed bash only, window-bounded", () => {
  const { dir, path } = seedDb()
  try {
    const db = openDatabase(path)
    const { commands, rowsScanned } = extractCommands(db, { startMs: 1_700_000_000_000, endMs: 1_700_000_001_000 })
    assert.deepEqual(commands.sort(), ["git fetch origin", "sort x | uniq", "wc -l f"])
    assert.equal(rowsScanned, 7) // 5 session_message + 2 part rows inside the window
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
