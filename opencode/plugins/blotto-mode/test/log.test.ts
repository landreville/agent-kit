import { test, expect } from "bun:test"
import { mkdtempSync, statSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DecisionLog, type DecisionRecord } from "../src/log"

function rec(id: string): DecisionRecord {
  return { kind: "decision", ts: "2026-09-30T00:00:00Z", permissionID: id, sessionID: "s", requestKind: "bash", pattern: "npm test", opaque: false, tiers: {}, final: { status: "ask", settledBy: "fallback", reason: "" } }
}

test("append creates parent dir and writes one JSON line per record", () => {
  const dir = mkdtempSync(join(tmpdir(), "blotto-log-"))
  const p = join(dir, "sub/decisions.jsonl")
  const log = new DecisionLog({ path: p, maxMb: 1 })
  log.append(rec("a")); log.append({ kind: "reply", ts: "t", permissionID: "a", sessionID: "s", response: "once" })
  const lines = readFileSync(p, "utf8").trim().split("\n")
  expect(lines.length).toBe(2)
  expect(JSON.parse(lines[0]!).permissionID).toBe("a")
  expect(log.has("a")).toBe(true); expect(log.has("zzz")).toBe(false)
})

test("rotates to .1 when over maxMb", () => {
  const dir = mkdtempSync(join(tmpdir(), "blotto-log-"))
  const p = join(dir, "d.jsonl")
  writeFileSync(p, "x".repeat(1024 * 1024 + 10))
  const log = new DecisionLog({ path: p, maxMb: 1 })
  log.append(rec("b"))
  expect(existsSync(p + ".1")).toBe(true)
  expect(statSync(p).size).toBeLessThan(2000)
})

test("read + merge attaches the latest reply to its decision and skips junk lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "blotto-log-"))
  const p = join(dir, "d.jsonl")
  writeFileSync(p, [JSON.stringify(rec("a")), "not json", JSON.stringify({ kind: "reply", ts: "t", permissionID: "a", sessionID: "s", response: "reject" }), JSON.stringify({ kind: "reply", ts: "t2", permissionID: "a", sessionID: "s", response: "once" }), JSON.stringify({ kind: "reply", ts: "t3", permissionID: "orphan", sessionID: "s", response: "once" })].join("\n") + "\n")
  const merged = DecisionLog.merge(DecisionLog.read(p))
  expect(merged.length).toBe(1)
  expect(merged[0]!.userReply).toBe("once")
})

test("has returns false for unknown id and appending reply for unknown id does not throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "blotto-log-"))
  const p = join(dir, "d.jsonl")
  const log = new DecisionLog({ path: p, maxMb: 1 })
  expect(log.has("unknown")).toBe(false)
  expect(() => log.append({ kind: "reply", ts: "t", permissionID: "unknown", sessionID: "s", response: "once" })).not.toThrow()
})

test("append never throws even when path parent is a regular file, warns once", () => {
  const dir = mkdtempSync(join(tmpdir(), "blotto-log-"))
  const blockingFile = join(dir, "blocking")
  writeFileSync(blockingFile, "content")
  const p = join(blockingFile, "sub/decisions.jsonl")

  // Final-review ruling I8: DecisionLog reports through an onError callback instead of console.error.
  const warnings: string[] = []
  const log = new DecisionLog({ path: p, maxMb: 1, onError: (m) => warnings.push(m) })
  expect(() => log.append(rec("x"))).not.toThrow()
  expect(() => log.append(rec("y"))).not.toThrow()
  expect(warnings.filter(w => w.includes("cannot write log")).length).toBe(1)
})

test("I8: a write failure without onError prints nothing; a throwing onError does not escape", () => {
  const dir = mkdtempSync(join(tmpdir(), "blotto-log-"))
  writeFileSync(join(dir, "blocking"), "content")
  const p = join(dir, "blocking/sub/d.jsonl")
  const originalError = console.error
  const printed: string[] = []
  console.error = (...args: any[]) => { printed.push(String(args[0])) }
  try {
    new DecisionLog({ path: p, maxMb: 1 }).append(rec("x"))
    expect(() => new DecisionLog({ path: p, maxMb: 1, onError: () => { throw new Error("x") } }).append(rec("y"))).not.toThrow()
  } finally { console.error = originalError }
  expect(printed).toEqual([])
})

test("M5: log file is created 0600 and its directory 0700", () => {
  const dir = mkdtempSync(join(tmpdir(), "blotto-log-"))
  const p = join(dir, "fresh/decisions.jsonl")
  new DecisionLog({ path: p, maxMb: 1 }).append(rec("a"))
  expect(statSync(p).mode & 0o777).toBe(0o600)
  expect(statSync(join(dir, "fresh")).mode & 0o777).toBe(0o700)
})
