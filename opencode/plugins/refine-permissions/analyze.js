// analyze.js — read session history from OpenCode's sqlite database.
//
// Two storage layouts are unioned because OpenCode 2.0.26 keeps both: v2 rows
// in `session_message.data.content[]` and legacy rows in `part.data`. The v2
// layout names the shell tool "shell" (it was "bash" historically), so both
// names are accepted.

import { DatabaseSync } from "node:sqlite"
import { splitSegments, extractFamilies, canonicalFamily, classify } from "./policy.js"

export const DAY_MS = 86_400_000
export const MAX_WINDOW_DAYS = 7
export const DEFAULT_MIN_COUNT = 3
export const STORAGE_KEY = "lastAnalysis"

// Tool names whose input is a shell `command`. Code Mode's `execute` carries
// code, not a command, and is deliberately excluded.
const SHELL_TOOL_NAMES = new Set(["bash", "shell"])

export class DbError extends Error {}

// Open read-only and ONLY read-only: opening a missing path read-write would
// create an empty database next to a live one. Failures throw DbError; the
// caller turns them into structured results.
export function openDatabase(dbPath) {
  try {
    return new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    throw new DbError(`db-unreadable: ${error?.message ?? error}`)
  }
}

const collectFromRow = (data, v2, into) => {
  let parsed
  try {
    parsed = JSON.parse(data)
  } catch {
    return
  }
  if (v2) {
    const content = parsed?.content
    if (!Array.isArray(content)) return
    for (const entry of content) {
      if (entry?.type !== "tool") continue
      if (!SHELL_TOOL_NAMES.has(entry?.name)) continue
      if (entry?.state?.status !== "completed") continue
      const command = entry?.state?.input?.command
      if (typeof command === "string" && command.trim()) into.push(command)
    }
    return
  }
  if (parsed?.type !== "tool" || !SHELL_TOOL_NAMES.has(parsed?.tool)) return
  if (parsed?.state?.status !== "completed") return
  const command = parsed?.state?.input?.command
  if (typeof command === "string" && command.trim()) into.push(command)
}

// Completed shell commands in [startMs, endMs]. `rowsScanned` counts every row
// read, including unparseable ones. Query failures mean the database is
// unreadable — never silently "no history".
export function extractCommands(db, { startMs, endMs }) {
  const commands = []
  const sessionIds = new Set()
  let rowsScanned = 0
  let unreadable = null

  const scan = (sql, params, v2) => {
    let rows
    try {
      rows = db.prepare(sql).all(...params)
    } catch (error) {
      const message = String(error?.message ?? error)
      // A table that no longer exists is schema drift for that layout only —
      // the other layout still counts. Anything else is unreadable.
      if (!message.includes("no such table")) {
        unreadable ??= new DbError(`db-unreadable: ${message}`)
      }
      return
    }
    for (const row of rows) {
      rowsScanned += 1
      if (row.session_id) sessionIds.add(row.session_id)
      collectFromRow(row.data, v2, commands)
    }
  }

  scan("SELECT session_id, data FROM session_message WHERE time_created BETWEEN ? AND ?", [startMs, endMs], true)
  scan("SELECT session_id, data FROM part WHERE time_created BETWEEN ? AND ?", [startMs, endMs], false)
  if (unreadable) throw unreadable

  return { commands, rowsScanned, sessionsScanned: sessionIds.size }
}

// Window start: the most recent `maxDays` days, truncated at the last analysis
// marker. A future marker (clock skew) collapses the window to now.
export function resolveStartMs(lastAnalysis, now, maxDays = MAX_WINDOW_DAYS) {
  const floor = now - maxDays * DAY_MS
  if (typeof lastAnalysis !== "number" || !Number.isFinite(lastAnalysis)) return floor
  return Math.min(Math.max(lastAnalysis, floor), now)
}

const emptySkipped = () => ({ denied: [], rare: [], covered: [] })

const failure = (error, detail, startMs, endMs) => ({
  error,
  detail,
  windowStart: startMs,
  windowEnd: endMs,
  commandsScanned: 0,
  rowsScanned: 0,
  sessionsScanned: 0,
  proposals: [],
  skipped: emptySkipped(),
})

// Aggregate observed usage into proposed allowlist patterns.
export function analyzeSessions({ dbPath, startMs, endMs, existingRules, minCount }) {
  let db
  try {
    db = openDatabase(dbPath)
  } catch (error) {
    return failure("no-history", error?.message ?? String(error), startMs, endMs)
  }

  let extracted
  try {
    extracted = extractCommands(db, { startMs, endMs })
  } catch (error) {
    return failure("db-unreadable", error?.message ?? String(error), startMs, endMs)
  } finally {
    try {
      db.close()
    } catch {
      // closing a read-only handle is best effort
    }
  }

  const { commands, rowsScanned, sessionsScanned } = extracted

  // Rows existed in the window but none were recognizable shell calls: the
  // storage layout drifted. Report it — do NOT burn the window on a guess.
  if (rowsScanned > 0 && commands.length === 0) {
    return {
      error: "no-shell-records",
      detail: `${rowsScanned} rows in window, none were recognizable shell tool calls`,
      windowStart: startMs,
      windowEnd: endMs,
      commandsScanned: 0,
      rowsScanned,
      sessionsScanned,
      proposals: [],
      skipped: emptySkipped(),
    }
  }

  const observed = new Map()
  const bump = (key, example) => {
    const entry = observed.get(key) ?? { count: 0, examples: [] }
    entry.count += 1
    if (example && !entry.examples.includes(example) && entry.examples.length < 2) {
      entry.examples.push(example.trim())
    }
    observed.set(key, entry)
  }
  for (const command of commands) {
    for (const segment of splitSegments(command)) {
      const key = canonicalFamily(segment) ?? extractFamilies(segment)[0]
      if (!key) continue
      bump(key, segment)
    }
  }
  const { proposals, skipped } = classify(observed, existingRules, { minCount })
  return {
    windowStart: startMs,
    windowEnd: endMs,
    commandsScanned: commands.length,
    rowsScanned,
    sessionsScanned,
    proposals,
    skipped,
  }
}
