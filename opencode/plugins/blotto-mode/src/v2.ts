// OpenCode v2 entrypoint for blotto-mode. Bridges the new in-process
// plugin context to the existing (legacy) createPlugin factory via
// context-adapter, and wires the permission.evaluate hook.
import { loadConfig } from "./config"
import { createPlugin } from "./plugin"
import { normalize } from "./request"
import { adaptContext } from "./context-adapter"
import { RuntimeState } from "./state"
import { blottoModeToolNew } from "./tool"
import { probeLaya } from "./tiers/laya"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Finds the judge credential in opencode's auth store. The canonical
 * `litellm` entry wins, then any entry whose id starts with `litellm`
 * (per-plugin keys such as `litellm-blottomode`); a configured provider
 * id (`judge.authProvider`) always beats the prefix scan. Non-litellm
 * credentials are never borrowed.
 */
export function resolveAuthApiKey(auth: unknown, explicit?: string): string {
  if (!auth || typeof auth !== "object") return ""
  const entries = auth as Record<string, unknown>
  const keyOf = (e: unknown): string =>
    typeof e === "object" && e !== null && typeof (e as { key?: unknown }).key === "string"
      ? ((e as { key: string }).key).trim()
      : ""
  if (explicit) return keyOf(entries[explicit])
  const exact = keyOf(entries["litellm"])
  if (exact) return exact
  for (const id of Object.keys(entries)) {
    if (id === "litellm" || !id.startsWith("litellm")) continue
    const key = keyOf(entries[id])
    if (key) return key
  }
  return ""
}

