import { test, mock } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import plugin from "../index.js"
import { mapModelInfoResponse } from "../catalog.js"

const modelInfoBody = JSON.parse(
  readFileSync(new URL("./fixtures/model-info.json", import.meta.url), "utf8"),
)

const PROVIDER_ID = "litellm"
const BASE = "https://gateway.example/v1"

const expectedFrom = (body) =>
  mapModelInfoResponse(body).map((model) => ({ ...model, providerID: PROVIDER_ID }))

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// fetch stub: routes map URL pathname -> () => Response (fresh per call)
const stubFetch = (routes) => {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    const respond = routes[new URL(url).pathname]
    if (respond === undefined) throw new Error(`unexpected fetch: ${url}`)
    return respond(init)
  }
  fn.calls = calls
  return fn
}

// mock ctx per the plan: transform captured + invoked on demand, reload counted,
// Map-backed storage, scripted credential via integration.connection.active
const makeCtx = ({ options = {}, credential, cache } = {}) => {
  const storage = new Map()
  if (cache !== undefined) storage.set("catalog", cache)
  const calls = { reloads: 0, transform: undefined }
  const ctx = {
    options,
    provider: {
      transform: async (cb) => {
        calls.transform = cb
      },
      reload: async () => {
        calls.reloads += 1
      },
    },
    storage: {
      get: (key) => storage.get(key),
      set: (key, value) => {
        storage.set(key, value)
      },
    },
    integration: {
      connection: {
        active: async () => credential,
        resolve: async (connection) => ({ type: "api_key", key: connection?.key }),
      },
    },
  }
  return { ctx, calls, storage }
}

const makeEditor = ({ existing = true } = {}) => {
  const calls = { set: [], add: [] }
  const editor = {
    get: (id) => (existing ? { id } : undefined),
    models: { set: (id, models) => calls.set.push({ id, models }) },
    add: (entry) => calls.add.push(entry),
  }
  return { editor, calls }
}

