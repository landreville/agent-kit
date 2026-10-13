import type { ActionRequest, Decision, SessionContext, Tier, TierEnv, TierTrace } from "./types"

export interface PipelineResult { decision: Decision; trace: TierTrace; signals: string[]; stateText?: string; ms: number }

/** A tier spec. `failClosed` tiers (the rules tier by default) end the pipeline in ask when they throw. */
export interface TierSpec { name: string; run: Tier; failClosed?: boolean }

export async function runPipeline(opts: { req: ActionRequest; tiers: TierSpec[]; context: () => Promise<SessionContext>; log: TierEnv["log"]; prefetchContextFrom?: string }): Promise<PipelineResult> {
  const t0 = performance.now()
  let memo: Promise<SessionContext> | undefined
  const context = () => (memo ??= (async () => opts.context())())
  const env: TierEnv = { context, signals: [], trace: {}, log: opts.log }
  const prefetchAt = opts.prefetchContextFrom ?? "laya"
  let decision: Decision | undefined
  for (const tier of opts.tiers) {
    if (tier.name === prefetchAt) void context().catch(() => {})
    try {
      decision = await tier.run(opts.req, env)
    } catch (e) {
      opts.log("error", `tier ${tier.name} threw: ${String(e)}`)
      env.trace[tier.name] = { ...(env.trace[tier.name] ?? {}), threw: String(e) }
      // M1: if the deny-only rules cannot run, no later (allow-capable) tier may decide.
      if (tier.failClosed ?? tier.name === "rules") { decision = { status: "ask", reason: `tier ${tier.name} failed`, settledBy: "fallback" }; break }
    }
    if (decision) break
  }
  const stateText = typeof env.trace.laya?.state === "string" ? (env.trace.laya.state as string) : undefined
  return { decision: decision ?? { status: "ask", reason: "no tier decided", settledBy: "fallback" }, trace: env.trace, signals: env.signals, stateText, ms: +(performance.now() - t0).toFixed(0) }
}

export class InFlight {
  private map = new Map<string, Promise<PipelineResult>>()
  get(id: string) { return this.map.get(id) }
  set(id: string, p: Promise<PipelineResult>) {
    this.map.set(id, p)
    // M6: the cleanup timer must not keep the process alive.
    const drop = () => { const t = setTimeout(() => this.map.delete(id), 5000); (t as { unref?: () => void }).unref?.() }
    void p.then(drop, drop)
  }
  delete(id: string) { this.map.delete(id) }
}
