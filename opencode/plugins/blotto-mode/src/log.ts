import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs"
import { dirname } from "node:path"
import type { Kind, SettledBy, Status, TierTrace } from "./types"

export interface DecisionRecord {
  kind: "decision"; ts: string; permissionID: string; sessionID: string; requestKind: Kind; pattern: string
  commands?: string[]; opaque: boolean; stateText?: string; tiers: TierTrace
  final: { status: Status; settledBy: SettledBy; reason: string; ruleId?: string }
}
export interface ReplyRecord { kind: "reply"; ts: string; permissionID: string; sessionID: string; response: string }
export type LogRecord = DecisionRecord | ReplyRecord

export class DecisionLog {
  private seen = new Set<string>()
  private warned = false
  /** `onError` receives the first write failure (I8: never console.error from inside OpenCode). */
  constructor(private opts: { path: string; maxMb: number; onError?: (msg: string) => void }) {}

  has(permissionID: string): boolean { return this.seen.has(permissionID) }

  append(r: LogRecord): void {
    if (r.kind === "decision") { this.seen.add(r.permissionID); if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!) }
    try {
      // M5: the log holds commands and reasons; keep it private to the user.
      mkdirSync(dirname(this.opts.path), { recursive: true, mode: 0o700 })
      if (existsSync(this.opts.path) && statSync(this.opts.path).size > this.opts.maxMb * 1024 * 1024) renameSync(this.opts.path, this.opts.path + ".1")
      appendFileSync(this.opts.path, JSON.stringify(r) + "\n", { mode: 0o600 })
    } catch (e) {
      if (!this.warned) {
        this.warned = true
        try { this.opts.onError?.(`cannot write log ${this.opts.path}: ${String(e)}`) } catch { /* never throw from append */ }
      }
    }
  }

  static read(path: string): LogRecord[] {
    if (!existsSync(path)) return []
    const out: LogRecord[] = []
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue
      try { const r = JSON.parse(line); if (r && (r.kind === "decision" || r.kind === "reply")) out.push(r) } catch { /* skip */ }
    }
    return out
  }

  static merge(records: LogRecord[]): (DecisionRecord & { userReply?: string })[] {
    const decisions = new Map<string, DecisionRecord & { userReply?: string }>()
    for (const r of records) if (r.kind === "decision") decisions.set(r.permissionID, { ...r })
    for (const r of records) if (r.kind === "reply") { const d = decisions.get(r.permissionID); if (d) d.userReply = r.response }
    return [...decisions.values()]
  }
}