// run fn with the plugin's env fallbacks unset, restoring them after
const noEnv = async (fn) => {
  const names = ["OPENCODE_LITELLM_API_KEY", "LITELLM_API_KEY"]
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  for (const name of names) delete process.env[name]
  try {
    await fn()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test("successful fetch registers the mapped catalog and seeds the cache", async () => {
  await noEnv(async () => {
    const originalFetch = globalThis.fetch
    const fetch = stubFetch({ "/v1/model/info": () => jsonResponse(modelInfoBody) })
    globalThis.fetch = fetch
    try {
      assert.equal(plugin.id, "litellm-models")
      assert.equal(typeof plugin.setup, "function")

      const { ctx, calls, storage } = makeCtx({
        credential: { key: "sk-test" },
        options: { baseURL: BASE, refreshIntervalSec: 0 },
      })
      const cleanup = await plugin.setup(ctx)
      assert.equal(typeof cleanup, "function")

      const { editor, calls: editorCalls } = makeEditor()
      await calls.transform(editor)
      assert.deepEqual(editorCalls.set, [{ id: PROVIDER_ID, models: expectedFrom(modelInfoBody) }])
      assert.equal(editorCalls.add.length, 0)

      // cache holds the raw mapped catalog (providerID stamped at transform time)
      assert.deepEqual(storage.get("catalog"), mapModelInfoResponse(modelInfoBody))

      // the credential store's key was used for the fetch
      assert.equal(fetch.calls[0].init.headers.authorization, "Bearer sk-test")

      await cleanup()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test("failed fetch serves the cached catalog", async () => {
  await noEnv(async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error("network down")
    }
    try {
      const cached = mapModelInfoResponse(modelInfoBody).slice(0, 2)
      const { ctx, calls } = makeCtx({
        credential: { key: "sk" },
        cache: cached,
        options: { baseURL: BASE, refreshIntervalSec: 0 },
      })
      await plugin.setup(ctx)
      const { editor, calls: editorCalls } = makeEditor()
      await calls.transform(editor)
      assert.deepEqual(editorCalls.set, [
        { id: PROVIDER_ID, models: cached.map((model) => ({ ...model, providerID: PROVIDER_ID })) },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test("failed fetch with no cache yields an empty catalog without throwing", async () => {
  await noEnv(async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error("network down")
    }
    try {
      const { ctx, calls } = makeCtx({
        credential: { key: "sk" },
        options: { baseURL: BASE, refreshIntervalSec: 0 },
      })
      await plugin.setup(ctx)
      const { editor, calls: editorCalls } = makeEditor()
      await calls.transform(editor)
      assert.deepEqual(editorCalls.set, [{ id: PROVIDER_ID, models: [] }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test("no credential and no env skips fetching entirely and serves the cache", async () => {
  await noEnv(async () => {
    const originalFetch = globalThis.fetch
    const fetch = stubFetch({})
    globalThis.fetch = fetch
    try {
      const cached = mapModelInfoResponse(modelInfoBody).slice(0, 1)
      const { ctx, calls } = makeCtx({
        credential: undefined,
        cache: cached,
        options: { baseURL: BASE, refreshIntervalSec: 0 },
      })
      await plugin.setup(ctx)
      assert.equal(fetch.calls.length, 0)

      const { editor, calls: editorCalls } = makeEditor()
      await calls.transform(editor)
      assert.deepEqual(editorCalls.set[0].models, cached.map((m) => ({ ...m, providerID: PROVIDER_ID })))
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test("key resolution falls back through the env chain in order", async () => {
  const originalFetch = globalThis.fetch
  const fetch = stubFetch({ "/v1/model/info": () => jsonResponse(modelInfoBody) })
  globalThis.fetch = fetch
  await noEnv(async () => {
    try {
      process.env.OPENCODE_LITELLM_API_KEY = "sk-opencode"
      process.env.LITELLM_API_KEY = "sk-litellm"
      const base = { credential: undefined, options: { baseURL: BASE, refreshIntervalSec: 0 } }

      // OPENCODE_LITELLM_API_KEY wins over LITELLM_API_KEY
      let { ctx } = makeCtx(base)
      await plugin.setup(ctx)
      assert.equal(fetch.calls.at(-1).init.headers.authorization, "Bearer sk-opencode")

      // options.apiKeyEnv wins over both
      process.env.MY_GATEWAY_KEY = "sk-custom"
      ;({ ctx } = makeCtx({ ...base, options: { ...base.options, apiKeyEnv: "MY_GATEWAY_KEY" } }))
      await plugin.setup(ctx)
      assert.equal(fetch.calls.at(-1).init.headers.authorization, "Bearer sk-custom")
      delete process.env.MY_GATEWAY_KEY

      // LITELLM_API_KEY is the last resort
      delete process.env.OPENCODE_LITELLM_API_KEY
      ;({ ctx } = makeCtx(base))
      await plugin.setup(ctx)
      assert.equal(fetch.calls.at(-1).init.headers.authorization, "Bearer sk-litellm")
    } finally {
      delete process.env.OPENCODE_LITELLM_API_KEY
      delete process.env.LITELLM_API_KEY
      globalThis.fetch = originalFetch
    }
  })
})

test("a stored credential wins over env keys", async () => {
  const originalFetch = globalThis.fetch
  const fetch = stubFetch({ "/v1/model/info": () => jsonResponse(modelInfoBody) })
  globalThis.fetch = fetch
  await noEnv(async () => {
    try {
      process.env.OPENCODE_LITELLM_API_KEY = "sk-opencode"
      process.env.LITELLM_API_KEY = "sk-litellm"
      const { ctx } = makeCtx({
        credential: { key: "sk-store" },
        options: { baseURL: BASE, refreshIntervalSec: 0 },
      })
      await plugin.setup(ctx)
      // the credential store's key must not be shadowed by the env chain
      assert.equal(fetch.calls.at(-1).init.headers.authorization, "Bearer sk-store")
    } finally {
      delete process.env.OPENCODE_LITELLM_API_KEY
      delete process.env.LITELLM_API_KEY
      globalThis.fetch = originalFetch
    }
  })
})

test("when the provider is absent the transform adds it with the fallback info", async () => {
  await noEnv(async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = stubFetch({ "/v1/model/info": () => jsonResponse(modelInfoBody) })
    try {
      const { ctx, calls } = makeCtx({
        credential: { key: "sk" },
        options: { baseURL: BASE, providerID: PROVIDER_ID, refreshIntervalSec: 0 },
      })
      await plugin.setup(ctx)
      const { editor, calls: editorCalls } = makeEditor({ existing: false })
      await calls.transform(editor)
      assert.equal(editorCalls.set.length, 0)
      assert.equal(editorCalls.add.length, 1)
      const added = editorCalls.add[0]
      assert.equal(added.info.id, PROVIDER_ID)
      assert.equal(added.info.package, "@opencode/ai/providers/openai-compatible")
      assert.equal(added.info.settings.baseURL, BASE)
      assert.deepEqual(added.models, expectedFrom(modelInfoBody))
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test("the refresh interval replaces the catalog and reloads the provider", async () => {
  await noEnv(async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = stubFetch({ "/v1/model/info": () => jsonResponse(modelInfoBody) })
    mock.timers.enable({ apis: ["setInterval"] })
    try {
      const { ctx, calls } = makeCtx({
        credential: { key: "sk" },
        options: { baseURL: BASE, refreshIntervalSec: 60 },
      })
      const cleanup = await plugin.setup(ctx)
      assert.equal(calls.reloads, 0)

      // the gateway drops models upstream
      const smallerBody = { data: [modelInfoBody.data[0]] }
      globalThis.fetch = stubFetch({ "/v1/model/info": () => jsonResponse(smallerBody) })

      mock.timers.tick(60_000)
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(calls.reloads, 1)

      const { editor, calls: editorCalls } = makeEditor()
      await calls.transform(editor)
      const [set] = editorCalls.set
      assert.deepEqual(set.models, expectedFrom(smallerBody))

      await cleanup()
    } finally {
      mock.timers.reset()
      globalThis.fetch = originalFetch
    }
  })
})

test("cleanup clears the refresh interval", async () => {
  await noEnv(async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = stubFetch({ "/v1/model/info": () => jsonResponse(modelInfoBody) })
    mock.timers.enable({ apis: ["setInterval"] })
    try {
      const { ctx, calls } = makeCtx({
        credential: { key: "sk" },
        options: { baseURL: BASE, refreshIntervalSec: 60 },
      })
      const cleanup = await plugin.setup(ctx)
      await cleanup()

      mock.timers.tick(60_000)
      mock.timers.tick(60_000)
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(calls.reloads, 0)
    } finally {
      mock.timers.reset()
      globalThis.fetch = originalFetch
    }
  })
})
