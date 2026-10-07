/**
 * Pure helpers that bound the relay's memory, replay volume and file discovery.
 * No vscode/http dependencies so they are unit-testable.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { AgentEvent } from './protocol'
import {
  RELAY_SESSION_PARAM_MAX_LENGTH, RELAY_MAX_REPLAY_PER_SESSION, RELAY_MAX_REPLAY_TOTAL, RELAY_REPLAY_BATCH_SIZE,
  RELAY_MAX_EVENTS_PER_SESSION, RELAY_MAX_BUFFERED_SESSIONS, RELAY_MAX_BUFFERED_EVENTS_TOTAL,
  RELAY_MAX_PROJECT_DIRS, RELAY_MAX_FILES_PER_DIR, RELAY_MAX_SESSION_FILE_BYTES,
  RELAY_MAX_CLIENT_BACKLOG_BYTES,
  RELAY_REPLAY_LIFECYCLE_RESERVE,
} from './constants'

const SESSION_ID_RE = /^[A-Za-z0-9._:-]+$/

/** Session ids (query parameter, hook payloads, transcript file names): bounded length, safe charset. */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= RELAY_SESSION_PARAM_MAX_LENGTH && SESSION_ID_RE.test(value)
}

export interface SessionParamResult {
  /** True when the URL path is exactly /events */
  isEvents: boolean
  /** Valid session filter, when present */
  session?: string
  /** True when ?session= was present but malformed (caller answers 400) */
  invalid?: boolean
}

/** Parse `/events[?session=<id>]` and validate the session parameter strictly. */
export function parseSessionParam(url: string | undefined): SessionParamResult {
  if (!url) { return { isEvents: false } }
  let parsed: URL
  try { parsed = new URL(url, 'http://localhost') } catch { return { isEvents: false } }
  if (parsed.pathname !== '/events') { return { isEvents: false } }
  const all = parsed.searchParams.getAll('session')
  if (all.length === 0) { return { isEvents: true } }
  if (all.length > 1 || !isValidSessionId(all[0])) { return { isEvents: true, invalid: true } }
  return { isEvents: true, session: all[0] }
}

/** True when the request path (query ignored) is the relay's GET /status endpoint. */
export function isStatusPath(url: string | undefined): boolean {
  if (!url) { return false }
  try { return new URL(url, 'http://localhost').pathname === '/status' } catch { return false }
}

/** True when the URL path is exactly /issue-links (query ignored). */
export function isIssueLinksPath(url: string | undefined): boolean {
  if (!url) { return false }
  try { return new URL(url, 'http://localhost').pathname === '/issue-links' } catch { return false }
}

/** True when a client's unsent backlog is large enough that it should be dropped. */
export function isBackedUp(writableLength: number, limit = RELAY_MAX_CLIENT_BACKLOG_BYTES): boolean {
  return writableLength > limit
}

export interface ReplayLimits { perSession: number; total: number; batchSize: number }
export const DEFAULT_REPLAY_LIMITS: ReplayLimits = {
  perSession: RELAY_MAX_REPLAY_PER_SESSION, total: RELAY_MAX_REPLAY_TOTAL, batchSize: RELAY_REPLAY_BATCH_SIZE,
}

export interface ReplayBatchMsg { type: 'agent-event-batch'; events: AgentEvent[] }

/**
 * Cap replay volume. Each session keeps only its most recent `perSession` events; the
 * overall budget `total` is granted to the LAST sessions first (the primary session is
 * ordered last), so the most relevant data survives. Order is preserved, and large
 * sessions are split into batches of at most `batchSize` events.
 */
export function capReplayBatches(batches: readonly ReplayBatchMsg[], limits: Partial<ReplayLimits> = {}): ReplayBatchMsg[] {
  const { perSession, total, batchSize } = { ...DEFAULT_REPLAY_LIMITS, ...limits }
  let budget = total
  const kept: AgentEvent[][] = []
  for (let i = batches.length - 1; i >= 0 && budget > 0; i--) {
    const events = batches[i].events
    const take = Math.min(events.length, perSession, budget)
    if (take <= 0) { continue }
    // Lifecycle events cut off by the cap are re-added in front (bounded), so the graph still builds
    const head = events.slice(0, events.length - take).filter(e => LIFECYCLE_TYPES.has(e.type)).slice(-RELAY_REPLAY_LIFECYCLE_RESERVE)
    kept.unshift([...head, ...events.slice(events.length - take)])
    budget -= take + head.length
  }
  const out: ReplayBatchMsg[] = []
  for (const events of kept) {
    for (let i = 0; i < events.length; i += batchSize) {
      out.push({ type: 'agent-event-batch', events: events.slice(i, i + batchSize) })
    }
  }
  return out
}

export interface BufferLimits { perSession: number; sessions: number; total: number }
export const DEFAULT_BUFFER_LIMITS: BufferLimits = {
  perSession: RELAY_MAX_EVENTS_PER_SESSION, sessions: RELAY_MAX_BUFFERED_SESSIONS, total: RELAY_MAX_BUFFERED_EVENTS_TOTAL,
}

/** Event types that rebuild the graph on replay: chatter is evicted before these. */
const LIFECYCLE_TYPES = new Set(['agent_spawn', 'subagent_dispatch', 'team_info'])

