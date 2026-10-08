/**
 * Project context of a session (#64): CLAUDE.md, memory index and the issue numbers they cite, loaded
 * from the relay ONLY when the panel opens or the user refreshes. Pure (no React): time and network are
 * injected so the cache and the anti-race rules are testable without timers.
 *
 * Rules: 60 s cache per session; a monotonic token drops any answer that arrives after another
 * session was requested; a failure is shown as a failure (the previous data, if any, is marked stale).
 */
import { createLoadToken } from './reconnect'

/** Mirrors extension/src/project-context.ts (kept separate, like bridge-types). */
export interface ProjectContextFile {
  kind: 'claude-md' | 'memory'
  name: string
  found: boolean
  unreadable?: 'symlink' | 'not-a-file' | 'unreadable'
  text: string
  bytes: number
  truncated: boolean
}

export interface ProjectContextData {
  sessionId: string
  /** Relay clock (ms) at read time */
  loadedAt: number
  files: ProjectContextFile[]
  issues: number[]
}

/** Mirrors RELAY_ISSUE_LINKS_CACHE_TTL_MS (a test compares them) */
export const PROJECT_CONTEXT_TTL_MS = 60_000
/** Sessions kept in the cache (oldest evicted first) */
export const PROJECT_CONTEXT_CACHE_MAX = 20
const MAX_FILES = 8
const MAX_ISSUES = 50

export type ContextState =
  | { status: 'idle'; sessionId: null }
  | { status: 'loading'; sessionId: string; stale?: ProjectContextData }
  | { status: 'ready'; sessionId: string; data: ProjectContextData; fetchedAt: number }
  | { status: 'error'; sessionId: string; message: string; stale?: ProjectContextData }
  /** The relay knows no working directory for this session (or cannot serve it): not an empty context */
  | { status: 'unavailable'; sessionId: string }

// ─── Network ────────────────────────────────────────────────────────────────

/** Validate an untrusted relay payload; null when it does not have the expected shape. */
export function parseProjectContext(raw: unknown): ProjectContextData | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.sessionId !== 'string' || typeof r.loadedAt !== 'number' || !Array.isArray(r.files) || r.files.length > MAX_FILES) return null
  const files: ProjectContextFile[] = []
  for (const f of r.files) {
    if (typeof f !== 'object' || f === null) return null
    const x = f as Record<string, unknown>
    if ((x.kind !== 'claude-md' && x.kind !== 'memory') || typeof x.name !== 'string' || typeof x.found !== 'boolean'
      || typeof x.text !== 'string' || typeof x.bytes !== 'number' || typeof x.truncated !== 'boolean') return null
    if (x.unreadable !== undefined && x.unreadable !== 'symlink' && x.unreadable !== 'not-a-file' && x.unreadable !== 'unreadable') return null
    files.push({ kind: x.kind, name: x.name, found: x.found, ...(x.unreadable ? { unreadable: x.unreadable } : {}), text: x.text, bytes: x.bytes, truncated: x.truncated })
  }
  const issues = (Array.isArray(r.issues) ? r.issues : [])
    .filter((n): n is number => Number.isInteger(n) && (n as number) >= 1)
    .slice(0, MAX_ISSUES)
  return { sessionId: r.sessionId, loadedAt: r.loadedAt, files, issues }
}

/** GET <origin>/context?session=<id>. Resolves 'unavailable' on 404; rejects on any other failure. */
export async function fetchProjectContext(
  origin: string, sessionId: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<ProjectContextData | 'unavailable'> {
  const res = await fetchImpl(`${origin}/context?session=${encodeURIComponent(sessionId)}`, { signal, cache: 'no-store' })
  if (res.status === 404) return 'unavailable'
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const parsed = parseProjectContext(await res.json())
  if (!parsed) throw new Error('Invalid response from the relay')
  return parsed
}

// ─── Loader ─────────────────────────────────────────────────────────────────

export interface ProjectContextLoader {
  getState(): ContextState
  subscribe(listener: () => void): () => void
  /** Load a session's context: from the cache when fresh (and not `force`), else from the relay. Never rejects. */
  load(sessionId: string, opts?: { force?: boolean }): Promise<void>
  /** Back to idle; drops the cache and ignores any answer still in flight. */
  reset(): void
}

export interface ProjectContextLoaderOptions {
  fetchContext: (sessionId: string) => Promise<ProjectContextData | 'unavailable'>
  now?: () => number
  ttlMs?: number
}

export function createProjectContextLoader(opts: ProjectContextLoaderOptions): ProjectContextLoader {
  const now = opts.now ?? Date.now
  const ttl = opts.ttlMs ?? PROJECT_CONTEXT_TTL_MS
  const token = createLoadToken()
  const cache = new Map<string, { data: ProjectContextData; fetchedAt: number }>()
  const inflight = new Map<string, { promise: Promise<void> }>()
  const listeners = new Set<() => void>()
  let state: ContextState = { status: 'idle', sessionId: null }

  const set = (next: ContextState) => { state = next; for (const l of [...listeners]) l() }

  function remember(sessionId: string, data: ProjectContextData, fetchedAt: number) {
    cache.delete(sessionId)
    cache.set(sessionId, { data, fetchedAt })
    while (cache.size > PROJECT_CONTEXT_CACHE_MAX) cache.delete(cache.keys().next().value as string)
  }

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },

    load(sessionId, { force = false } = {}) {
      const cached = cache.get(sessionId)
      if (!force && cached && now() - cached.fetchedAt < ttl) {
        token.next() // a request still in flight for another session must not overwrite this one
        set({ status: 'ready', sessionId, data: cached.data, fetchedAt: cached.fetchedAt })
        return Promise.resolve()
      }
      const running = inflight.get(sessionId)
      if (!force && running && state.sessionId === sessionId) return running.promise

      const mine = token.next()
      set({ status: 'loading', sessionId, ...(cached ? { stale: cached.data } : {}) })
      const entry: { promise: Promise<void> } = { promise: Promise.resolve() }
      entry.promise = opts.fetchContext(sessionId).then(
        result => {
          if (!token.isCurrent(mine)) return
          if (result === 'unavailable') { cache.delete(sessionId); set({ status: 'unavailable', sessionId }); return }
          const fetchedAt = now()
          remember(sessionId, result, fetchedAt)
          set({ status: 'ready', sessionId, data: result, fetchedAt })
        },
        (err: unknown) => {
          if (!token.isCurrent(mine)) return
          const stale = cache.get(sessionId)?.data
          set({ status: 'error', sessionId, message: err instanceof Error ? err.message : String(err), ...(stale ? { stale } : {}) })
        },
      ).finally(() => { if (inflight.get(sessionId) === entry) inflight.delete(sessionId) })
      inflight.set(sessionId, entry)
      return entry.promise
    },

    reset() {
      token.next()
      cache.clear()
      inflight.clear()
      set({ status: 'idle', sessionId: null })
    },
  }
}