export async function setup(
  ctx: any,
  overrides?: { homedir?: string; worktree?: string; directory?: string },
): Promise<() => Promise<void>> {
  // `overrides` is test-only: they isolate config/decision-log/auth paths from
  // the real home during `bun test`. Live plugins never pass them.
  const adapted = adaptContext(ctx, overrides)
  const { client, project, directory, worktree, homedir } = adapted

  const cfg = loadConfig({ worktree, homedir, log: (m: string) => { try { console.warn(`blotto-mode: ${m}`) } catch { /* */ } } })

  // File-backed diagnostic sink: OpenCode swallows both console.* from the
  // server process and plugin app.log we cannot verify, so debug lines go
  // beside the decision log where we can read them. Dev tooling, not the
  // judge path — every write is best-effort and never thrown.
  const debugLog = (level: string, msg: string) => {
    try {
      const path = join(homedir, ".local", "share", "blotto-mode", "blotto.log")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      appendFileSync(path, `${new Date().toISOString()} ${level} ${msg}\n`, { mode: 0o600 })
    } catch { /* diagnostics never disrupt the decision path */ }
  }
  debugLog("info", "setup begin")

  // Phase 2: resolve the judge API key. Order: config (already expanded),
  // env var, then opencode's auth store (so users don't have to export
  // LITELLM_API_KEY separately). Never overwrite a non-empty config value.
  if (!cfg.judge.apiKey) {
    const fromEnv = (process.env.LITELLM_API_KEY ?? "").trim()
    if (fromEnv) cfg.judge.apiKey = fromEnv
    else {
      try {
        const { readFileSync } = await import("node:fs")
        const { join } = await import("node:path")
        const authPath = join(homedir, ".local", "share", "opencode", "auth.json")
        const auth = JSON.parse(readFileSync(authPath, "utf8"))
        const key = resolveAuthApiKey(auth, cfg.judge.authProvider ?? undefined)
        if (key) {
          cfg.judge.apiKey = key
        }
        debugLog(
          "info",
          `auth store: key ${key ? `resolved (len ${key.length})` : "not found"}${cfg.judge.authProvider ? ` (provider ${cfg.judge.authProvider})` : ""} | judge model ${cfg.judge.model} ${cfg.judge.baseUrl}`,
        )
      } catch { /* no auth store or unreadable — leave empty, judge fails closed to ask */ }
    }
  }

  const fetchImpl = (typeof fetch === "function" ? fetch : (globalThis as any).fetch)

  const state = new RuntimeState()
  let layaReachable = false

  const logStore = (cfg as any)?.log

  const plugin = createPlugin({ config: cfg as any, fetchImpl, homedir, state, onLayaReachable: (v: boolean) => { layaReachable = v }, logger: (level: string, msg: string) => {
    debugLog(level, msg)
    try { if (ctx?.app?.log) void ctx.app.log({ body: { service: "blotto-mode", level, message: msg } }) } catch { /* */ }
  } })

  const hooks: any = await plugin({ client, project: { ...project, time: { created: Date.now(), updated: Date.now() } } as any, directory, worktree, serverUrl: new URL("http://localhost"), $: {} as any, experimental_workspace: { register() {} } as any })

  // Wire permission resolution into the new permission.evaluate hook.
  // Only act when the effect is still "ask" so a sandbox deny stays final
  // and sandbox's allow-flip for wrapped commands is preserved.
  await ctx.permission.hook("evaluate", async (event: any) => {
    try {
      debugLog("debug", `evaluate fired: effect=${event?.effect} action=${event?.action} resources=${JSON.stringify(event?.resources ?? [])?.slice(0, 200)}`)
      if (!event || event.effect !== "ask") return
      const action = String(event.action ?? "")
      const perm: any = {
        id: `${event.sessionID}:${action}:${(event.resources ?? []).join(",")}`,
        type: action,
        pattern: event.resources ?? [],
        sessionID: event.sessionID,
        title: "",
        metadata: event.metadata ?? {},
      }
      const req = normalize(perm, { worktree, directory, homedir })
      if (!req || !cfg.kinds.includes(req.kind)) return
      const out = { status: "ask" as "ask" | "deny" | "allow" }
      await hooks["permission.ask"](perm, out)
      if (out.status !== "ask") event.effect = out.status
      if (event.message === undefined && (out as any).message) event.message = (out as any).message
      debugLog("debug", `evaluate settled: status=${out.status} perm=${String(perm.id).slice(0, 120)}`)
    } catch (e) {
      debugLog("error", `evaluate failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
      try { console.warn(`blotto-mode evaluate failed: ${String(e)}`) } catch { /* */ }
    }
  })
  debugLog("info", "permission.evaluate hook registered")

  // Forward events so the cache/reply bookkeeping keeps working.
  try {
    const sub = ctx.event.subscribe()
    ;(async () => {
      try {
        for await (const ev of sub) {
          try { await hooks.event({ event: ev }) } catch { /* */ }
        }
      } catch { /* */ }
    })()
  } catch { /* event subscription optional */ }

  // Phase 3: invite the user to run Laya locally when it's enabled but
  // has no endpoint. Laya is the fast tier and runs entirely on the user's
  // machine; without it the judge (network) carries everything.
  if (cfg.laya?.mode && cfg.laya.mode !== "off" && !cfg.laya.baseUrl) {
    const msg = "blotto-mode: Laya is enabled but laya.baseUrl is unset. Install/run laya-serve locally and set laya.baseUrl in blotto-mode.json to use the fast tier."
    try { if (typeof ctx?.app?.log === "function") void ctx.app.log({ body: { service: "blotto-mode", level: "info", message: msg } }); else console.info(msg) } catch { /* */ }
  }

  // Register blotto_mode under the v2 tool editor so the Laya install flow
  // (and status/on/off) is reachable from the agent. Guarded: older hosts
  // without ctx.tool.transform simply skip (the legacy hooks.tool path is not
  // consumed by v2, but the permission path keeps working).
  if (typeof ctx?.tool?.transform === "function") {
    try {
      await ctx.tool.transform((editor: any) => {
        editor.add(blottoModeToolNew(state, () => ({ enabled: cfg.enabled, layaMode: cfg.laya.mode, layaReachable, judgeModel: cfg.judge.model }), {
          getCfg: () => cfg.laya,
          fetchImpl,
          checkPath: (name: string) => {
            try {
              const w = (globalThis as any).Bun?.which
              const found = typeof w === "function" ? (w(name) ?? null) : null
              if (found) return found
              const home = process.env.HOME || ""
              const candidates = [
                `${home}/.pyenv/versions/laya/bin/${name}`,
                `${home}/.local/share/laya-venv/bin/${name}`,
                `${home}/.local/bin/${name}`,
              ]
              for (const c of candidates) { try { if (existsSync(c)) return c } catch {} }
              return null
            } catch { return null }
          },
          setReachable: (v: boolean) => { layaReachable = v },
          probe: (c: any) => probeLaya(c, fetchImpl),
        }))
      })
      debugLog("info", "blotto_mode tool registered via v2 tool editor")
    } catch (e) {
      debugLog("warn", `tool registration failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    }
  } else {
    debugLog("info", "ctx.tool.transform unavailable; blotto_mode tool not registered")
  }

  // Fail-loud guard: the spec default baseUrl is a placeholder. A judge key
  // alone is not enough — without the real endpoint every ask fails closed.
  if (cfg.judge.baseUrl.includes("example.com")) {
    debugLog("warn", `judge.baseUrl is the placeholder ${cfg.judge.baseUrl} — set judge.baseUrl in ~/.config/opencode/blotto-mode.json`)
  } else {
    debugLog("info", `judge endpoint OK: ${cfg.judge.baseUrl}`)
  }
  debugLog("info", "setup complete")

  return async () => { /* cleanup */ }
}