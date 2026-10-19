/**
 * Events the VS Code panel never receives (#592). Pure: no vscode dependency, unit-testable.
 *
 * Without the SSE relay there is no buffer, no cursor and no `event-loss.gap`: the extension posts each event straight to
 * the open panel and drops it while no panel is ready. A page that becomes ready (first open, reopen, VS Code restart)
 * starts from a `reset` and is only re-sent, from memory, the agents of the active sessions (spawns, dispatches, models,
 * teams): every other event emitted before then is missing from its graph, also the ones an earlier page received live.
 *
 * The ledger counts, per session, the events emitted for the panel since the extension started. When a page is ready,
 * the panel's own replay runs under {@link PanelLossLedger.snapshotAfterReplay}: what it re-sends reaches that page, so
 * it is subtracted (one re-sent event stands for at most one earlier event), and the rest is what the page lacks, sent
 * as `event-loss`. A lower bound: an event without session and the hook events dropped before they reach the session
 * watcher are not counted; it never names a session it saw nothing of.
 */
import type { AgentEvent } from './protocol'
import { createEvictedTally, addEvicted, type EvictedTally } from './relay-guards'

/** Sessions named individually; the least recently touched beyond this are added up in `otherEvents` */
export const PANEL_LOSS_MAX_SESSIONS = 200

export interface PanelLossSnapshot {
  /** Session id -> events of that session this page will never receive (positive counts only) */
  evicted: Record<string, number>
  /** Same, for the sessions no longer named individually; absent when zero */
  otherEvents?: number
}

export class PanelLossLedger {
  private tally: EvictedTally = createEvictedTally()
  /** Non-null while the panel's replay runs: what it re-sends, per session */
  private replayed: Map<string, number> | null = null

  constructor(private readonly maxSessions: number = PANEL_LOSS_MAX_SESSIONS) {}

  /** An event emitted for the panel (delivered or not). Without a session id it is not counted. */
  note(event: AgentEvent | null | undefined): void {
    const sid = event?.sessionId
    if (typeof sid !== 'string' || sid.length === 0) return
    if (this.replayed) { this.replayed.set(sid, (this.replayed.get(sid) ?? 0) + 1); return }
    addEvicted(this.tally, sid, 1, this.maxSessions)
  }

  /**
   * Runs the panel's replay for a page that just became ready (synchronous) and returns what that page lacks:
   * per session, the events emitted so far minus those the replay re-sent. Null when nothing is lacking.
   */
  snapshotAfterReplay(replay: () => void): PanelLossSnapshot | null {
    const resent = new Map<string, number>()
    this.replayed = resent
    try { replay() } finally { this.replayed = null }
    const evicted: Record<string, number> = {}
    let other = this.tally.other
    for (const [sid, n] of resent) {
      if (!this.tally.bySession.has(sid)) other = Math.max(0, other - n)
    }
    for (const [sid, total] of this.tally.bySession) {
      const left = total - (resent.get(sid) ?? 0)
      if (left > 0) evicted[sid] = left
    }
    if (Object.keys(evicted).length === 0 && other === 0) return null
    return other > 0 ? { evicted, otherEvents: other } : { evicted }
  }

  /** Forget everything (tests) */
  clear(): void { this.tally = createEvictedTally(); this.replayed = null }
}

/** The extension's ledger: it outlives the panels, since a reopened page lacks what earlier pages received */
export const panelLoss = new PanelLossLedger()
