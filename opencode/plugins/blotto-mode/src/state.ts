import type { Decision } from "./types"

export interface Counters { allowed: number; denied: number; asked: number; byTier: Record<string, number> }

export class RuntimeState {
  overrides = new Map<string, boolean>()
  counters = new Map<string, Counters>()

  /** The global switch is authoritative: a session override can only narrow it, never re-enable. */
  isEnabled(sessionID: string, globalEnabled: boolean): boolean {
    return globalEnabled && (this.overrides.get(sessionID) ?? true)
  }

  setEnabled(sessionID: string, on: boolean): void { this.overrides.set(sessionID, on) }

  count(sessionID: string, d: Decision): void {
    const c = this.summary(sessionID)
    if (d.status === "allow") c.allowed++
    else if (d.status === "deny") c.denied++
    else c.asked++
    c.byTier[d.settledBy] = (c.byTier[d.settledBy] ?? 0) + 1
    this.counters.set(sessionID, c)
  }

  summary(sessionID: string): Counters {
    return this.counters.get(sessionID) ?? { allowed: 0, denied: 0, asked: 0, byTier: {} }
  }

  dropSession(id: string): void { this.overrides.delete(id); this.counters.delete(id) }
}
