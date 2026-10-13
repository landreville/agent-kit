import { test } from "node:test"
import assert from "node:assert/strict"

import plugin from "../index.js"
import { setup as setupV2 } from "../v2.js"

// Mirrors opencode's V1 loader (packages/opencode/src/plugin/index.ts):
// readV1Plugin detect mode accepts a default-exported object carrying id
// and/or server; the legacy getLegacyPlugins scan accepts any export that
// is a function or an object whose server is a function.

test("the default export carries both generation entrypoints", () => {
  assert.equal(plugin.id, "litellm-models")
  assert.equal(typeof plugin.setup, "function")
  assert.equal(plugin.setup, setupV2)
  assert.equal(typeof plugin.server, "function")
})

test("the V1 loader's detect path finds server()", async () => {
  const mod = await import("../index.js")
  assert.ok(mod.default && typeof mod.default === "object")
  assert.ok("id" in mod.default)
  assert.ok("server" in mod.default)
  const hooks = await mod.default.server({}, {})
  assert.equal(typeof hooks.config, "function")
  assert.equal(typeof hooks.dispose, "function")
})

test("the legacy export scan accepts the module", async () => {
  const mod = await import("../index.js")
  const plugins = []
  for (const entry of Object.values(mod)) {
    const found = typeof entry === "function" ? entry : entry?.server
    assert.equal(typeof found, "function", "every export must be a function or { server }")
    plugins.push(found)
  }
  assert.deepEqual(plugins, [plugin.server])
})
