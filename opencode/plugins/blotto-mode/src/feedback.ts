import type { Config } from "./config"
import type { ActionRequest, Decision, TierEnv } from "./types"
import { INJECT_MARKER } from "./context"

export function denialText(req: ActionRequest, d: Decision): string {
  const first = (req.pattern.split("\n")[0] ?? "").slice(0, 120)
  return `${INJECT_MARKER} Denied: ${d.reason}${d.ruleId ? ` (rule ${d.ruleId})` : ""}. Action: ${req.kind} \`${first}\`. Choose a different approach or ask the user.`
}

export async function sendFeedback(client: any, cfg: Config["feedback"], req: ActionRequest, d: Decision, log: TierEnv["log"]): Promise<void> {
  if (d.status === "allow") return
  if (d.status === "ask" && d.settledBy !== "fallback") return
  if (d.status === "deny" && cfg.injectDenialReason) {
    try {
      await client.session.prompt({ path: { id: req.sessionID }, body: { noReply: true, parts: [{ type: "text", text: denialText(req, d), synthetic: true }] } })
    } catch (e) {
      log("warn", `denial injection failed: ${String(e)}`)
    }
  }
  if (cfg.toast) {
    const first = (req.pattern.split("\n")[0] ?? "").slice(0, 60)
    const body = d.status === "deny"
      ? { title: "blotto-mode denied", message: `${first}: ${d.reason}`, variant: "error" as const, duration: 6000 }
      : { title: "blotto-mode: asking you", message: `${first}: ${d.reason}`, variant: "warning" as const, duration: 4000 }
    try {
      await client.tui.showToast({ body })
    } catch (e) {
      log("warn", `toast failed: ${String(e)}`)
    }
  }
}
