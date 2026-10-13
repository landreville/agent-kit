export type Kind = "bash" | "webfetch" | "websearch" | "external_directory" | "edit" | "mcp"
export type Status = "allow" | "deny" | "ask"
export type SettledBy = "rules" | "cache" | "laya" | "judge" | "fallback" | "override"

export interface Redirect {
  target: string
  append: boolean
}

export interface SimpleCommand {
  /** Command name with env-assignment prefixes removed, e.g. "rm" */
  name: string
  args: string[]
  redirects: Redirect[]
  /** True when a network command is downstream in the same pipeline, or this command
   *  came from a $(...) substitution inside a network command's arguments. */
  pipedToNetwork: boolean
  /** Source text of this simple command as best reconstructed. */
  raw: string
  /** Pipeline membership: commands joined by | share an id; index is position (0-based). */
  pipeline?: { id: number; index: number }
  /** True when this command ran inside a substitution whose output is executed as code:
   *  `$(curl …)` as a command name, a shell's -c payload, or an eval/source/. argument. */
  outputExecuted?: boolean
}

export interface ActionRequest {
  id: string
  sessionID: string
  messageID: string
  callID?: string
  kind: Kind
  /** Raw pattern; string[] joined with "\n". */
  pattern: string
  title: string
  commands?: SimpleCommand[]
  /** True when bash parsing failed; rules are skipped. */
  opaque: boolean
  url?: URL
  /** Resolved absolute path for edit / external_directory. */
  path?: string
  mcp?: { server: string; tool: string }
  /** The raw OpenCode permission type (e.g. "bash", "write", "github__delete_repo"). Part of the cache key. */
  permType?: string
  /** Agent-supplied permission metadata; kept for mcp requests (tool arguments). */
  metadata?: Record<string, unknown>
  worktree: string
  directory: string
}

export interface Decision {
  status: Status
  reason: string
  settledBy: SettledBy
  ruleId?: string
  /** Judge-proposed glob, already validated by the cache guard. */
  sessionPattern?: string
}

export interface SessionContext {
  /** Oldest first. Plugin-injected messages removed. */
  userMessages: string[]
  assistantIntent?: string
  gitDirty?: boolean
  projectName: string
  worktree: string
  /** True when the messages call failed. */
  unavailable: boolean
  /** True when the request came from a subagent session and userMessages are the root session's. */
  fromRootSession?: boolean
}

export interface TierTrace {
  [tier: string]: Record<string, unknown>
}

export interface TierEnv {
  /** Lazily fetched, memoized; safe to call from several tiers. */
  context: () => Promise<SessionContext>
  /** Laya signal ids that fired; judge reads them, laya writes them. */
  signals: string[]
  /** Per-tier debug data for the decision log. */
  trace: TierTrace
  log: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void
}

export type Tier = (req: ActionRequest, env: TierEnv) => Promise<Decision | undefined>
