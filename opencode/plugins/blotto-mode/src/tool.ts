import { tool } from "@opencode-ai/plugin"
import type { RuntimeState } from "./state"

export function blottoModeTool(
  state: RuntimeState,
  info: () => { enabled: boolean; layaMode: string; layaReachable: boolean; judgeModel: string },
) {
  return tool({
    description:
      "Show blotto-mode auto-permission status for this session, or turn it on/off for this session only. Cannot change persistent configuration.",
    args: { action: tool.schema.enum(["status", "on", "off"]).describe("status | on | off") },
    async execute(args, context) {
      const id = context.sessionID
      const i = info()
      if (args.action === "off") {
        state.setEnabled(id, false)
        return "blotto-mode is now off for this session; permission prompts will appear normally."
      }
      if (args.action === "on") {
        // The global switch is authoritative; a session cannot re-enable it. Nothing is recorded.
        if (!i.enabled) return "blotto-mode is disabled globally and cannot be enabled from a session."
        state.setEnabled(id, true)
        return "blotto-mode is now on for this session."
      }
      const c = state.summary(id)
      const enabled = state.isEnabled(id, i.enabled)
      return [
        `blotto-mode: ${enabled ? "enabled" : i.enabled ? "disabled for this session" : "disabled globally"}`,
        `judge model: ${i.judgeModel}`,
        `laya: ${i.layaMode}${i.layaMode !== "off" ? (i.layaReachable ? " (reachable)" : " (unreachable)") : ""}`,
        `this session: allowed ${c.allowed}, denied ${c.denied}, asked ${c.asked}`,
        `by tier: ${Object.entries(c.byTier).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
      ].join("\n")
    },
  })
}
