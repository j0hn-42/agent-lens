/**
 * Which model each session runs, learned from its events: the main agent's model (reported by
 * agent_spawn or model_detected), else the latest model any of its agents reported. Pure (no React).
 */

import { isPseudoModel } from './model-provenance'

const MAX_SESSIONS = 200
const MAX_AGENTS_PER_SESSION = 100
const MAX_MODEL_LEN = 120

interface Entry {
  mainAgent?: string
  /** agent name -> last model reported (insertion order = report order) */
  models: Map<string, string>
}

export interface ModelEventLike {
  type: string
  payload: Record<string, unknown>
  sessionId?: string
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_MODEL_LEN) : undefined
}

function modelStr(v: unknown): string | undefined {
  const s = str(v)
  return s && !isPseudoModel(s) ? s : undefined
}

export class SessionModelTracker {
  private entries = new Map<string, Entry>()

  /** Feed one event; true when the resolved model of its session changed. */
  ingest(event: ModelEventLike): boolean {
    const sessionId = event.sessionId
    if (!sessionId) return false
    if (event.type !== 'agent_spawn' && event.type !== 'model_detected') return false
    const agent = str(event.payload.agent) ?? str(event.payload.name)
    if (!agent) return false
    const model = modelStr(event.payload.model)
    const isMainSpawn = event.type === 'agent_spawn' && event.payload.isMain === true
    if (!model && !isMainSpawn) return false

    const before = this.modelOf(sessionId)
    let entry = this.entries.get(sessionId)
    if (!entry) {
      entry = { models: new Map() }
      this.entries.set(sessionId, entry)
      if (this.entries.size > MAX_SESSIONS) {
        const oldest = this.entries.keys().next().value
        if (oldest !== undefined) this.entries.delete(oldest)
      }
    }
    if (isMainSpawn) entry.mainAgent = agent
    if (model) {
      entry.models.delete(agent)
      entry.models.set(agent, model)
      if (entry.models.size > MAX_AGENTS_PER_SESSION) {
        const oldest = entry.models.keys().next().value
        if (oldest !== undefined && oldest !== entry.mainAgent) entry.models.delete(oldest)
      }
    }
    return this.modelOf(sessionId) !== before
  }

  modelOf(sessionId: string): string | undefined {
    const entry = this.entries.get(sessionId)
    if (!entry) return undefined
    if (entry.mainAgent) {
      const main = entry.models.get(entry.mainAgent)
      if (main) return main
    }
    let last: string | undefined
    for (const m of entry.models.values()) last = m
    return last
  }

  /** Snapshot of the resolved model per session. */
  snapshot(): Map<string, string> {
    const out = new Map<string, string>()
    for (const id of this.entries.keys()) {
      const m = this.modelOf(id)
      if (m) out.set(id, m)
    }
    return out
  }

  clear(): void {
    this.entries.clear()
  }
}

// ─── Observation (issue #52) ────────────────────────────────────────────────

/** Sessions beyond this many are forgotten (oldest first) so the set stays bounded. */
export const MAX_OBSERVED_SESSIONS = 500

/** Short visible status of a session that is listed but never heard from. */
export const SESSION_NOT_OBSERVED_TEXT = 'listed - activity not observed'
/** Accessible explanation of that status. */
export const SESSION_NOT_OBSERVED_HELP =
  'Found on disk, but no event has been received for this session since the app started, so whether it is idle or working is unknown.'

/** Visible status of a session that only the session index lists: nothing says it was detected, or whether it is live. */
export const SESSION_INDEXED_TEXT = 'indexed - not observed'
export const SESSION_INDEXED_HELP =
  'Listed by the session index only. This app has not detected the session and the index does not say whether it is finished or still running.'

/** Sessions the app really watches: the entries listed only from the session index are left out. */
export function detectedSessions<T extends { indexedOnly?: boolean }>(sessions: ReadonlyArray<T>): T[] {
  return sessions.filter(s => !s.indexedOnly)
}

export type SessionObservation = 'observed' | 'not-observed'

/** Ids of the sessions for which at least one event was received in this app run. */
export class ObservedSessionsTracker {
  private ids = new Set<string>()
  private listeners = new Set<() => void>()
  private version = 0

  /** Record that an event was received for the session; true when it was new. */
  mark(sessionId: unknown): boolean {
    if (typeof sessionId !== 'string' || !sessionId) return false
    if (this.ids.has(sessionId)) {
      // Still receiving events: refresh its recency so the FIFO eviction drops quieter sessions first
      this.ids.delete(sessionId)
      this.ids.add(sessionId)
      return false
    }
    this.ids.add(sessionId)
    if (this.ids.size > MAX_OBSERVED_SESSIONS) {
      const oldest = this.ids.values().next().value
      if (oldest !== undefined) this.ids.delete(oldest)
    }
    this.version++
    for (const l of [...this.listeners]) l()
    return true
  }

  has = (sessionId: string): boolean => this.ids.has(sessionId)
  getVersion = (): number => this.version
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  clear(): void {
    this.ids.clear()
    this.version++
    for (const l of [...this.listeners]) l()
  }
}

/** The app-wide tracker, fed by the simulation with every event it receives. */
export const observedSessions = new ObservedSessionsTracker()

/**
 * A session is "not observed" when the disk lists it as active but no event was ever received for it
 * in this run and no live hook flag (background activity) is set. Completed sessions are a fact read
 * from disk and stay as they are.
 */
export function deriveSessionObservation(
  session: { id: string; status: 'active' | 'completed' },
  isObserved: (sessionId: string) => boolean,
  hasLiveFlag = false,
): SessionObservation {
  if (session.status !== 'active') return 'observed'
  return hasLiveFlag || isObserved(session.id) ? 'observed' : 'not-observed'
}

/** True when the session is heard from (or not an active one), per the app-wide tracker by default. */
export function isSessionObserved(
  session: { id: string; status: 'active' | 'completed' },
  hasLiveFlag = false,
  isObservedId: (sessionId: string) => boolean = observedSessions.has,
): boolean {
  return deriveSessionObservation(session, isObservedId, hasLiveFlag) === 'observed'
}

/** Number of listed sessions whose activity is not observed (shown in the top bar and announced). */
export function countUnobservedSessions(
  sessions: ReadonlyArray<{ id: string; status: 'active' | 'completed' }>,
  hasLiveFlag: (sessionId: string) => boolean = () => false,
  isObservedId: (sessionId: string) => boolean = observedSessions.has,
): number {
  let n = 0
  for (const s of sessions) if (!isSessionObserved(s, hasLiveFlag(s.id), isObservedId)) n++
  return n
}
