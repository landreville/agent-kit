// v1-map.js — convert the canonical V2 Model.Info (catalog.js output) to the
// V1 config-model syntax the V1 config hook injects. Pure: no I/O, no logging,
// no dependencies.
//
// The V1 entrypoint (v1.js) injects these entries into
// cfg.provider[providerID].models; opencode's config parser fills every other
// Model field from defaults (provider.ts, "extend database from config"). The
// shape was verified against the 1.17.7 parser: `tool_call` (not `tools`),
// `modalities.input/output` arrays, `cost.cache_read`/`cost_write` per million,
// `limit.context`/`limit.output`, and `reasoning: true` (which makes opencode
// generate the low/medium/high reasoningEffort variants the v2 entry sets
// explicitly).

export function toV1ConfigModel(model) {
  const [tier] = Array.isArray(model.cost) ? model.cost : []
  const input = model.capabilities?.input ?? []
  const output = model.capabilities?.output ?? []
  return {
    name: model.name,
    reasoning: true,
    attachment: input.includes("image"),
    tool_call: model.capabilities?.tools === true,
    modalities: { input: [...input], output: [...output] },
    limit: { context: model.limit?.context ?? 0, output: model.limit?.output ?? 0 },
    cost: {
      input: tier?.input ?? 0,
      output: tier?.output ?? 0,
      cache_read: tier?.cache?.read ?? 0,
      cache_write: tier?.cache?.write ?? 0,
    },
  }
}
