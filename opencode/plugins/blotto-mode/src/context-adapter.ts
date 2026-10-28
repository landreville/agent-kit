// Adapter from the new (OpenCode v2) in-process plugin context to the
// legacy `@opencode-ai/plugin` client shape that blotto-mode's internals
// expect. This keeps the rules/cache/judge/context/feedback modules
// untouched while letting the plugin load under the current loader.
//
// The adapter is intentionally loose (ctx: any): the new context's domains
// are typed by `@opencode/plugin`, which this package does not depend on.
// Only the handful of methods blotto actually uses are bridged.

import { homedir as osHomedir } from "node:os"

export interface AdaptedContext {
  client: any
  project: { id: string; worktree: string }
  directory: string
  worktree: string
  homedir: string
}

export function adaptContext(ctx: any, overrides?: { homedir?: string; worktree?: string; directory?: string }): AdaptedContext {
  const directory = overrides?.directory ?? (((typeof ctx?.location?.directory === "string" && ctx.location.directory) || process.cwd()))
  const worktree = overrides?.worktree ?? (((typeof ctx?.location?.project?.directory === "string" && ctx.location.project.directory) || directory))
  const projectId = (typeof ctx?.location?.project?.id === "string" && ctx.location.project.id) || "unknown"
  const homedir = overrides?.homedir ?? osHomedir()

  const client = {
    app: {
      log: async (_o: any) => ({ data: true }),
    },
    session: {
      get: async (o: any) => {
        const id = o?.path?.id ?? o?.sessionID
        try {
          const data = await ctx.session.get({ sessionID: id })
          return { data: { id, ...(data ?? {}) } }
        } catch (e) {
          return { error: { message: String(e) } }
        }
      },
      messages: async (o: any) => {
        const id = o?.path?.id ?? o?.sessionID
        const limit = o?.query?.limit
        try {
          const res = await ctx.session.message.list({ sessionID: id, limit })
          const data = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : [])
          return { data }
        } catch (e) {
          return { error: { message: String(e) } }
        }
      },
      prompt: async (o: any) => {
        const id = o?.path?.id ?? o?.sessionID
        const text = o?.body?.parts?.map((p: any) => p?.text).filter(Boolean).join("\n") ?? ""
        try {
          if (text) await ctx.session.synthetic({ sessionID: id, text })
          return { data: {} }
        } catch (e) {
          return { error: { message: String(e) } }
        }
      },
    },
    tui: { showToast: async (_o: any) => ({ data: true }) },
  }

  return { client, project: { id: projectId, worktree }, directory, worktree, homedir }
}