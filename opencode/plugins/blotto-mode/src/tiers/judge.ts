import { z } from "zod"
import type { Config } from "../config"
import type { ActionRequest, SessionContext, Status, Tier } from "../types"
import { SYSTEM_PROMPT, renderUserPrompt } from "../prompt"
import { raceTimeout, TIMED_OUT } from "../context"

export const VerdictSchema = z.object({
  verdict: z.enum(["allow", "deny", "ask"]),
  reason: z.string().transform((s) => s.slice(0, 160)),
  session_pattern: z.string().nullable().optional().transform((v) => v ?? null),
})
export type Verdict = { verdict: Status; reason: string; session_pattern: string | null }

const JSON_SCHEMA = {
  name: "permission_verdict", strict: true,
  schema: { type: "object", additionalProperties: false, required: ["verdict", "reason", "session_pattern"],
    properties: { verdict: { type: "string", enum: ["allow", "deny", "ask"] }, reason: { type: "string" }, session_pattern: { type: ["string", "null"] } } },
}

export function parseVerdict(content: string): Verdict | undefined {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  const start = stripped.indexOf("{"), end = stripped.lastIndexOf("}")
  if (start < 0 || end < start) return undefined
  try { const r = VerdictSchema.safeParse(JSON.parse(stripped.slice(start, end + 1))); return r.success ? r.data : undefined } catch { return undefined }
}

export async function callJudge(opts: { cfg: Config["judge"]; model: string; system: string; user: string; fetchImpl: typeof fetch; responseFormat?: "json_schema" | "json_object"; deadline?: number }): Promise<{ content: string; tokensIn?: number; tokensOut?: number }> {
  const fmt = opts.responseFormat ?? "json_schema"
  const body = {
    model: opts.model, temperature: 0, max_tokens: 200,
    messages: [{ role: "system", content: opts.system }, { role: "user", content: opts.user }],
    response_format: fmt === "json_schema" ? { type: "json_schema", json_schema: JSON_SCHEMA } : { type: "json_object" },
  }
  const remaining = opts.deadline === undefined ? opts.cfg.timeoutMs : opts.deadline - Date.now()
  if (remaining <= 0) throw new Error("judge: deadline exceeded")
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), remaining)
  try {
    const res = await opts.fetchImpl(`${opts.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json", Authorization: `Bearer ${opts.cfg.apiKey}` },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (res.status === 400 && fmt === "json_schema" && /response_format|json_schema/i.test(text)) return callJudge({ ...opts, responseFormat: "json_object" })
    if (!res.ok) throw new Error(`judge http ${res.status}: ${text.slice(0, 200)}`)
    const json = JSON.parse(text)
    const content = json?.choices?.[0]?.message?.content
    if (typeof content !== "string") throw new Error("judge: no content")
    return { content, tokensIn: json?.usage?.prompt_tokens, tokensOut: json?.usage?.completion_tokens }
  } finally { clearTimeout(timer) }
}

export function judgeTier(opts: { cfg: Config["judge"]; validateGlob: (glob: string, req: ActionRequest) => boolean; fetchImpl?: typeof fetch }): Tier {
  const fetchImpl = opts.fetchImpl ?? fetch
  return async (req, env) => {
    const t0 = performance.now()
    const deadline = Date.now() + opts.cfg.timeoutMs
    const unavailable = (): SessionContext => ({ userMessages: [], projectName: req.worktree.split("/").filter(Boolean).pop() ?? "", worktree: req.worktree, unavailable: true })
    let ctx: SessionContext
    // I1: the context fetch shares the judge's deadline; a hanging session API must not hang the ask.
    try {
      const r = await raceTimeout(env.context(), deadline - Date.now())
      if (r === TIMED_OUT) { env.log("warn", "judge: context timed out"); ctx = unavailable() } else ctx = r
    } catch (e) {
      env.log("warn", `judge: context failed: ${String(e)}`)
      ctx = unavailable()
    }
    const user = renderUserPrompt(req, ctx, env.signals)
    const models = [opts.cfg.model, ...(opts.cfg.fallbackModel ? [opts.cfg.fallbackModel] : [])]
    for (const model of models) {
      if (deadline - Date.now() <= 0) break
      try {
        const r = await callJudge({ cfg: opts.cfg, model, system: SYSTEM_PROMPT, user, fetchImpl, deadline })
        const v = parseVerdict(r.content)
        if (!v) { env.log("warn", `judge ${model}: unparseable verdict`, { content: r.content.slice(0, 200) }); continue }
        const pattern = v.verdict === "allow" && v.session_pattern && opts.validateGlob(v.session_pattern, req) ? v.session_pattern : undefined
        env.trace.judge = { model, verdict: v.verdict, reason: v.reason, pattern: pattern ?? null, proposed: v.session_pattern, tokensIn: r.tokensIn, tokensOut: r.tokensOut, ms: +(performance.now() - t0).toFixed(0) }
        return { status: v.verdict, reason: v.reason, settledBy: "judge", ...(pattern ? { sessionPattern: pattern } : {}) }
      } catch (e) {
        env.log("warn", `judge ${model} failed: ${String(e)}`)
      }
    }
    env.trace.judge = { model: opts.cfg.model, verdict: null, error: true, ms: +(performance.now() - t0).toFixed(0) }
    return undefined
  }
}
