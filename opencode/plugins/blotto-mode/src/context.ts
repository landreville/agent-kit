import type { OpencodeClient } from "@opencode-ai/sdk"
import type { Config } from "./config"
import type { ActionRequest, SessionContext } from "./types"

export const INJECT_MARKER = "[blotto-mode]"
const INTENT_CAP = 400
const PER_MESSAGE_CAP = 1200
/** I9: how many parent links fetchContext follows from a subagent session to its root. */
export const MAX_PARENT_HOPS = 5

export function estimateTokens(s: string): number { return Math.ceil(s.length / 4) }

export const TIMED_OUT: unique symbol = Symbol("timed out")
/** Resolve with `p`, or TIMED_OUT once `ms` elapses. Never rejects because of the timer; the timer never holds the process open. */
export function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) { p.catch(() => {}); return Promise.resolve(TIMED_OUT) }
  let timer: ReturnType<typeof setTimeout> | undefined
  const t = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); (timer as { unref?: () => void }).unref?.() })
  return Promise.race([p, t]).finally(() => clearTimeout(timer))
}

/**
 * Minimal structural view of an SDK message. Only the fields buildContext reads
 * are described; tool output, file parts and everything else are never touched.
 */
export type ContextMessage = {
  info: { id: string; role: string; time: { created: number } }
  parts: { type: string; text?: string; synthetic?: boolean }[]
}

// Only plain, non-synthetic text parts are read: never tool state/output, file or other parts.
function textOf(parts: ContextMessage["parts"]): string {
  return parts.filter((p) => p.type === "text" && typeof p.text === "string" && !p.synthetic).map((p) => p.text as string).join("\n").trim()
}

const byCreated = (ms: ContextMessage[]) => [...ms].sort((a, b) => a.info.time.created - b.info.time.created)

/**
 * `messages` is the requesting session (the agent's intent comes from here). `userMessagesFrom`, when
 * given, is the root session of a subagent chain and supplies the user messages instead (I9).
 */
export function buildContext(input: { messages: ContextMessage[]; userMessagesFrom?: ContextMessage[]; permissionMessageID: string; userMessageCount: number; tokenBudget: number; projectName: string; worktree: string; gitDirty?: boolean }): SessionContext {
  const sorted = byCreated(input.messages)
  const userSource = input.userMessagesFrom ? byCreated(input.userMessagesFrom) : sorted
  const users = userSource.filter((m) => m.info.role === "user").map((m) => textOf(m.parts)).filter((t) => t && !t.startsWith(INJECT_MARKER))
  let recent = users.slice(-input.userMessageCount).map((t) => t.length > PER_MESSAGE_CAP ? t.slice(0, PER_MESSAGE_CAP) + "…" : t)
  let intent: string | undefined
  const own = sorted.find((m) => m.info.id === input.permissionMessageID && m.info.role === "assistant")
  const source = own ?? [...sorted].reverse().find((m) => m.info.role === "assistant")
  if (source) { const t = textOf(source.parts); if (t) intent = t.slice(0, INTENT_CAP) }
  const budget = Math.max(0, input.tokenBudget - estimateTokens(intent ?? ""))
  // Drop or trim oldest first until the user messages fit.
  while (recent.length && recent.reduce((n, m) => n + estimateTokens(m), 0) > budget) {
    if (recent.length === 1) { recent = budget > 0 ? [recent[0]!.slice(-(budget * 4))] : []; break }
    recent.shift()
  }
  const ctx: SessionContext = { userMessages: recent, assistantIntent: intent, gitDirty: input.gitDirty, projectName: input.projectName, worktree: input.worktree, unavailable: false }
  if (input.userMessagesFrom) ctx.fromRootSession = true
  return ctx
}

async function messagesOf(client: OpencodeClient, id: string, limit: number): Promise<ContextMessage[]> {
  const res = await client.session.messages({ path: { id }, query: { limit } })
  if (res.error || !Array.isArray(res.data)) throw new Error((res.error as { message?: string } | undefined)?.message ?? "no data")
  return res.data as ContextMessage[]
}

/** I9: follow parentID links to the root session, at most MAX_PARENT_HOPS; any failure throws. */
async function rootSessionOf(client: OpencodeClient, id: string): Promise<string> {
  const seen = new Set([id])
  let cur = id
  for (let hop = 0; ; hop++) {
    const res = await client.session.get({ path: { id: cur } })
    if (res.error || !res.data) throw new Error((res.error as { message?: string } | undefined)?.message ?? "session.get: no data")
    const parent = (res.data as { parentID?: string }).parentID
    if (!parent) return cur
    if (hop >= MAX_PARENT_HOPS || seen.has(parent)) throw new Error("session parent chain too deep or cyclic")
    seen.add(parent)
    cur = parent
  }
}

export async function fetchContext(client: OpencodeClient, req: ActionRequest, cfg: Config["judge"], meta: { projectName: string; gitDirty?: boolean }): Promise<SessionContext> {
  try {
    const limit = Math.max(cfg.userMessageCount * 4, 20)
    const [root, own] = await Promise.all([rootSessionOf(client, req.sessionID), messagesOf(client, req.sessionID, limit)])
    // In a subagent (child) session the "user" messages are the parent agent's prompt; read the root's.
    const userMessagesFrom = root === req.sessionID ? undefined : await messagesOf(client, root, limit)
    return buildContext({ messages: own, userMessagesFrom, permissionMessageID: req.messageID, userMessageCount: cfg.userMessageCount, tokenBudget: cfg.contextTokenBudget, projectName: meta.projectName, worktree: req.worktree, gitDirty: meta.gitDirty })
  } catch {
    return { userMessages: [], assistantIntent: undefined, gitDirty: meta.gitDirty, projectName: meta.projectName, worktree: req.worktree, unavailable: true }
  }
}
