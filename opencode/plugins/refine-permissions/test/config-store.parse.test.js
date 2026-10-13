import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripJsonComments, parseConfig, existingRules } from "../config-store.js"

const load = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")

test("stripJsonComments removes comments but keeps // inside strings", () => {
  const text = load("config-v1.jsonc")
  const stripped = stripJsonComments(text)
  assert.ok(!stripped.includes("// keep this comment"))
  assert.ok(stripped.includes("https://opencode.ai/config.json"))
  assert.doesNotThrow(() => JSON.parse(stripped))
})

test("stripJsonComments removes block comments", () => {
  assert.equal(stripJsonComments('{"a": 1 /* drop */, "b": "x /* y */ z"}'), '{"a": 1 , "b": "x /* y */ z"}')
})

test("parseConfig rejects malformed documents", () => {
  assert.throws(() => parseConfig("{ oops"), /invalid-config/)
})

test("existingRules reads v1 bash keys and v2 shell resources", () => {
  assert.deepEqual(existingRules(parseConfig(load("config-v1.jsonc"))), ["*", "git fetch *", "git push --force *", "git push -f *"])
  assert.deepEqual(existingRules(parseConfig(load("config-v2.jsonc"))), ["*", "ls *"])
  assert.deepEqual(existingRules({}), [])
})
