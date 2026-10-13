// catalog.js — fetch the LiteLLM gateway's model catalog and map it to OpenCode `Model.Info`.
// Zero runtime dependencies; plain ESM.
//
// Endpoints (verified against the live gateway, opencode v2.0.24):
//   GET {baseURL}/model/info  → { data: [{ model_name, litellm_params, model_info }, …] }
//   GET {baseURL}/models      → { object, data: [{ id, mode, max_input_tokens, max_output_tokens }, …] }
// baseURL is OpenAI-style and ends in /v1 — paths are appended to it, never /v1 twice.
//
// Mapping rules (Task 1 findings — see the SDD ledger):
// - id === modelID === name === the gateway model id, verbatim (slashes kept, so the
//   picker matches the LiteLLM console and prefix-only collisions stay distinguishable).
// - mode is kept only when absent or "chat" (null passes).
// - Duplicate ids (load-balanced deployments) keep the FIRST row.
// - limit: the schema requires {context, output} together — gateway values when both present,
//   else opencode's observed default {context: 200000, output: 32000}.
// - cost: an entry only when both per-token cost fields are present (0 counts as present);
//   LiteLLM reports USD per token, OpenCode wants USD per million (rounded to 6 decimals);
//   null cache costs become 0.
// - Variants reproduce opencode's config-model defaults (low/medium/high reasoningEffort) so
//   the picker keeps today's behavior; `allowed_openai_params` stays in the provider config.

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_LIMIT = { context: 200_000, output: 32_000 }

const defaultCapabilities = () => ({ tools: true, input: ["text", "image"], output: ["text"] })
const defaultVariants = () => [
  { id: "low", settings: { reasoningEffort: "low" } },
  { id: "medium", settings: { reasoningEffort: "medium" } },
  { id: "high", settings: { reasoningEffort: "high" } },
]

export class CatalogFetchError extends Error {
  constructor(message, status) {
    super(message)
    this.name = "CatalogFetchError"
    this.status = status
  }
}

function perMillion(perToken) {
  return Number((perToken * 1e6).toFixed(6))
}

function mapLimit({ max_input_tokens, max_output_tokens }) {
  if (typeof max_input_tokens === "number" && typeof max_output_tokens === "number") {
    return { context: max_input_tokens, output: max_output_tokens }
  }
  return { ...DEFAULT_LIMIT }
}

function mapCost({
  input_cost_per_token,
  output_cost_per_token,
  cache_read_input_token_cost,
  cache_creation_input_token_cost,
}) {
  if (typeof input_cost_per_token !== "number" || typeof output_cost_per_token !== "number") {
    return []
  }
  return [
    {
      input: perMillion(input_cost_per_token),
      output: perMillion(output_cost_per_token),
      cache: {
        read: perMillion(cache_read_input_token_cost ?? 0),
        write: perMillion(cache_creation_input_token_cost ?? 0),
      },
    },
  ]
}

function buildModel({ id, limit, cost }) {
  return {
    id,
    modelID: id,
    name: id,
    capabilities: defaultCapabilities(),
    variants: defaultVariants(),
    time: { released: 0 },
    cost,
    status: "active",
    enabled: true,
    limit,
  }
}

function extractRows(body, what) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.data)) {
    throw new Error(`unexpected ${what} response shape`)
  }
  return body.data
}

const isNonChat = (mode) => typeof mode === "string" && mode !== "chat"

export function mapModelInfoResponse(body) {
  const rows = extractRows(body, "/model/info")
  const models = []
  const seen = new Set()
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const id = row.model_name
    if (typeof id !== "string" || id === "") continue
    if (seen.has(id)) continue
    seen.add(id)
    const info = row.model_info && typeof row.model_info === "object" ? row.model_info : {}
    if (isNonChat(info.mode)) continue
    models.push(buildModel({ id, limit: mapLimit(info), cost: mapCost(info) }))
  }
  return models
}

export function mapV1ModelsResponse(body) {
  const rows = extractRows(body, "/models")
  const models = []
  const seen = new Set()
  for (const entry of rows) {
    if (!entry || typeof entry !== "object") continue
    const id = entry.id
    if (typeof id !== "string" || id === "") continue
    if (seen.has(id)) continue
    seen.add(id)
    if (isNonChat(entry.mode)) continue
    models.push(buildModel({ id, limit: mapLimit(entry), cost: [] }))
  }
  return models
}

async function fetchJson(fetchImpl, url, headers, timeoutMs) {
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`non-JSON response (content-type: ${response.headers.get("content-type") ?? "unknown"})`)
  }
}

export async function fetchCatalog({
  baseURL,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const headers = { accept: "application/json" }
  if (apiKey !== undefined && apiKey !== null && apiKey !== "") {
    headers.authorization = `Bearer ${apiKey}`
  }
  const modelInfoUrl = `${baseURL}/model/info`
  const modelsUrl = `${baseURL}/models`

  let primaryError
  try {
    const body = await fetchJson(fetchImpl, modelInfoUrl, headers, timeoutMs)
    return { source: "model-info", models: mapModelInfoResponse(body) }
  } catch (error) {
    primaryError = error
  }

  try {
    const body = await fetchJson(fetchImpl, modelsUrl, headers, timeoutMs)
    return { source: "v1-models", models: mapV1ModelsResponse(body) }
  } catch (error) {
    throw new CatalogFetchError(
      `GET ${modelInfoUrl} failed: ${primaryError.message}; GET ${modelsUrl} failed: ${error.message}`,
      typeof error.status === "number" ? error.status : undefined,
    )
  }
}
