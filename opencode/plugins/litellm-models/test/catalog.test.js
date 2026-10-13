import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  CatalogFetchError,
  fetchCatalog,
  mapModelInfoResponse,
  mapV1ModelsResponse,
} from "../catalog.js"

const loadFixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))

const modelInfoBody = loadFixture("model-info.json")
const v1ModelsBody = loadFixture("v1-models.json")

const BASE = "https://gateway.example/v1"

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const htmlResponse = (status = 200) =>
  new Response("<html><body>502 Bad Gateway</body></html>", {
    status,
    headers: { "content-type": "text/html" },
  })

// fetchImpl stub: routes map URL pathname -> () => Response (fresh per call)
const makeFetch = (routes) => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const respond = routes[new URL(url).pathname]
    if (respond === undefined) return new Response("not found", { status: 404 })
    return respond(init)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

// --- display name mapping ---

test("mapModelInfoResponse uses the gateway model_name verbatim as the display name", () => {
  const byId = Object.fromEntries(mapModelInfoResponse(modelInfoBody).map((m) => [m.modelID, m]))
  assert.equal(byId["meta-llama/Llama-3.3-70B-Instruct-Turbo"].name, "meta-llama/Llama-3.3-70B-Instruct-Turbo")
  assert.equal(byId["Qwen/Qwen3.8-Max"].name, "Qwen/Qwen3.8-Max")
  assert.equal(byId["glm-5.3"].name, "glm-5.3")
})

// --- mapModelInfoResponse ---

test("mapModelInfoResponse keeps one entry per model_name in gateway order", () => {
  const models = mapModelInfoResponse(modelInfoBody)
  assert.deepEqual(
    models.map((m) => m.modelID),
    [
      "claude-sonnet-5",
      "gpt-5.6-sol",
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "glm-5.3",
      "Qwen/Qwen3.8-Max",
      "sparse-model",
    ],
  )
})

test("mapModelInfoResponse maps a row to a complete Model.Info literal", () => {
  const [claude] = mapModelInfoResponse(modelInfoBody)
  assert.deepEqual(claude, {
    id: "claude-sonnet-5",
    modelID: "claude-sonnet-5",
    name: "claude-sonnet-5",
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "medium", settings: { reasoningEffort: "medium" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ],
    time: { released: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0.2, write: 2.5 } }],
    status: "active",
    enabled: true,
    limit: { context: 200000, output: 32000 },
  })
})

