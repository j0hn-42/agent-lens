/**
 * Resilient relay client (#67): backoff schedule, failure counter state machine, load token,
 * session filter, replay dedupe, and the controller that wires them to an EventSource.
 *
 * Polling decision: the relay has no GET endpoint that returns the events (they only flow over
 * SSE, with a replay of its buffer on every connect). After POLL_AFTER_FAILURES consecutive
 * failures the client therefore stops hammering /events and polls the cheap GET /status for
 * reachability every POLL_INTERVAL_MS; as soon as /status answers it tries SSE again. If that
 * SSE attempt fails, the client stays in polling mode (the failure counter is not reset until
 * a stream actually opens).
 */

/** First retry delay, and the floor of the schedule */
export const BACKOFF_BASE_MS = 5_000
/** Ceiling of the retry delay */
export const BACKOFF_MAX_MS = 30_000
/** Consecutive failures after which the client switches to polling */
export const POLL_AFTER_FAILURES = 3
/** Period of the reachability probe while polling */
export const POLL_INTERVAL_MS = 5_000
/** Max extra delay as a fraction of the nominal delay (jitter only ever adds, so the floor holds) */
export const BACKOFF_JITTER_RATIO = 0.2
/** Timeout of one reachability probe */
export const POLL_TIMEOUT_MS = 4_000
/** Replayed events remembered to drop the duplicates a reconnect replays */
export const DEDUPE_CAPACITY = 20_000

// ─── Backoff ──────────────────────────────────────────────────────────────

/**
 * Delay before retry number `attempt` (1-based): 5 s, 10 s, 20 s, 30 s, 30 s...
 * `random` (0..1, injectable) adds up to BACKOFF_JITTER_RATIO of jitter; the result never exceeds the ceiling.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1
  const nominal = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 16))
  const r = Math.min(1, Math.max(0, random()))
  return Math.min(BACKOFF_MAX_MS, Math.round(nominal * (1 + BACKOFF_JITTER_RATIO * r)))
}

// ─── Failure counter state machine ────────────────────────────────────────

export type LinkMode = 'sse' | 'polling'
export interface LinkState { mode: LinkMode; failures: number }
export type LinkEvent = 'open' | 'error' | 'probe-failed'

export const INITIAL_LINK_STATE: LinkState = { mode: 'sse', failures: 0 }

export function nextLinkState(state: LinkState, event: LinkEvent): LinkState {
  if (event === 'open') return INITIAL_LINK_STATE
  const failures = state.failures + 1
  // A failed probe keeps the mode; an SSE failure may tip it into polling. Polling is sticky until 'open'.
  const mode: LinkMode = state.mode === 'polling' || failures >= POLL_AFTER_FAILURES ? 'polling' : 'sse'
  return { mode, failures }
}

/** UI detail while the link is down, e.g. "reconnecting (attempt 2, retry in 10s)" */
export function reconnectDetail(attempt: number, delayMs: number): string {
  return `reconnecting (attempt ${attempt}, retry in ${Math.ceil(delayMs / 1000)}s)`
}

// ─── Load token ───────────────────────────────────────────────────────────

export interface LoadToken {
  /** Invalidate every earlier token and return the new one */
  next(): number
  isCurrent(token: number): boolean
}

export function createLoadToken(): LoadToken {
  let current = 0
  return { next: () => ++current, isCurrent: t => t === current }
}

// ─── Session filter and dedupe ────────────────────────────────────────────

/** Session an inbound relay message belongs to, if it names one (untrusted data) */
export function messageSessionIds(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) return []
  const d = data as Record<string, unknown>
  const ids: string[] = []
  const add = (v: unknown) => { if (typeof v === 'string') ids.push(v) }
  const evt = (v: unknown) => { if (typeof v === 'object' && v !== null) add((v as Record<string, unknown>).sessionId) }
  switch (d.type) {
    case 'agent-event': evt(d.event); break
    case 'agent-event-batch': if (Array.isArray(d.events)) d.events.forEach(evt); break
    case 'session-started': if (typeof d.session === 'object' && d.session !== null) add((d.session as Record<string, unknown>).id); break
    case 'session-ended': case 'session-updated': add(d.sessionId); break
  }
  return ids
}

/**
 * Drop what belongs to another session than the requested one. Messages naming no session
 * (connection status, list) pass; a batch is filtered event by event. Returns null to drop.
 */
export function filterForSession(data: unknown, requested: string | null | undefined): unknown | null {
  if (!requested) return data
  if (typeof data !== 'object' || data === null) return data
  const d = data as Record<string, unknown>
  if (d.type === 'agent-event-batch' && Array.isArray(d.events)) {
    const kept = d.events.filter(e => messageSessionIds({ type: 'agent-event', event: e }).every(id => id === requested))
    return kept.length === 0 ? null : { ...d, events: kept }
  }
  if (d.type === 'session-list' && Array.isArray(d.sessions)) return data
  return messageSessionIds(data).every(id => id === requested) ? data : null
}