/** Trim a buffer to `max` events, evicting the oldest non-lifecycle event first. Lifecycle events
 *  are only evicted (oldest first) when they alone exceed RELAY_REPLAY_LIFECYCLE_RESERVE. */
export function trimKeepingLifecycle(buf: AgentEvent[], max: number): void {
  while (buf.length > max) {
    let lifecycle = 0
    let victim = -1
    for (let i = 0; i < buf.length; i++) {
      if (LIFECYCLE_TYPES.has(buf[i].type)) { lifecycle++; continue }
      victim = i
      break
    }
    if (victim < 0 || lifecycle > RELAY_REPLAY_LIFECYCLE_RESERVE) victim = 0
    buf.splice(victim, 1)
  }
}

/**
 * Append an event to a per-session buffer, keeping memory bounded: at most
 * `perSession` events per session, `sessions` sessions (least recently written
 * evicted first) and `total` events overall. `protect` is never evicted.
 */
export function appendBounded(
  buffers: Map<string, AgentEvent[]>,
  sessionId: string,
  event: AgentEvent,
  limits: Partial<BufferLimits> = {},
): void {
  const lim = { ...DEFAULT_BUFFER_LIMITS, ...limits }
  const buf = buffers.get(sessionId) ?? []
  buf.push(event)
  trimKeepingLifecycle(buf, lim.perSession)
  // Re-insert so Map order reflects recency of writes
  buffers.delete(sessionId)
  buffers.set(sessionId, buf)

  let totalEvents = 0
  for (const b of buffers.values()) { totalEvents += b.length }
  while (buffers.size > 1 && (buffers.size > lim.sessions || totalEvents > lim.total)) {
    const oldest = buffers.keys().next().value
    if (oldest === undefined || oldest === sessionId) { break }
    totalEvents -= buffers.get(oldest)?.length ?? 0
    buffers.delete(oldest)
  }
  // A single session may still exceed the total: trim its head
  if (totalEvents > lim.total) { buf.splice(0, Math.min(buf.length - 1, totalEvents - lim.total)) }
}

/** Truthy env/flag values: 1, true, yes, on. */
export function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())
}

export interface DiscoveredSession { sessionId: string; filePath: string; dirPath: string; mtimeMs: number; size: number }

export interface DiscoveryOptions {
  /** Directories (absolute) to scan; each must be a direct child of root */
  dirs: string[]
  maxFilesPerDir?: number
  maxFileBytes?: number
}

/**
 * Safe lookup of Claude Code project directories under `root`.
 * Only real directories (symlinks are skipped) are returned, capped at `maxDirs`.
 * With `encodedWorkspace` only matching dirs (exact or `<encoded>-...` sub-projects) are returned.
 */
export function listProjectDirs(
  root: string,
  match: ((name: string) => boolean) | null,
  maxDirs = RELAY_MAX_PROJECT_DIRS,
): string[] {
  const out: string[] = []
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (out.length >= maxDirs) { break }
    if (!e.isDirectory() || e.isSymbolicLink()) { continue }
    if (match && !match(e.name)) { continue }
    out.push(path.join(root, e.name))
  }
  return out
}

/**
 * List `<dir>/<id>.jsonl` session transcripts. Only regular files (lstat; symlinks are
 * ignored) with a safe id, within the size cap, and at most `maxFilesPerDir` per directory.
 */
export function discoverSessionFiles(opts: DiscoveryOptions): DiscoveredSession[] {
  const maxFiles = opts.maxFilesPerDir ?? RELAY_MAX_FILES_PER_DIR
  const maxBytes = opts.maxFileBytes ?? RELAY_MAX_SESSION_FILE_BYTES
  const out: DiscoveredSession[] = []
  for (const dirPath of opts.dirs) {
    let names: string[]
    try { names = fs.readdirSync(dirPath) } catch { continue }
    let seen = 0
    for (const file of names) {
      if (!file.endsWith('.jsonl')) { continue }
      if (++seen > maxFiles) { break }
      const sessionId = path.basename(file, '.jsonl')
      if (!isValidSessionId(sessionId)) { continue }
      const filePath = path.join(dirPath, file)
      try {
        const st = fs.lstatSync(filePath)
        if (!st.isFile() || st.size > maxBytes) { continue }
        out.push({ sessionId, filePath, dirPath, mtimeMs: st.mtimeMs, size: st.size })
      } catch { /* vanished */ }
    }
  }
  return out
}

/**
 * Rate-limit key for GET /status. Every local client shares the loopback address, so the address
 * alone would let one noisy local process exhaust the budget of the UI. The Origin / User-Agent
 * (capped, untrusted) separates the clients without letting a caller mint unlimited keys cheaply:
 * the limiter still bounds the number of keys.
 */
export function statusRateKey(remoteAddress: string | undefined, headers: Record<string, string | string[] | undefined>): string {
  const pick = (name: string) => {
    const v = headers[name]
    return (Array.isArray(v) ? v[0] : v ?? '').slice(0, 80)
  }
  return `${remoteAddress ?? ''}|${pick('origin')}|${pick('user-agent')}`
}
