import type { Plugin } from "@opencode-ai/plugin"
import type { Permission } from "@opencode-ai/sdk"
import { homedir as osHomedir } from "node:os"
import { basename } from "node:path"
import { loadConfig, type Config } from "./config"
import { normalize } from "./request"
import { activeRules, rulesTier } from "./rules/engine"
import { SessionCache, cacheTier } from "./cache"
import { fetchContext } from "./context"
import { layaTier, probeLaya } from "./tiers/laya"
import { judgeTier } from "./tiers/judge"
import { runPipeline, InFlight, type PipelineResult } from "./pipeline"
import { sendFeedback } from "./feedback"
import { DecisionLog } from "./log"
import { RuntimeState } from "./state"
import { blottoModeTool } from "./tool"
import type { ActionRequest, Tier, TierEnv } from "./types"

export type TierName = "rules" | "cache" | "laya" | "judge"
export type Logger = (level: "info" | "warn" | "error", msg: string) => void

/**
 * I8: inside OpenCode, stderr is the TUI. The default logger writes through client.app.log (service
 * "blotto-mode"), swallowing its failures; console.error is used only when client.app.log is absent.
 */
export function defaultLogger(client: unknown): Logger {
  const app = (client as { app?: { log?: (o: unknown) => unknown } } | undefined)?.app
  if (typeof app?.log === "function") {
    return (level, message) => {
      try { void Promise.resolve(app.log!({ body: { service: "blotto-mode", level, message } })).catch(() => {}) } catch { /* never throw */ }
    }
  }
  return (level, message) => { if (level !== "info") console.error(`blotto-mode ${level}: ${message}`) }
}

export function createPlugin(deps: {
  config?: Config; fetchImpl?: typeof fetch; homedir?: string; log?: DecisionLog; now?: () => Date
  /** Restrict the pipeline to these tiers (default: all). */
  tiers?: TierName[]
  /** Observer called after the decision is logged; failures are swallowed. */
  onDecision?: (req: ActionRequest, result: PipelineResult) => void
  /** Plugin diagnostics sink (default: client.app.log). */
  logger?: Logger
} = {}): Plugin {
  return async ({ client, project, directory, worktree }) => {
    const homedir = deps.homedir ?? osHomedir()
    const logger = deps.logger ?? defaultLogger(client)
    const plog: TierEnv["log"] = (level, msg, extra) => {
      try { logger(level, `${msg}${extra ? " " + JSON.stringify(extra) : ""}`) } catch { /* never throw */ }
    }
    const cfg = deps.config ?? loadConfig({ worktree, homedir, log: (m) => plog("warn", m) })
    const fetchImpl = deps.fetchImpl ?? fetch
    const now = deps.now ?? (() => new Date())
    const log = deps.log ?? new DecisionLog({ path: cfg.log.path, maxMb: cfg.log.maxMb, onError: (m) => plog("error", m) })
    const rules = activeRules(cfg)
    const cache = new SessionCache({ rules, homedir, sessionPatterns: cfg.cache.sessionPatterns })
    const state = new RuntimeState()
    const inflight = new InFlight()
    const projectName = basename(project.worktree || worktree)

    // I4: keep the probe promise; the laya tier waits for it (bounded) instead of reading a flag
    // that is still false for every request that arrives before the probe settles.
    let layaReachable = false
    let layaProbe: Promise<boolean> = Promise.resolve(false)
    if (cfg.laya.mode !== "off" && cfg.laya.baseUrl) {
      layaProbe = probeLaya(cfg.laya, fetchImpl).then(
        (ok) => { layaReachable = ok; if (!ok) plog("warn", `laya endpoint ${cfg.laya.baseUrl} unreachable; tier will be skipped`); return ok },
        () => { plog("warn", `laya endpoint ${cfg.laya.baseUrl} unreachable; tier will be skipped`); return false },
      )
    }

    const allTiers: { name: TierName; run: Tier; failClosed?: boolean }[] = [
      { name: "rules", run: rulesTier(rules, homedir), failClosed: true },
      { name: "cache", run: cacheTier(cache) },
      { name: "laya", run: layaTier({ cfg: cfg.laya, fetchImpl, reachable: () => layaProbe }) },
      { name: "judge", run: judgeTier({ cfg: cfg.judge, fetchImpl, validateGlob: (g, req) => cache.validateGlob(g, req.kind, req) }) },
    ]
    const tiers = allTiers.filter((t) => !deps.tiers || deps.tiers.includes(t.name))

    async function decide(req: ActionRequest) {
      const result = await runPipeline({ req, tiers, log: plog, context: () => fetchContext(client, req, cfg.judge, { projectName }) })
      const safely = (what: string, fn: () => void) => { try { fn() } catch (e) { plog("error", `${what} failed: ${String(e)}`) } }
      // A cache hit is already remembered; re-remembering would duplicate its session glob.
      if (result.decision.settledBy !== "cache") safely("cache.remember", () => cache.remember(req, result.decision))
      safely("state.count", () => state.count(req.sessionID, result.decision))
      safely("log.append", () => log.append({ kind: "decision", ts: now().toISOString(), permissionID: req.id, sessionID: req.sessionID, requestKind: req.kind, pattern: req.pattern,
        commands: req.commands?.map((c) => c.raw), opaque: req.opaque, stateText: result.stateText, tiers: result.trace,
        final: { status: result.decision.status, settledBy: result.decision.settledBy, reason: result.decision.reason, ruleId: result.decision.ruleId } }))
      safely("onDecision", () => deps.onDecision?.(req, result))
      // Fire-and-forget: the status must not wait on client.session.prompt.
      try { void Promise.resolve(sendFeedback(client, cfg.feedback, req, result.decision, plog)).catch((e) => plog("error", `feedback failed: ${String(e)}`)) }
      catch (e) { plog("error", `feedback failed: ${String(e)}`) }
      return result
    }

    return {
      "permission.ask": async (input: Permission, output) => {
        try {
          if (!state.isEnabled(input.sessionID, cfg.enabled)) return
          const req = normalize(input, { worktree, directory, homedir })
          if (!req || !cfg.kinds.includes(req.kind)) return
          let p = inflight.get(req.id)
          if (!p) { p = decide(req); inflight.set(req.id, p) }
          const { decision } = await p
          if (decision.status !== "ask") output.status = decision.status
        } catch (e) {
          plog("error", `permission.ask failed, leaving ask: ${String(e)}`)
        }
      },
      event: async ({ event }) => {
        try {
          if (event.type === "permission.replied") {
            const { permissionID, sessionID, response } = event.properties
            if (log.has(permissionID)) log.append({ kind: "reply", ts: now().toISOString(), permissionID, sessionID, response })
          } else if (event.type === "session.deleted") {
            const id = event.properties.info.id
            cache.dropSession(id); state.dropSession(id)
          }
        } catch (e) { plog("error", `event handler failed: ${String(e)}`) }
      },
      tool: {
        blotto_mode: blottoModeTool(state, () => ({ enabled: cfg.enabled, layaMode: cfg.laya.mode, layaReachable, judgeModel: cfg.judge.model })),
      },
    }
  }
}

export const BlottoMode: Plugin = createPlugin()
