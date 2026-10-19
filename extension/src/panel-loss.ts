/**
 * Events the VS Code panel never receives (#592). Pure: no vscode dependency, unit-testable.
 *
 * Without the SSE relay there is no buffer, no cursor and no `event-loss.gap`: the extension posts each event straight to
 * the open panel and drops it while no panel is ready. A page that becomes ready (first open, reopen, VS Code restart)
 * starts from a `reset` and is only re-sent, from memory, the agents of the active Claude Code sessions (spawns,
 * dispatches, models, teams; the other runtimes only announce their sessions again): every other event emitted before
 * then is missing from its graph, also the ones an earlier page received live.
 *
 * The ledger counts, per session, the events emitted for the panel since the extension started, as a lower bound.
 * Each emission is one event, except when a watcher reads a session's history again (`release`, then the
 * history re-emitted with `replayed: true`): those copies may repeat events already counted, so the session then
 * counts `max(before, history read again) + events after` (#601 review). When a page is ready, the panel's own replay
 * runs under {@link PanelLossLedger.snapshotAfterReplay}: what it re-sends reaches that page, so it is subtracted (one
 * re-sent event stands for at most one earlier event), and the rest is what the page lacks, sent as `event-loss`. A
 * history read again while that page is open reaches it too: the page's figure is lowered by as much and sent again.
 * The JSONL event log is read from its start each time it is connected: its sessions are released when it is
 * disconnected and that first read counts as a history read again (jsonl-panel.ts). Not counted: an event without
 * session, the hook events dropped before they reach the session watcher, and OpenCode (its re-reads carry no marker,
 * opencode-runtime.ts); it never names a session it saw nothing of.
 */
import type { AgentEvent } from './protocol'

/** Sessions named individually; the least recently touched beyond this are added up in `otherEvents` */
export const PANEL_LOSS_MAX_SESSIONS = 200

export interface PanelLossSnapshot {
  /** Session id -> events of that session this page will never receive (positive counts only) */
  evicted: Record<string, number>
  /** Same, for the sessions no longer named individually; absent when zero */
  otherEvents?: number
}

/** One session's count. Before any release, `base` and `reread` are 0 and the count is `live`. */
interface SessionCount {
  /** Lower bound of the distinct events counted before the last release */
  base: number
  /** History events (`replayed`) emitted since the last release: they may repeat events of `base` */
  reread: number
  /** Other events since the last release (or since the start): new ones */
  live: number
  released: boolean
}

const cap = (n: number): number => Math.min(n, Number.MAX_SAFE_INTEGER)
const total = (s: SessionCount): number => cap(Math.max(s.base, s.reread) + s.live)

/** What the current page lacks, as last sent, and how to send it again */
interface PageFigure {
  evicted: Map<string, number>
  other: number
  send: ((loss: PanelLossSnapshot) => void) | null
}

export class PanelLossLedger {
  /** Insertion order = recency: the first key is the least recently touched session */
  private sessions = new Map<string, SessionCount>()
  private other = 0
  /** Non-null while the panel's replay runs: what it re-sends, per session */
  private replayed: Map<string, number> | null = null
  private page: PageFigure | null = null
  private pageUpdateQueued = false

  constructor(
    private readonly maxSessions: number = PANEL_LOSS_MAX_SESSIONS,
    /** Runs the page update once a burst of history is over (a history is emitted synchronously) */
    private readonly schedule: (fn: () => void) => void = queueMicrotask,
  ) {}

  /**
   * An event emitted for the panel (delivered or not). Without a session id it is not counted. `reread`: the source
   * read it again from a history it had already read (the JSONL log connected again), as an event marked `replayed`.
   */
  note(event: AgentEvent | null | undefined, opts: { reread?: boolean } = {}): void {
    const sid = event?.sessionId
    if (typeof sid !== 'string' || sid.length === 0) return
    if (this.replayed) { this.replayed.set(sid, (this.replayed.get(sid) ?? 0) + 1); return }
    const s = this.touch(sid)
    if (s.released && (event?.replayed === true || opts.reread === true)) {
      s.reread = cap(s.reread + 1)
      this.lowerPage(sid)
    } else {
      s.live = cap(s.live + 1)
    }
    this.fold()
  }

