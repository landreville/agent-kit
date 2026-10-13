# litellm-models

An OpenCode plugin that populates the `litellm` provider's model list directly
from the LiteLLM gateway, so client configs never hand-maintain model blocks
again. One package serves both generations: **OpenCode v1 (1.17.7 → 1.18.35)**
and **OpenCode v2 (2.x)**.

## How it works

The provider stays defined in your `opencode.json` — auth, `baseURL`, and
quirks like `allowed_openai_params` remain yours. This plugin owns only the
model inventory (approach A). It fetches `GET {baseURL}/model/info` (rich
metadata), falling back to `GET {baseURL}/models` when the key can't read the
rich endpoint, maps rows to the generation's model shape, and registers them.
The API key is never logged or persisted.

**On v2**, the entrypoint is `setup(ctx)`: the catalog is registered via
`ctx.provider.transform`, cached in plugin storage (last-good survives
restarts), and refreshed on an interval via `ctx.provider.reload()`. The key
resolves from OpenCode's credential store → `$apiKeyEnv` →
`OPENCODE_LITELLM_API_KEY` → `LITELLM_API_KEY`.

**On v1**, the entrypoint is `server(input, options)` → a `config` hook. V1
skips the plugin `provider.models` hook for providers absent from its
models.dev database, so for a custom gateway like `litellm` that hook never
fires; the config hook is V1's supported path. It fetches once at plugin load
and injects the catalog into `cfg.provider.litellm.models` (V1 config-model
syntax) before opencode reads the config. The key resolves from the env chain
only (`apiKeyEnv` → `OPENCODE_LITELLM_API_KEY` → `LITELLM_API_KEY`) — the
config hook carries no auth context. Refresh = restart.

Both files load from the same directory: V1 calls the default export's
`server()`, V2 calls `setup()`; each generation runs only its own entry.

## Install

Symlink or copy the plugin directory into
`~/.config/opencode/plugins/litellm-models` (auto-discovered by both
generations; `.opencode/plugins/` works for project scope):

```sh
ln -s /path/to/agent-kit/opencode/plugins/litellm-models \
  ~/.config/opencode/plugins/litellm-models
```

Options are passed with the V1-style tuple entry, which V2 also accepts:

```json
{
  "plugin": [["/home/user/.config/opencode/plugins/litellm-models", {}]]
}
```

(V2-native configs use `plugins: [{ "package": "...", "options": {...} }]`.)

## Options

| Option               | Default                                  | Description                                                          |
| -------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `baseURL`            | `https://litellm.example.com/v1`     | Gateway base URL (OpenAI-style, ends in `/v1`)                       |
| `providerID`         | `litellm`                                | Provider whose inventory this replaces                                 |
| `refreshIntervalSec` | `60`                                     | v2: seconds between refreshes (`0` disables). v1: unused (snapshot at load) |
| `apiKeyEnv`          | —                                        | Env var checked before the built-in fallbacks                        |
| `providerName`       | `LiteLLM`                                | Display name for the v2 standalone-provider fallback                 |

## Behavior differences by generation

| Behavior                        | v2                                              | v1                                              |
| ------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| Catalog refresh                 | interval + `provider.reload()`                  | once at plugin load; restart refreshes          |
| Last-good cache                 | plugin storage (durable, global per machine)    | none (in-memory only per process)               |
| Key resolution                  | credential store → env chain                    | env chain only                                  |
| Provider block missing in config | plugin `add`s a standalone provider            | plugin injects a block (in-memory config only)  |
| Provider block present          | models only are replaced                        | models only are replaced                        |

## Failure behavior

- Gateway unreachable or a bad response →
  - **v2**: serve the cached catalog if any, else an empty list; a warning is logged and nothing crashes.
  - **v1**: the config is left untouched (a hand-maintained list, if any, survives); a warning is logged.
- Gateway answers 200 with an empty catalog → treated as suspicious (not a
  success): **v1** keeps the existing list and logs a warning; v2 registers
  and caches the empty list as last-good, matching its long-standing
  behavior.
- No resolvable key anywhere → no request is attempted; a warning is logged (v2 still serves its cache).
- `/model/info` denied/unparseable → fall back to `/models` (both generations).

## Security

The API key is never logged and the plugin never writes any file. Two
exposure notes:

- **v1 standalone injection**: when no `litellm` provider block exists in
  config, the plugin injects one — including the env-resolved key — into
  opencode's in-memory config. `GET /config` and `GET /config/providers`
  return that config, and a config write could persist it. Prefer a
  config-defined provider block (both the workstation and the sandbox kit
  have one) and set `OPENCODE_SERVER_PASSWORD` when running `opencode serve`
  on a shared host.
- **v2** never puts the key into provider state — the standalone fallback
  carries only settings, and model calls authenticate through the credential
  store.

## Development

```bash
npm test   # node --test — zero runtime dependencies
```

## Live verification (2026-10-09)

Hermetic drills against a mock gateway serving `test/fixtures` responses,
plus the gateway's own 401 on a bad key:

- **v1 (opencode-ai 1.17.7 and 1.18.35, headless `serve`)**: `GET /config/providers`
  showed the `litellm` provider with exactly the fixture's six model ids,
  per-million costs and gateway limits intact, and auto-generated
  low/medium/high `reasoningEffort` variants; the config-defined provider
  block (api URL, apiKey) was preserved — only the models were replaced.
  Unreachable gateway → config untouched, warning logged, server healthy.
  No `apiKey` in config + env key → models still populated.
- **v2 (workstation opencode 2.0.26, headless `serve`)**: the dual default
  export (with its inert `server` key) loaded and registered exactly the six
  fixture ids with correct cost/limit/name.
