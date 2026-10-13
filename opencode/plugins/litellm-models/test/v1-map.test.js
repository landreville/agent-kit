import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { toV1ConfigModel } from "../v1-map.js"
import { mapModelInfoResponse, mapV1ModelsResponse } from "../catalog.js"

const loadFixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))

const modelInfoBody = loadFixture("model-info.json")
const v1ModelsBody = loadFixture("v1-models.json")

const infoRow = (id) => mapModelInfoResponse(modelInfoBody).find((m) => m.id === id)

// The V1 config hook injects cfg.provider[id].models entries in V1
// config-model syntax; opencode's config parser (provider.ts, "extend
// database from config") fills every other Model field with defaults.

test("toV1ConfigModel maps a rich row to V1 config-model syntax", () => {
  assert.deepEqual(toV1ConfigModel(infoRow("claude-sonnet-5")), {
    name: "claude-sonnet-5",
    reasoning: true,
    attachment: true,
    tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 200000, output: 32000 },
    cost: { input: 0, output: 0, cache_read: 0.2, cache_write: 2.5 },
  })
})

test("toV1ConfigModel converts per-million costs and gateway limits", () => {
  const sol = toV1ConfigModel(infoRow("gpt-5.6-sol"))
  assert.deepEqual(sol.cost, { input: 4, output: 20, cache_read: 0.4, cache_write: 5 })
  assert.deepEqual(sol.limit, { context: 922000, output: 128000 })
})

test("toV1ConfigModel uses zero cost when the catalog row has none", () => {
  for (const row of [infoRow("sparse-model"), ...mapV1ModelsResponse(v1ModelsBody)]) {
    assert.deepEqual(toV1ConfigModel(row).cost, { input: 0, output: 0, cache_read: 0, cache_write: 0 })
  }
})

test("toV1ConfigModel passes modalities through and derives attachment", () => {
  const textOnly = toV1ConfigModel({
    ...infoRow("claude-sonnet-5"),
    capabilities: { tools: true, input: ["text"], output: ["text"] },
  })
  assert.deepEqual(textOnly.modalities, { input: ["text"], output: ["text"] })
  assert.equal(textOnly.attachment, false)
  assert.equal(textOnly.tool_call, true)
})

test("toV1ConfigModel maps every fixture row without throwing", () => {
  for (const row of [...mapModelInfoResponse(modelInfoBody), ...mapV1ModelsResponse(v1ModelsBody)]) {
    const entry = toV1ConfigModel(row)
    assert.equal(typeof entry.name, "string")
    assert.deepEqual(Object.keys(entry.modalities).sort(), ["input", "output"])
    assert.ok(entry.limit && typeof entry.limit.context === "number")
    assert.ok(entry.cost && typeof entry.cost.input === "number")
    assert.equal(typeof entry.tool_call, "boolean")
  }
})