  /**
   * The watcher forgot where it was in this session's history (unwatched): if the session comes back, its history is
   * emitted again and may repeat events already counted. What was counted stays as a floor, not as a sum.
   */
  release(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    const known = this.sessions.get(sessionId)
    if (!known && this.other > 0) {
      // Not named: part of `other` may be this session, and nothing tells how much. Dropping `other` keeps a lower bound
      this.other = 0
    }
    const s = this.touch(sessionId)
    s.base = total(s)
    s.reread = 0
    s.live = 0
    s.released = true
    this.fold()
  }

  /**
   * Runs the panel's replay for a page that just became ready (synchronous) and returns what that page lacks:
   * per session, the events emitted so far minus those the replay re-sent. Null when nothing is lacking.
   * `send` re-sends the page's figure when a history read again lowers it (see `release`).
   */
  snapshotAfterReplay(replay: () => void, send?: (loss: PanelLossSnapshot) => void): PanelLossSnapshot | null {
    const resent = new Map<string, number>()
    this.replayed = resent
    try { replay() } finally { this.replayed = null }
    const evicted = new Map<string, number>()
    let other = this.other
    for (const [sid, n] of resent) {
      if (!this.sessions.has(sid)) other = Math.max(0, other - n)
    }
    for (const [sid, s] of this.sessions) {
      const left = total(s) - (resent.get(sid) ?? 0)
      if (left > 0) evicted.set(sid, left)
    }
    this.page = { evicted, other, send: send ?? null }
    this.pageUpdateQueued = false
    return this.pageSnapshot()
  }

  /** The page whose figure `send` updates was closed: let it go (no more updates, no reference kept) */
  endPage(send: (loss: PanelLossSnapshot) => void): void {
    if (this.page?.send !== send) return
    this.page = null
    this.pageUpdateQueued = false
  }

  /** Forget everything (tests) */
  clear(): void {
    this.sessions = new Map()
    this.other = 0
    this.replayed = null
    this.page = null
    this.pageUpdateQueued = false
  }

  private touch(sid: string): SessionCount {
    const s = this.sessions.get(sid) ?? { base: 0, reread: 0, live: 0, released: false }
    this.sessions.delete(sid)
    this.sessions.set(sid, s)
    return s
  }

  private fold(): void {
    while (this.sessions.size > Math.max(1, this.maxSessions)) {
      const [oldest, s] = this.sessions.entries().next().value as [string, SessionCount]
      this.other = cap(this.other + total(s))
      this.sessions.delete(oldest)
    }
  }

  /** A history event read again reached the open page: it stands for at most one event that page lacked */
  private lowerPage(sid: string): void {
    const page = this.page
    if (!page) return
    const n = page.evicted.get(sid)
    if (n !== undefined) {
      if (n > 1) page.evicted.set(sid, n - 1)
      else page.evicted.delete(sid)
    } else if (page.other > 0) {
      // Not named on the page: if it lacked any event of this session, they were in `other`
      page.other--
    } else {
      return
    }
    if (!page.send || this.pageUpdateQueued) return
    this.pageUpdateQueued = true
    this.schedule(() => {
      this.pageUpdateQueued = false
      if (this.page !== page || !page.send) return
      // Sent even when empty: the page must drop a figure that no longer holds
      page.send(this.pageSnapshot() ?? { evicted: {} })
    })
  }

  private pageSnapshot(): PanelLossSnapshot | null {
    const page = this.page
    if (!page || (page.evicted.size === 0 && page.other === 0)) return null
    const evicted = Object.fromEntries(page.evicted)
    return page.other > 0 ? { evicted, otherEvents: page.other } : { evicted }
  }
}

/** The extension's ledger: it outlives the panels, since a reopened page lacks what earlier pages received */
export const panelLoss = new PanelLossLedger()
