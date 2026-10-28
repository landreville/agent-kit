import type { Permission } from "@opencode-ai/sdk"
import { resolve } from "node:path"
import type { ActionRequest, Kind } from "./types"
import { parseBash } from "./bash"

const DIRECT: Record<string, Kind> = { bash: "bash", shell: "bash", webfetch: "webfetch", websearch: "websearch", external_directory: "external_directory", edit: "edit", write: "edit" }

export function kindOf(type: string): Kind | undefined {
  if (type in DIRECT) return DIRECT[type]
  if (type.includes("__")) return "mcp"
  return undefined
}

export function expandHome(p: string, homedir: string): string {
  if (p === "~" || p.startsWith("~/")) return homedir + p.slice(1)
  return p.replace(/^\$HOME(?=\/|$)/, homedir).replace(/^\$\{HOME\}(?=\/|$)/, homedir)
}

export function normalize(p: Permission, env: { worktree: string; directory: string; homedir: string }): ActionRequest | undefined {
  const kind = kindOf(p.type)
  if (!kind) return undefined
  const joined = Array.isArray(p.pattern) ? p.pattern.join("\n") : (p.pattern ?? "")
  const pattern = kind === "bash" && typeof p.metadata?.command === "string" ? p.metadata.command : joined
  const req: ActionRequest = {
    id: p.id, sessionID: p.sessionID, messageID: p.messageID, callID: p.callID,
    kind, pattern, title: p.title, opaque: false, worktree: env.worktree, directory: env.directory, permType: p.type,
  }
  if (kind === "bash") { const r = parseBash(pattern); req.commands = r.commands; req.opaque = r.opaque }
  if (kind === "webfetch") { try { req.url = new URL(pattern) } catch { /* leave undefined */ } }
  if (kind === "edit" || kind === "external_directory") {
    const first = pattern.split("\n")[0] ?? ""
    req.path = resolve(env.directory, expandHome(first, env.homedir))
  }
  if (kind === "mcp") {
    const i = p.type.indexOf("__")
    req.mcp = { server: p.type.slice(0, i), tool: p.type.slice(i + 2) }
    if (p.metadata && typeof p.metadata === "object") req.metadata = p.metadata as Record<string, unknown>
  }
  return req
}
