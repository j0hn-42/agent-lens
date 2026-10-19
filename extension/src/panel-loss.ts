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
 * history re-emitted with `replayed: true`): those copies may repeat events already counted, so a session still in
 * the ledger then counts `max(before, history read again) + events after` (#601 review). At most
 * {@link PANEL_LOSS_MAX_SESSIONS} sessions are kept; the least recently touched beyond are DROPPED, not added up
 * anywhere (#605 review, round 2: a running total of dropped sessions cannot tell which session its events belong to,
 * so a dropped session that came back was counted twice). A dropped session that comes back starts from zero: its
 * history read again counts as new events, which never exceeds its distinct events. When a page is ready, the panel's
 * own replay runs under {@link PanelLossLedger.snapshotAfterReplay}: what it re-sends reaches that page, so it is
 * subtracted (one re-sent event stands for at most one earlier event), and the rest is what the page lacks, sent as
 * `event-loss`. A history event read again while that page is open reaches it too: each one lowers the page's figure
 * for its session by one, and the figure is sent again.
 * The JSONL event log is read from its start each time it is connected: its sessions are released when it is
 * disconnected and that first read counts as a history read again (jsonl-panel.ts). Not counted: an event without
 * session, the hook events dropped before they reach the session watcher, and OpenCode (its re-reads carry no marker,
 * opencode-runtime.ts); it never names a session it saw nothing of.
 */
import type { AgentEvent } from './protocol'

/** Sessions counted; the least recently touched beyond this are dropped from the figure (a lower bound) */
export const PANEL_LOSS_MAX_SESSIONS = 200

export interface PanelLossSnapshot {
  /** Session id -> events of that session this page will never receive (positive counts only) */
  evicted: Record<string, number>
}

/**
 * One session's count. Before any release `base` is 0, so the count is `reread + live`: where a history event goes
 * makes no difference until a release gives `base` a value.
 */
interface SessionCount {
  /** Lower bound of the distinct events counted before the last release */
  base: number
  /** History events (`replayed`) emitted since the last release: they may repeat events of `base` */
  reread: number
  /** Other events since the last release (or since the start): new ones */
  live: number
}

const cap = (n: number): number => Math.min(n, Number.MAX_SAFE_INTEGER)
const total = (s: SessionCount): number => cap(Math.max(s.base, s.reread) + s.live)

/** What the current page lacks, as last sent, and how to send it again */
interface PageFigure {
  evicted: Map<string, number>
  send: ((loss: PanelLossSnapshot) => void) | null
}

export class PanelLossLedger {
  /** Insertion order = recency: the first key is the least recently touched session */
  private sessions = new Map<string, SessionCount>()
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
    const again = event?.replayed === true || opts.reread === true
    // A copy that reaches the open page stands for at most one event of that session it lacked (released or not)
    if (again) this.lowerPage(sid)
    const s = this.touch(sid)
    if (again) s.reread = cap(s.reread + 1)
    else s.live = cap(s.live + 1)
    this.drop()
  }

  /**
   * The watcher forgot where it was in this session's history (unwatched): if the session comes back, its history is
   * emitted again and may repeat events already counted. What was counted stays as a floor, not as a sum.
   * A session not in the ledger (never counted, or dropped) is left alone: nothing of it is in the figure, so its
   * history read again counts as new events, at most its distinct events. It is not added, so no other session is
   * dropped for it (#605 review, round 2: releasing many sessions in a row no longer cascades).
   */
  release(sessionId: string): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.base = total(s)
    s.reread = 0
    s.live = 0
  }

  /**
   * Runs the panel's replay for a page that just became ready (synchronous) and returns what that page lacks:
   * per session, the events emitted so far minus those the replay re-sent. Null when nothing is lacking.
   * `send` re-sends the page's figure when a history read again lowers it (see `note`).
   */
  snapshotAfterReplay(replay: () => void, send?: (loss: PanelLossSnapshot) => void): PanelLossSnapshot | null {
    const resent = new Map<string, number>()
    this.replayed = resent
    try { replay() } finally { this.replayed = null }
    const evicted = new Map<string, number>()
    for (const [sid, s] of this.sessions) {
      const left = total(s) - (resent.get(sid) ?? 0)
      if (left > 0) evicted.set(sid, left)
    }
    this.page = { evicted, send: send ?? null }
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
    this.replayed = null
    this.page = null
    this.pageUpdateQueued = false
  }

  private touch(sid: string): SessionCount {
    const s = this.sessions.get(sid) ?? { base: 0, reread: 0, live: 0 }
    this.sessions.delete(sid)
    this.sessions.set(sid, s)
    return s
  }

  /** Beyond the cap, the least recently touched sessions leave the figure: never added up elsewhere */
  private drop(): void {
    while (this.sessions.size > Math.max(1, this.maxSessions)) {
      const oldest = this.sessions.keys().next().value as string
      this.sessions.delete(oldest)
    }
  }

  /** A history event read again reached the open page: it stands for at most one event that page lacked */
  private lowerPage(sid: string): void {
    const page = this.page
    if (!page) return
    const n = page.evicted.get(sid)
    if (n === undefined) return
    if (n > 1) page.evicted.set(sid, n - 1)
    else page.evicted.delete(sid)
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
    if (!page || page.evicted.size === 0) return null
    return { evicted: Object.fromEntries(page.evicted) }
  }
}

/** The extension's ledger: it outlives the panels, since a reopened page lacks what earlier pages received */
export const panelLoss = new PanelLossLedger()
