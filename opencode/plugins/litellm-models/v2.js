// v2.js — litellm-models OpenCode v2 entry (loaded by V2 through index.js).
//
// Populates the `litellm` provider's model inventory from the LiteLLM gateway
// (approach A: the provider definition — auth, baseURL, allowed_openai_params —
// stays in opencode.json; this plugin owns only the model list).
//
// Lifecycle: resolve options → resolve the API key (credential store → env
// fallbacks) → fetch the catalog (rich /model/info, /models fallback) → map to
// Model.Info → seed from cache on failure → register the provider transform →
// refresh on an interval via ctx.provider.reload(). Failures log a warning and
// degrade; the API key is never logged.

import { fetchCatalog } from "./catalog.js"

const DEFAULT_BASE_URL = "https://litellm.example.com/v1"
const DEFAULT_PROVIDER_ID = "litellm"
const DEFAULT_REFRESH_SEC = 60
const FETCH_TIMEOUT_MS = 10_000
const CACHE_KEY = "catalog"

export async function setup(ctx) {
  const options = ctx.options ?? {}
  const providerID = options.providerID ?? DEFAULT_PROVIDER_ID
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL
  const refreshIntervalSec = options.refreshIntervalSec ?? DEFAULT_REFRESH_SEC

  // Fallback Provider.Info for a standalone install where the config doesn't
  // define the provider (shape per the live v2.0.24 /openapi.json).
  const providerInfo = {
    id: providerID,
    name: options.providerName ?? "LiteLLM",
    activation: "enabled",
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL, provider: providerID },
    body: {},
  }

  const state = { models: [] }

  const resolveKey = async () => {
    try {
      const active = ctx.integration?.connection?.active
      if (typeof active === "function") {
        const connection = await active.call(ctx.integration.connection, providerID)
        if (connection) {
          const resolve = ctx.integration.connection.resolve
          if (typeof resolve === "function") {
            const resolved = await resolve.call(ctx.integration.connection, connection)
            if (typeof resolved === "string" && resolved) return resolved
            if (typeof resolved?.key === "string" && resolved.key) return resolved.key
          }
        }
      }
    } catch (error) {
      console.log(`[litellm-models] credential lookup failed: ${error?.message ?? error}`)
    }
    for (const name of [options.apiKeyEnv, "OPENCODE_LITELLM_API_KEY", "LITELLM_API_KEY"]) {
      if (!name) continue
      const value = process.env[name]
      if (typeof value === "string" && value) return value
    }
    return undefined
  }

  const load = async () => {
    const apiKey = await resolveKey()
    if (!apiKey) return false
    try {
      const catalog = await fetchCatalog({ baseURL, apiKey, timeoutMs: FETCH_TIMEOUT_MS })
      state.models = catalog.models
      try {
        await ctx.storage?.set?.(CACHE_KEY, catalog.models)
      } catch (error) {
        console.log(`[litellm-models] cache write failed: ${error?.message ?? error}`)
      }
      return true
    } catch (error) {
      console.log(
        `[litellm-models] catalog fetch failed: ${error?.message ?? error}; ` +
          `keeping ${state.models.length} cached models`,
      )
      return false
    }
  }

  if (!(await load())) {
    try {
      const cached = await ctx.storage?.get?.(CACHE_KEY)
      if (Array.isArray(cached)) state.models = cached
    } catch (error) {
      console.log(`[litellm-models] cache read failed: ${error?.message ?? error}`)
    }
  }

  await ctx.provider.transform((editor) => {
    const models = state.models.map((model) => ({ ...model, providerID }))
    if (editor.get(providerID)) {
      editor.models.set(providerID, models)
    } else {
      editor.add({ info: providerInfo, models })
    }
  })

  let timer
  if (refreshIntervalSec !== 0) {
    const refresh = async () => {
      if (await load()) {
        try {
          await ctx.provider.reload?.()
        } catch (error) {
          console.log(`[litellm-models] provider reload failed: ${error?.message ?? error}`)
        }
      }
    }
    timer = setInterval(refresh, refreshIntervalSec * 1000)
  }

  return () => {
    if (timer) clearInterval(timer)
  }
}
