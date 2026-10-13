import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyRules, writeConfig, existingRules, parseConfig, isValidPattern } from "../config-store.js"

const v1 = () => readFileSync(new URL("./fixtures/config-v1.jsonc", import.meta.url), "utf8")

test("applyRules inserts after the bash opener, before ask/deny rules, comments intact", () => {
  const before = v1()
  const { text, added } = applyRules(before, ["sort *", "cut *"])
  assert.deepEqual(added, ["sort *", "cut *"])
  const lines = text.split("\n")
  const bashAt = lines.findIndex((l) => l.includes('"bash"'))
  const sortAt = lines.findIndex((l) => l.includes('"sort *"'))
  const denyAt = lines.findIndex((l) => l.includes('"git push --force *"'))
  assert.ok(bashAt < sortAt && sortAt < denyAt)
  assert.ok(text.includes("// keep this comment: hand-maintained block"))
  assert.equal(lines[sortAt].match(/^ {6}"sort \*": "allow",$/).length, 1)
  // still valid config, original rules untouched
  assert.deepEqual(existingRules(parseConfig(text)), ["*", "sort *", "cut *", "git fetch *", "git push --force *", "git push -f *"])
})

test("applyRules skips present, invalid, and denied patterns", () => {
  const { added, alreadyPresent, skippedForSafety } = applyRules(v1(), ["git fetch *", "curl * | nc *", "rm *", "cut *"])
  assert.deepEqual(added, ["cut *"])
  assert.deepEqual(alreadyPresent, ["git fetch *"])
  assert.deepEqual(skippedForSafety, [
    { pattern: "curl * | nc *", reason: "invalid-pattern" },
    { pattern: "rm *", reason: "destructive filesystem mutation" },
  ])
})

test("applyRules writes into a v2 permissions array after the opener", () => {
  const v2 = readFileSync(new URL("./fixtures/config-v2.jsonc", import.meta.url), "utf8")
  const { text } = applyRules(v2, ["sort *"])
  assert.ok(text.includes('{ "action": "shell", "resource": "sort *", "effect": "allow" },'))
  const lines = text.split("\n")
  assert.ok(lines.findIndex((l) => l.includes('"permissions"')) < lines.findIndex((l) => l.includes('"sort *"')))
  assert.deepEqual(existingRules(parseConfig(text)), ["*", "sort *", "ls *"])
})

test("isValidPattern rejects shell metacharacters", () => {  assert.ok(isValidPattern("git fetch *"))
  assert.ok(!isValidPattern("curl *; nc example.com"))
  assert.ok(!isValidPattern('grep "$HOME"'))
  assert.ok(!isValidPattern("cat a > b"))
})

test("applyRules creates a bash block in a v1 config without one, as valid JSON", () => {
  const cfg = `{
  "permission": {
    "read": "allow",
    "webfetch": "ask"
  }
}`
  const { text } = applyRules(cfg, ["sort *", "cut *"])
  assert.doesNotThrow(() => parseConfig(text))
  assert.deepEqual(existingRules(parseConfig(text)), ["*", "sort *", "cut *"])
  // broad ask first so the new allows still win last-match-wins
  assert.ok(text.indexOf('"*": "ask"') < text.indexOf('"sort *"'))
  assert.ok(text.indexOf('"bash"') < text.indexOf('"*": "ask"'))
})

test("applyRules never duplicates a rule an existing deny already decides", () => {
  const cfg = `{
  "permission": {
    "bash": {
      "*": "ask",
      "sort *": "deny"
    }
  }
}`
  const { text, added, alreadyPresent } = applyRules(cfg, ["sort *"])
  assert.deepEqual(added, [])
  assert.deepEqual(alreadyPresent, ["sort *"])
  assert.equal(text, cfg, "untouched")
})

test("applyRules skips shell keywords and policy-less tools as unsafe", () => {
  const { added, skippedForSafety } = applyRules(v1(), ["for *", "cargo *", "grep *"])
  assert.deepEqual(added, ["grep *"])
  assert.deepEqual(skippedForSafety, [
    { pattern: "for *", reason: "shell keyword, not a command" },
    { pattern: "cargo *", reason: "multi-subcommand tool without a read-only subcommand policy" },
  ])
})

test("writeConfig backs up, writes, and restores on parse failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "refine-cfg-"))
  const path = join(dir, "opencode.json")
  const original = v1()
  try {
    writeFileSync(path, original)
    const { backupPath } = writeConfig(path, applyRules(original, ["sort *"]).text)
    assert.equal(readFileSync(backupPath, "utf8"), original)
    assert.ok(readFileSync(path, "utf8").includes('"sort *"'))
    // re-applying is a no-op
    const again = applyRules(readFileSync(path, "utf8"), ["sort *"])
    assert.deepEqual(again.added, [])
    assert.deepEqual(again.alreadyPresent, ["sort *"])
    // invalid content is rejected before anything is written — no backup, no touch
    assert.throws(() => writeConfig(path, "{ broken"), /invalid-config/)
    assert.equal(readFileSync(path, "utf8"), again.text)
    // a valid but unwritable write fails, restores the backup, leaves the file intact
    chmodSync(path, 0o444)
    assert.throws(() => writeConfig(path, applyRules(again.text, ["cut *"]).text), /EACCES|EROFS/)
    assert.equal(readFileSync(path, "utf8"), again.text)
    chmodSync(path, 0o644)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
