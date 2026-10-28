import { tool } from "@opencode-ai/plugin"
import type { RuntimeState } from "./state"
import { probeLaya } from "./tiers/laya"
import type { Config } from "./config"

export interface LayaInstallDeps {
  /** Returns the resolved path to `name` on PATH, or null. */
  checkPath?: (name: string) => string | null
  /** Returns the current Laya config slice. */
  getCfg?: () => Config["laya"] | any
  /** Fetch implementation used for the reachability probe. */
  fetchImpl?: typeof fetch
  /** Probe implementation (defaults to probeLaya(cfg, fetchImpl)). */
  probe?: (cfg: any) => Promise<boolean>
  /** Called with the probe result so the plugin's cached flag stays fresh. */
  setReachable?: (v: boolean) => void
}

function defaultCheckPath(name: string): string | null {
  try {
    const w = (globalThis as any).Bun?.which
    const found = typeof w === "function" ? (w(name) ?? null) : null
    if (found) return found
  } catch { /* not a Bun runtime */ }
  const home = (globalThis as any).process?.env?.HOME || ""
  const candidates = [`${home}/.pyenv/versions/laya/bin/${name}`, `${home}/.local/share/laya-venv/bin/${name}`, `${home}/.local/bin/${name}`]
  for (const c of candidates) {
    try {
      const fs = (globalThis as any).require?.("node:fs")
      if (fs && fs.existsSync(c)) return c
    } catch { /* */ }
  }
  return null
}

export function blottoModeTool(
  state: RuntimeState,
  info: () => { enabled: boolean; layaMode: string; layaReachable: boolean; judgeModel: string },
  laya?: LayaInstallDeps,
) {
  return tool({
    description:
      "Show blotto-mode auto-permission status for this session, or turn it on/off for this session only. Cannot change persistent configuration. `laya_install` checks for a local Laya server and probes reachability.",
    args: { action: tool.schema.enum(["status", "on", "off", "laya_install"]).describe("status | on | off | laya_install") },
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
      if (args.action === "laya_install") {
        return await runLayaInstall(laya)
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

// New (OpenCode v2) tool shape, registered via ctx.tool.transform.
export function blottoModeToolNew(
  state: RuntimeState,
  info: () => { enabled: boolean; layaMode: string; layaReachable: boolean; judgeModel: string },
  laya?: LayaInstallDeps,
) {
  return {
    name: "blotto_mode",
    description:
      "Show blotto-mode auto-permission status for this session, or turn it on/off for this session only. Cannot change persistent configuration. `laya_install` checks for a local Laya server and probes reachability.",
    input: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "on", "off", "laya_install"], description: "status | on | off | laya_install" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    output: { type: "string" },
    execute: async (input: any, context: any) => {
      const id = context?.sessionID
      const i = info()
      if (input?.action === "off") {
        state.setEnabled(id, false)
        return { output: "blotto-mode is now off for this session; permission prompts will appear normally." }
      }
      if (input?.action === "on") {
        if (!i.enabled) return { output: "blotto-mode is disabled globally and cannot be enabled from a session." }
        state.setEnabled(id, true)
        return { output: "blotto-mode is now on for this session." }
      }
      if (input?.action === "laya_install") {
        return { output: await runLayaInstall(laya) }
      }
      const c = state.summary(id)
      const enabled = state.isEnabled(id, i.enabled)
      return {
        output: [
          `blotto-mode: ${enabled ? "enabled" : i.enabled ? "disabled for this session" : "disabled globally"}`,
          `judge model: ${i.judgeModel}`,
          `laya: ${i.layaMode}${i.layaMode !== "off" ? (i.layaReachable ? " (reachable)" : " (unreachable)") : ""}`,
          `this session: allowed ${c.allowed}, denied ${c.denied}, asked ${c.asked}`,
          `by tier: ${Object.entries(c.byTier).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
        ].join("\n"),
      }
    },
  }
}

async function runLayaInstall(laya?: LayaInstallDeps): Promise<string> {
  const checkPath = laya?.checkPath ?? defaultCheckPath
  const getCfg = laya?.getCfg ?? (() => null)
  const fetchImpl = laya?.fetchImpl ?? fetch
  const cfg = getCfg()
  const lines: string[] = []
  const found = checkPath("laya-serve")
  if (found) lines.push(`laya-serve found on PATH: ${found}`)
  else {
    lines.push("laya-serve not found on PATH.")
    lines.push("Install Laya (Python 3.10+, optional CUDA):")
    lines.push("  python3 -m venv ~/.local/share/laya-venv")
    lines.push("  ~/.local/share/laya-venv/bin/pip install 'laya[serve]'")
    lines.push("  ln -s ~/.local/share/laya-venv/bin/laya-serve ~/.local/bin/laya-serve")
    lines.push("Then run: LAYA_DEVICE=cuda LAYA_PRELOAD=1 LAYA_API_KEY=<secret> laya-serve   (binds 0.0.0.0:8000)")
    lines.push("Auto-install is intentionally not performed (no sudo).")
  }
  if (cfg?.baseUrl) {
    lines.push(`laya.baseUrl: ${cfg.baseUrl}`)
    try {
      const ok = laya?.probe ? await laya.probe(cfg) : await probeLaya(cfg, fetchImpl)
      laya?.setReachable?.(ok)
      lines.push(`probe: ${ok ? "reachable" : "unreachable"}`)
    } catch (e) {
      lines.push(`probe failed: ${String(e)}`)
    }
  } else {
    lines.push("laya.baseUrl is unset. Set it in blotto-mode.json (default Laya port is 8000: http://127.0.0.1:8000) and restart OpenCode.")
    if (found) lines.push("Then run blotto_mode laya_install again to probe.")
  }
  lines.push(`laya.mode is currently ${cfg?.mode ?? "unknown"}; set to "active" (not just shadow) to let Laya decide.`)
  return lines.join("\n")
}