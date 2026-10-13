import { test, mock } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { server } from "../v1.js"
import { mapModelInfoResponse } from "../catalog.js"
import { toV1ConfigModel } from "../v1-map.js"

const modelInfoBody = JSON.parse(
  readFileSync(new URL("./fixtures/model-info.json", import.meta.url), "utf8"),
)

const BASE = "http://127.0.0.1:8788/v1"
const PROVIDER_ID = "litellm"
const EMPTY = () => ({})
const EXPECTED_MODELS = Object.fromEntries(
  mapModelInfoResponse(modelInfoBody).map((m) => [m.id, toV1ConfigModel(m)]),
)

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

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

test("server exposes the v1 hooks", async () => {
  const hooks = await server({}, {})
  assert.equal(typeof hooks.config, "function")
  assert.equal(typeof hooks.dispose, "function")
  await hooks.dispose() // no-op, must not throw
})

test("config injects the gateway catalog when the provider is absent", async () => {
  await noEnv(async () => {
    const originalFetch = globalThis.fetch
    const fetch = stubFetch({ "/v1/model/info": () => jsonResponse(modelInfoBody) })
    globalThis.fetch = fetch
    try {
      process.env.OPENCODE_LITELLM_API_KEY = "sk-env"
      const hooks = await server({}, { baseURL: BASE })
      const cfg = EMPTY()
      await hooks.config(cfg)

      assert.deepEqual(cfg.provider[PROVIDER_ID], {
        npm: "@ai-sdk/openai-compatible",
        api: BASE,
        options: { apiKey: "sk-env" },
        models: EXPECTED_MODELS,
      })
      assert.equal(fetch.calls[0].init.headers.authorization, "Bearer sk-env")
    } finally {
      delete process.env.OPENCODE_LITELLM_API_KEY
      globalThis.fetch = originalFetch
    }
  })
})

test("config replaces only the models of an existing provider block", async () => {
  await noEnv(async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = stubFetch({ "/v1/model/info": () => jsonResponse(modelInfoBody) })
    try {
      process.env.OPENCODE_LITELLM_API_KEY = "sk-env"
      const hooks = await server({}, { baseURL: BASE })
      const cfg = {
        provider: {
          [PROVIDER_ID]: {
            npm: "@ai-sdk/openai-compatible",
            api: "https://user-gateway.example/v1",
            options: { apiKey: "user-key" },
            models: { "stale-model": { name: "Stale" } },
          },
        },
      }
      await hooks.config(cfg)

      // approach A: the user's provider block survives untouched
      assert.equal(cfg.provider[PROVIDER_ID].api, "https://user-gateway.example/v1")
      assert.deepEqual(cfg.provider[PROVIDER_ID].options, { apiKey: "user-key" })
      assert.equal(cfg.provider[PROVIDER_ID].models["stale-model"], undefined)
      assert.deepEqual(cfg.provider[PROVIDER_ID].models, EXPECTED_MODELS)
    } finally {
      delete process.env.OPENCODE_LITELLM_API_KEY
      globalThis.fetch = originalFetch
    }
  })
})

test("no key in env leaves the config untouched and attempts no fetch", async () => {
  await noEnv(async () => {
    const originalFetch = globalThis.fetch
    const fetch = stubFetch({})
    globalThis.fetch = fetch
    const logs = []
    const restoreLog = mock.method(console, "log", (message) => logs.push(String(message)))
    try {
      const hooks = await server({}, { baseURL: BASE })
      const cfg = { provider: { [PROVIDER_ID]: { models: { keep: {} } } } }
      const before = JSON.stringify(cfg)
      await hooks.config(cfg)

      assert.equal(fetch.calls.length, 0)
      assert.equal(JSON.stringify(cfg), before)
      assert.equal(logs.length, 1)
      assert.match(logs[0], /no api key/i)
    } finally {
      restoreLog()
      globalThis.fetch = originalFetch
    }
  })
})

test("a failed fetch leaves the config untouched", async () => {
  await noEnv(async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error("network down")
    }
    const logs = []
    const restoreLog = mock.method(console, "log", (message) => logs.push(String(message)))
    try {
      process.env.OPENCODE_LITELLM_API_KEY = "sk-env"
      const hooks = await server({}, { baseURL: BASE })
      const cfg = { provider: { [PROVIDER_ID]: { models: { keep: {} } } } }
      const before = JSON.stringify(cfg)
      await hooks.config(cfg)

      assert.equal(JSON.stringify(cfg), before)
      assert.equal(logs.length, 1)
      assert.match(logs[0], /catalog fetch failed/i)
    } finally {
      restoreLog()
      delete process.env.OPENCODE_LITELLM_API_KEY
      globalThis.fetch = originalFetch
    }
  })
})

test("an empty catalog keeps the existing list and warns", async () => {
  await noEnv(async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = stubFetch({ "/v1/model/info": () => jsonResponse({ data: [] }) })
    const logs = []
    const restoreLog = mock.method(console, "log", (message) => logs.push(String(message)))
    try {
      process.env.OPENCODE_LITELLM_API_KEY = "sk-env"
      const hooks = await server({}, { baseURL: BASE })
      const cfg = { provider: { [PROVIDER_ID]: { models: { "hand-maintained": { name: "Hand" } } } } }
      await hooks.config(cfg)

      assert.deepEqual(Object.keys(cfg.provider[PROVIDER_ID].models), ["hand-maintained"])
      assert.equal(logs.length, 1)
      assert.match(logs[0], /empty/i)
    } finally {
      restoreLog()
      delete process.env.OPENCODE_LITELLM_API_KEY
      globalThis.fetch = originalFetch
    }
  })
})

test("apiKeyEnv wins over the built-in env fallbacks", async () => {
  await noEnv(async () => {
    const originalFetch = globalThis.fetch
    const fetch = stubFetch({ "/v1/model/info": () => jsonResponse(modelInfoBody) })
    globalThis.fetch = fetch
    try {
      process.env.OPENCODE_LITELLM_API_KEY = "sk-opencode"
      process.env.LITELLM_API_KEY = "sk-litellm"
      process.env.MY_GATEWAY_KEY = "sk-custom"
      const hooks = await server({}, { baseURL: BASE, apiKeyEnv: "MY_GATEWAY_KEY" })
      await hooks.config(EMPTY())
      assert.equal(fetch.calls[0].init.headers.authorization, "Bearer sk-custom")

      delete process.env.MY_GATEWAY_KEY
      const fallback = await server({}, { baseURL: BASE })
      await fallback.config(EMPTY())
      assert.equal(fetch.calls.at(-1).init.headers.authorization, "Bearer sk-opencode")

      delete process.env.OPENCODE_LITELLM_API_KEY
      const last = await server({}, { baseURL: BASE })
      await last.config(EMPTY())
      assert.equal(fetch.calls.at(-1).init.headers.authorization, "Bearer sk-litellm")
    } finally {
      delete process.env.MY_GATEWAY_KEY
      delete process.env.OPENCODE_LITELLM_API_KEY
      delete process.env.LITELLM_API_KEY
      globalThis.fetch = originalFetch
    }
  })
})
