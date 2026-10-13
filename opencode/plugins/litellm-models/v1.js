// v1.js — litellm-models OpenCode v1 entrypoint (loaded through index.js's
// default export as server()).
//
// V1's supported path for a CUSTOM (config-defined) provider is the config
// hook. V1 skips the plugin `provider.models` hook for providers absent from
// its models.dev database — the hook loop runs before config providers enter
// the database (verified in the 1.17.7 and 1.18.35 source) — so for `litellm`
// that hook never fires. Instead this entrypoint injects the gateway catalog
// into cfg.provider[providerID].models, in V1 config-model syntax, before
// opencode reads cfg.provider ("includes any modifications from plugin
// config() hook", provider.ts).
//
// How it differs from the v2 entry (v2.js):
//   - Snapshot at load: the config hook runs once per plugin load and V1 has
//     no reload API, so refreshing the catalog means restarting opencode.
//   - Key from env only (apiKeyEnv → OPENCODE_LITELLM_API_KEY →
//     LITELLM_API_KEY): the config hook carries no auth context, so the
//     credential store has no V1 equivalent here. The workstation uses v2
//     and keeps the store; the sandbox kit's key arrives via
//     {env:OPENCODE_LITELLM_API_KEY}.
//   - The user's provider block (npm/api/options) is preserved; only the
//     models are replaced. When no provider block exists, one is injected so
//     the plugin still works standalone. The resolved key is injected into
//     that in-memory block (the only functional option on V1, where the
//     config hook carries no credential-store access) — it is never logged
//     and the plugin never writes any file, but note the injected key lives
//     in opencode's in-memory config, which GET /config and GET
//     /config/providers return and a config write could persist. Prefer a
//     config-defined provider block (the workstation and the kit both have
//     one) or set OPENCODE_SERVER_PASSWORD on shared servers.
//
// The API key is never logged or persisted.

import { fetchCatalog } from "./catalog.js"
import { toV1ConfigModel } from "./v1-map.js"

const DEFAULT_BASE_URL = "https://litellm.example.com/v1"
const DEFAULT_PROVIDER_ID = "litellm"
const FETCH_TIMEOUT_MS = 10_000

export async function server(input, options = {}) {
  const providerID = options.providerID ?? DEFAULT_PROVIDER_ID
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL

  const resolveKey = () => {
    for (const name of [options.apiKeyEnv, "OPENCODE_LITELLM_API_KEY", "LITELLM_API_KEY"]) {
      if (!name) continue
      const value = process.env[name]
      if (typeof value === "string" && value) return value
    }
    return undefined
  }

  const config = async (cfg) => {
    const apiKey = resolveKey()
    if (!apiKey) {
      console.log(
        `[litellm-models] no API key in env (tried ${[
          options.apiKeyEnv,
          "OPENCODE_LITELLM_API_KEY",
          "LITELLM_API_KEY",
        ]
          .filter(Boolean)
          .join(", ")}); leaving the ${providerID} provider config untouched`,
      )
      return
    }

    let models
    try {
      const catalog = await fetchCatalog({ baseURL, apiKey, timeoutMs: FETCH_TIMEOUT_MS })
      models = catalog.models
    } catch (error) {
      console.log(
        `[litellm-models] v1 catalog fetch failed: ${error?.message ?? error}; ` +
          `leaving the ${providerID} provider config untouched`,
      )
      return
    }
    if (models.length === 0) {
      // A 200 with an empty catalog is a degenerate success: replacing the
      // user's list with nothing would be a silent destructive wipe, so warn
      // and leave the config alone (same outcome as a failed fetch).
      console.log(
        `[litellm-models] gateway ${baseURL} returned an empty catalog; ` +
          `leaving the ${providerID} provider config untouched`,
      )
      return
    }

    const mapped = Object.fromEntries(models.map((model) => [model.id, toV1ConfigModel(model)]))
    cfg.provider = cfg.provider ?? {}
    const existing = cfg.provider[providerID]
    if (existing === undefined) {
      cfg.provider[providerID] = {
        npm: "@ai-sdk/openai-compatible",
        api: baseURL,
        options: { apiKey },
        models: mapped,
      }
      return
    }
    if (typeof existing !== "object" || existing === null) {
      console.log(
        `[litellm-models] provider "${providerID}" exists in config but is not an object; ` +
          `leaving it untouched`,
      )
      return
    }
    existing.models = mapped
  }

  return { config, dispose: async () => {} }
}