/** Remembers recent events; `seen` reports whether an identical one went through already. */
export function createEventDedupe(capacity = DEDUPE_CAPACITY) {
  const keys = new Set<string>()
  return {
    /** Records the event and returns true if it was already recorded */
    seen(event: unknown): boolean {
      let key: string
      try { key = JSON.stringify(event) } catch { return false }
      if (keys.has(key)) return true
      keys.add(key)
      if (keys.size > capacity) keys.delete(keys.values().next().value as string)
      return false
    },
    get size() { return keys.size },
  }
}

// ─── Controller ───────────────────────────────────────────────────────────

export interface SourceStatus {
  /** 'connected' once a stream is open; 'disconnected' while down; 'connecting' for the first attempt */
  status: 'connected' | 'disconnected' | 'connecting'
  mode: LinkMode
  /** Consecutive failures so far (0 when connected) */
  attempt: number
  /** "reconnecting (attempt N, retry in Xs)" while down, else null */
  detail: string | null
}

export interface EventSourceLike {
  onopen: ((e: unknown) => void) | null
  onmessage: ((e: { data: string }) => void) | null
  onerror: ((e: unknown) => void) | null
  close(): void
}

export interface ReconnectingSourceOptions {
  url: string
  statusUrl: string
  /** When set, only events of this session are delivered */
  sessionId?: string | null
  loadToken: LoadToken
  onMessage: (data: unknown) => void
  onStatus: (s: SourceStatus) => void
  onParseError?: () => void
  createEventSource: (url: string) => EventSourceLike
  fetchStatus: (url: string, signal: AbortSignal) => Promise<{ ok: boolean }>
  random?: () => number
}

export function createReconnectingSource(opts: ReconnectingSourceOptions) {
  const { loadToken } = opts
  const random = opts.random ?? Math.random
  let token = loadToken.next()
  let state = INITIAL_LINK_STATE
  let es: EventSourceLike | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let abort: AbortController | null = null
  let hasConnected = false
  const dedupe = createEventDedupe()
  const alive = () => loadToken.isCurrent(token)

  const emit = (status: SourceStatus['status'], delay?: number) =>
    opts.onStatus({
      status, mode: state.mode, attempt: state.failures,
      detail: status === 'disconnected' && delay !== undefined ? reconnectDetail(state.failures, delay) : null,
    })

  const clear = () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (abort) { abort.abort(); abort = null }
    if (es) { es.onopen = es.onmessage = es.onerror = null; es.close(); es = null }
  }

  const fail = (event: 'error' | 'probe-failed') => {
    state = nextLinkState(state, event)
    const delay = state.mode === 'polling' ? POLL_INTERVAL_MS : backoffDelay(state.failures, random)
    emit('disconnected', delay)
    timer = setTimeout(() => { timer = null; if (alive()) (state.mode === 'polling' ? probe : connect)() }, delay)
  }

  const probe = () => {
    abort = new AbortController()
    const mine = abort
    const kill = setTimeout(() => mine.abort(), POLL_TIMEOUT_MS)
    opts.fetchStatus(opts.statusUrl, mine.signal).then(
      res => { clearTimeout(kill); if (!alive()) return; abort = null; res.ok ? connect() : fail('probe-failed') },
      () => { clearTimeout(kill); if (!alive()) return; abort = null; fail('probe-failed') },
    )
  }

  const connect = () => {
    const src = opts.createEventSource(opts.url)
    es = src
    src.onopen = () => {
      if (!alive() || es !== src) return
      const reconnected = hasConnected
      hasConnected = true
      state = nextLinkState(state, 'open')
      // The relay replays its buffer on every connect: remember what was delivered, drop repeats afterwards
      replaying = reconnected
      emit('connected')
    }
    src.onmessage = e => {
      if (!alive() || es !== src) return
      let data: unknown
      try { data = JSON.parse(e.data) } catch { opts.onParseError?.(); return }
      const kept = filterForSession(data, opts.sessionId)
      if (kept === null) return
      deliver(kept)
    }
    src.onerror = () => {
      if (!alive() || es !== src) return
      src.onopen = src.onmessage = src.onerror = null
      src.close()
      es = null
      fail('error')
    }
  }

  let replaying = false
  const deliver = (data: unknown) => {
    const d = data as Record<string, unknown> | null
    if (d && d.type === 'agent-event') {
      if (dedupe.seen(d.event) && replaying) return
    } else if (d && d.type === 'agent-event-batch' && Array.isArray(d.events)) {
      const fresh = d.events.filter(ev => !(dedupe.seen(ev) && replaying))
      if (fresh.length === 0) return
      data = { ...d, events: fresh }
    }
    opts.onMessage(data)
  }

  emit('connecting')
  connect()

  return {
    /** Stop everything: timers, in-flight probe and stream. Late callbacks are ignored. */
    close() {
      // Only invalidate if still the live source: a newer one owns the shared token
      if (alive()) token = loadToken.next()
      clear()
    },
  }
}