test("mapModelInfoResponse keeps only the first row when model_name repeats", () => {
  const models = mapModelInfoResponse(modelInfoBody).filter((m) => m.modelID === "glm-5.3")
  assert.equal(models.length, 1)
  // first row: no limits and zero costs; the second row's 65536 / 5e-7 must not win
  assert.deepEqual(models[0].limit, { context: 200000, output: 32000 })
  assert.deepEqual(models[0].cost, [{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
})

test("mapModelInfoResponse excludes rows whose mode is not chat", () => {
  const models = mapModelInfoResponse(modelInfoBody)
  assert.equal(models.find((m) => m.modelID === "text-embedding-small"), undefined)
})

test("mapModelInfoResponse converts per-token costs to per-million and maps limits", () => {
  const byId = Object.fromEntries(mapModelInfoResponse(modelInfoBody).map((m) => [m.modelID, m]))
  assert.deepEqual(byId["gpt-5.6-sol"].cost, [
    { input: 4, output: 20, cache: { read: 0.4, write: 5 } },
  ])
  assert.deepEqual(byId["gpt-5.6-sol"].limit, { context: 922000, output: 128000 })
  // null cache fields become 0
  assert.deepEqual(byId["meta-llama/Llama-3.3-70B-Instruct-Turbo"].cost, [
    { input: 0.1, output: 0.32, cache: { read: 0, write: 0 } },
  ])
  // a one-sided max-tokens pair falls back to the default limit
  assert.deepEqual(byId["Qwen/Qwen3.8-Max"].limit, { context: 200000, output: 32000 })
})

test("mapModelInfoResponse maps a sparse row with empty cost and the default limit", () => {
  const sparse = mapModelInfoResponse(modelInfoBody).find((m) => m.modelID === "sparse-model")
  assert.deepEqual(sparse.cost, [])
  assert.deepEqual(sparse.limit, { context: 200000, output: 32000 })
})

test("mapModelInfoResponse rejects unexpected response shapes", () => {
  assert.throws(() => mapModelInfoResponse({ data: "nope" }), /unexpected/i)
  assert.throws(() => mapModelInfoResponse([1, 2]), /unexpected/i)
})

// --- mapV1ModelsResponse ---

test("mapV1ModelsResponse maps ids, keeps names verbatim, uses limits when present, adds no cost", () => {
  const models = mapV1ModelsResponse(v1ModelsBody)
  assert.deepEqual(
    models.map((m) => m.modelID),
    ["claude-sonnet-5", "Qwen/Qwen3.8-Max", "kimi-k3", "glm-5.3"],
  )
  const byId = Object.fromEntries(models.map((m) => [m.modelID, m]))
  assert.equal(byId["claude-sonnet-5"].name, "claude-sonnet-5")
  assert.deepEqual(byId["claude-sonnet-5"].limit, { context: 1000000, output: 128000 })
  assert.equal(byId["Qwen/Qwen3.8-Max"].name, "Qwen/Qwen3.8-Max")
  assert.deepEqual(byId["Qwen/Qwen3.8-Max"].limit, { context: 200000, output: 32000 })
  for (const model of models) assert.deepEqual(model.cost, [])
})

test("mapV1ModelsResponse dedupes by id and excludes non-chat modes", () => {
  const models = mapV1ModelsResponse(v1ModelsBody)
  const glm = models.filter((m) => m.modelID === "glm-5.3")
  assert.equal(glm.length, 1)
  assert.deepEqual(glm[0].limit, { context: 128000, output: 16384 }) // first entry wins
  assert.equal(models.find((m) => m.modelID === "text-embedding-large"), undefined)
})

test("mapV1ModelsResponse rejects unexpected response shapes", () => {
  assert.throws(() => mapV1ModelsResponse({ nope: true }), /unexpected/i)
})

// --- fetchCatalog ---

test("fetchCatalog succeeds on /model/info", async () => {
  const fetchImpl = makeFetch({ "/v1/model/info": () => jsonResponse(modelInfoBody) })
  const result = await fetchCatalog({ baseURL: BASE, apiKey: "sk-test", fetchImpl })
  assert.equal(result.source, "model-info")
  assert.deepEqual(result.models, mapModelInfoResponse(modelInfoBody))
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].init.headers.authorization, "Bearer sk-test")
})

test("fetchCatalog sends no Authorization header when apiKey is undefined", async () => {
  const fetchImpl = makeFetch({ "/v1/model/info": () => jsonResponse(modelInfoBody) })
  await fetchCatalog({ baseURL: BASE, fetchImpl })
  const headers = fetchImpl.calls[0].init.headers
  assert.equal("authorization" in headers, false)
})

test("fetchCatalog falls back to /models after a 403 on /model/info", async () => {
  const fetchImpl = makeFetch({
    "/v1/model/info": () => jsonResponse({ error: "forbidden" }, 403),
    "/v1/models": () => jsonResponse(v1ModelsBody),
  })
  const result = await fetchCatalog({ baseURL: BASE, apiKey: "sk-test", fetchImpl })
  assert.equal(result.source, "v1-models")
  assert.deepEqual(result.models, mapV1ModelsResponse(v1ModelsBody))
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(new URL(fetchImpl.calls[1].url).pathname, "/v1/models")
})

test("fetchCatalog treats an HTML 200 as a parse failure and falls back to /models", async () => {
  const fetchImpl = makeFetch({
    "/v1/model/info": () => htmlResponse(),
    "/v1/models": () => jsonResponse(v1ModelsBody),
  })
  const result = await fetchCatalog({ baseURL: BASE, fetchImpl })
  assert.equal(result.source, "v1-models")
})

test("fetchCatalog throws CatalogFetchError when both endpoints return 500", async () => {
  const fetchImpl = makeFetch({
    "/v1/model/info": () => jsonResponse({ error: "boom" }, 500),
    "/v1/models": () => jsonResponse({ error: "boom" }, 500),
  })
  await assert.rejects(
    fetchCatalog({ baseURL: BASE, fetchImpl }),
    (err) => err instanceof CatalogFetchError && err.status === 500,
  )
})

test("fetchCatalog throws CatalogFetchError when both endpoints return HTML", async () => {
  const fetchImpl = makeFetch({
    "/v1/model/info": () => htmlResponse(),
    "/v1/models": () => htmlResponse(),
  })
  await assert.rejects(
    fetchCatalog({ baseURL: BASE, fetchImpl }),
    (err) => err instanceof CatalogFetchError,
  )
})

test("fetchCatalog uses AbortSignal.timeout with the configured timeout", async () => {
  const original = AbortSignal.timeout
  let captured
  AbortSignal.timeout = (ms) => {
    captured = ms
    return original(ms)
  }
  try {
    await fetchCatalog({
      baseURL: BASE,
      fetchImpl: makeFetch({ "/v1/model/info": () => jsonResponse(modelInfoBody) }),
      timeoutMs: 2500,
    })
    assert.equal(captured, 2500)
  } finally {
    AbortSignal.timeout = original
  }
})
