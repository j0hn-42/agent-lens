/**
 * Pure helpers that bound the relay's memory, replay volume and file discovery.
 * No vscode/http dependencies so they are unit-testable.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { AgentEvent } from './protocol'
import { listSubagentTranscripts } from './fs-utils'
import { newestTranscriptMtime } from './discovery-activity'
import {
  RELAY_SESSION_PARAM_MAX_LENGTH, RELAY_MAX_REPLAY_PER_SESSION, RELAY_MAX_REPLAY_TOTAL, RELAY_REPLAY_BATCH_SIZE,
  RELAY_MAX_EVENTS_PER_SESSION, RELAY_MAX_BUFFERED_SESSIONS, RELAY_MAX_BUFFERED_EVENTS_TOTAL,
  RELAY_MAX_PROJECT_DIRS, RELAY_MAX_FILES_PER_DIR, RELAY_MAX_SESSION_FILE_BYTES,
  RELAY_MAX_CLIENT_BACKLOG_BYTES,
  RELAY_REPLAY_LIFECYCLE_RESERVE, COLD_RESCAN_CYCLES, DEFAULT_DEV_PORT,
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

/** True when the request path (query ignored) is the relay's GET /statusline endpoint (#236). */
export function isStatusLinePath(url: string | undefined): boolean {
  if (!url) { return false }
  try { return new URL(url, 'http://localhost').pathname === '/statusline' } catch { return false }
}

/** Which observations route a request path (query ignored) is: the action itself, its schema, or neither. */
export function observationsRoute(url: string | undefined): 'observations' | 'schema' | null {
  if (!url) { return null }
  try {
    const p = new URL(url, 'http://localhost').pathname
    return p === '/observations' ? 'observations' : p === '/observations/schema' ? 'schema' : null
  } catch { return null }
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
export function capReplayBatches(
  batches: readonly ReplayBatchMsg[],
  limits: Partial<ReplayLimits> = {},
  /** Receives, per session, the events the cap left out of the replay (#366). */
  dropped?: Map<string, number>,
  /** Receives the events the cap left out themselves (#366): a reconnecting client is told those it never received */
  onDrop?: (events: readonly AgentEvent[]) => void,
): ReplayBatchMsg[] {
  const { perSession, total, batchSize } = { ...DEFAULT_REPLAY_LIMITS, ...limits }
  let budget = total
  const kept: AgentEvent[][] = []
  let i = batches.length - 1
  for (; i >= 0 && budget > 0; i--) {
    const events = batches[i].events
    const take = Math.min(events.length, perSession, budget)
    if (take <= 0) { countEvicted(dropped, events, events.length); onDrop?.(events); continue }
    // Lifecycle events cut off by the cap are re-added in front (bounded), so the graph still builds
    const cut = events.slice(0, events.length - take)
    const head = [
      ...cut.filter(e => LIFECYCLE_TYPES.has(e.type)).slice(-RELAY_REPLAY_LIFECYCLE_RESERVE),
      ...cut.filter(e => e.type === ACTIVITY_TYPE).slice(-RELAY_REPLAY_LIFECYCLE_RESERVE),
    ]
    kept.unshift([...head, ...events.slice(events.length - take)])
    budget -= take + head.length
    // `head` is a subset of `cut` (no linear includes per event): only what is not re-added is lost
    countEvicted(dropped, cut, cut.length - head.length)
    if (onDrop && cut.length > head.length) {
      const readded = new Set(head)
      onDrop(cut.filter(e => !readded.has(e)))
    }
  }
  // Batches never reached because the total budget ran out
  for (; i >= 0; i--) { countEvicted(dropped, batches[i].events, batches[i].events.length); onDrop?.(batches[i].events) }
  const out: ReplayBatchMsg[] = []
  for (const events of kept) {
    for (let i = 0; i < events.length; i += batchSize) {
      out.push({ type: 'agent-event-batch', events: events.slice(i, i + batchSize) })
    }
  }
  return out
}

/** Credit `n` of the events of a batch to their session (a batch holds one session; the first event names it). */
function countEvicted(counter: Map<string, number> | undefined, events: readonly AgentEvent[], n: number): void {
  if (!counter || n <= 0) return
  const sid = events.find(e => typeof e.sessionId === 'string')?.sessionId
  if (typeof sid !== 'string') return
  counter.set(sid, Math.min((counter.get(sid) ?? 0) + n, Number.MAX_SAFE_INTEGER))
}

/**
 * Events the relay buffer let go of (#366). Bounded like the buffer itself: at most `sessions` session
 * entries (the least recently touched are folded into `other`), so the map and the `event-loss`
 * message stay small however many sessions pass through a long-running relay.
 * It counts events the relay can no longer REPLAY, since it started. It does not say what a given
 * client is missing: a client that stayed connected already received them live.
 */
export interface EvictedTally { bySession: Map<string, number>; other: number }
export function createEvictedTally(): EvictedTally { return { bySession: new Map(), other: 0 } }

export function addEvicted(tally: EvictedTally, sessionId: string, n: number, maxSessions: number = RELAY_MAX_BUFFERED_SESSIONS): void {
  if (n <= 0) return
  const next = Math.min((tally.bySession.get(sessionId) ?? 0) + n, Number.MAX_SAFE_INTEGER)
  tally.bySession.delete(sessionId)
  tally.bySession.set(sessionId, next)
  while (tally.bySession.size > Math.max(1, maxSessions)) {
    const oldest = tally.bySession.keys().next().value as string
    tally.other = Math.min(tally.other + (tally.bySession.get(oldest) ?? 0), Number.MAX_SAFE_INTEGER)
    tally.bySession.delete(oldest)
  }
}

/**
 * Numbers (`seq`, see the relay) of the events the buffer let go of, per session (#366), so that a client that
 * reconnects and says the last number it received (`since`) can be told how many events numbered after it it will
 * never receive. Bounded: at most RELAY_EVICTION_LOG_PER_SESSION numbers per session (the LOWEST are forgotten first:
 * a reconnecting client asks about recent ones) and `sessions` sessions (the least recently touched forgotten). What is
 * forgotten is not counted, so the count stays a lower bound.
 */
export interface EvictionLog { bySession: Map<string, number[]> }
export const RELAY_EVICTION_LOG_PER_SESSION = 4096
export function createEvictionLog(): EvictionLog { return { bySession: new Map() } }

export function logEvicted(
  log: EvictionLog, sessionId: string, seqs: Iterable<number>,
  perSession: number = RELAY_EVICTION_LOG_PER_SESSION, maxSessions: number = RELAY_MAX_BUFFERED_SESSIONS,
): void {
  const list = log.bySession.get(sessionId) ?? []
  let added = false
  for (const n of seqs) if (Number.isSafeInteger(n) && n > 0) { list.push(n); added = true }
  if (!added) return
  // Trimmed in bulk (amortised): up to twice the bound, then sorted and cut back to the newest numbers
  if (list.length > perSession * 2) {
    list.sort((a, b) => a - b)
    list.splice(0, list.length - perSession)
  }
  log.bySession.delete(sessionId)
  log.bySession.set(sessionId, list)
  while (log.bySession.size > Math.max(1, maxSessions)) log.bySession.delete(log.bySession.keys().next().value as string)
}

/** Evicted events of a session numbered after `since` (that a client which received up to `since` never got). */
export function evictedAfter(log: EvictionLog, sessionId: string, since: number): number {
  const list = log.bySession.get(sessionId)
  if (!list) return 0
  let n = 0
  for (const seq of list) if (seq > since) n++
  return n
}

/** `?since=<instance>.<seq>`: what a reconnecting client last received from this relay process. */
export interface SinceParam { instance: string; seq: number }
const SINCE_PATTERN = /^([0-9a-f]{8,64})\.(\d{1,16})$/

/** The `since` parameter of an /events request; null when absent, repeated or malformed (then nothing is counted). */
export function parseSinceParam(url: string | undefined): SinceParam | null {
  if (!url) return null
  let parsed: URL
  try { parsed = new URL(url, 'http://localhost') } catch { return null }
  if (parsed.pathname !== '/events') return null
  const all = parsed.searchParams.getAll('since')
  if (all.length !== 1) return null
  const m = SINCE_PATTERN.exec(all[0])
  if (!m) return null
  const seq = Number(m[2])
  return Number.isSafeInteger(seq) ? { instance: m[1], seq } : null
}

export interface BufferLimits { perSession: number; sessions: number; total: number }
export const DEFAULT_BUFFER_LIMITS: BufferLimits = {
  perSession: RELAY_MAX_EVENTS_PER_SESSION, sessions: RELAY_MAX_BUFFERED_SESSIONS, total: RELAY_MAX_BUFFERED_EVENTS_TOTAL,
}

/** Event types that rebuild the graph on replay: chatter is evicted before these. */
const LIFECYCLE_TYPES = new Set(['agent_spawn', 'subagent_dispatch', 'team_info'])

/** Replayed after the lifecycle events, but never counted against their reserve: only the LATEST one
 *  per agent is kept (see appendBounded), so a long run cannot push spawns / team_info out (#79). */
const ACTIVITY_TYPE = 'agent_activity'

function agentNameOf(e: AgentEvent): unknown {
  return (e.payload as { name?: unknown } | undefined)?.name
}

/**
 * Context readings superseded at the same instant (#567). A context_update is an absolute reading (the web sets the
 * agent's context from it, it never adds it up), and a tool call emits up to three of them in a row. In the replay
 * buffer, an earlier reading of the same agent is REPLACED by a later one (removed, the later one stays at its own
 * place) only when no view can tell the difference:
 * - same stream time: a review scrub (seekToTime) reaches both readings or neither;
 * - only tool / message / context events since the earlier one: none of them changes which agent a reading lands on
 *   (spawn, dispatch, completion, team, model or compaction events end the candidacy);
 * - the later reading sets everything the earlier one set: a figure at least as large (a window an earlier reading
 *   grew stays grown), a breakdown, a window when the earlier one carried one, and the same provenance.
 * A replaced reading is not a lost event (the state it leads to is the same), so it is never counted in the loss.
 * Readings of different instants are all kept: the review scrubber shows each of them.
 */
const CONTEXT_TYPE = 'context_update'
const CONTEXT_NEUTRAL_TYPES = new Set(['tool_call_start', 'tool_call_end', 'message', CONTEXT_TYPE])
/** How far back the earlier reading is looked for (it is a few events back; past this, it is simply kept). */
const CONTEXT_SCAN_LIMIT = 64
/** Agents with a candidate reading, per buffer; past this, the candidates are forgotten (readings are then kept). */
const CONTEXT_MAX_CANDIDATES = 256
/** The latest reading of each agent that a later one may still replace, per session buffer. A candidate may already have
 *  left its buffer (trim): it is not pruned, the map is bounded (256 per buffer). */
const contextCandidates = new WeakMap<AgentEvent[], Map<string, AgentEvent>>()

const isReading = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const hasWindow = (p: Record<string, unknown>) => typeof p.tokensMax === 'number' && p.tokensMax > 0
const hasBreakdown = (v: unknown) => typeof v === 'object' && v !== null && 'systemPrompt' in v

/** True when `next` leaves nothing of `prev` visible (see above). */
function supersedes(next: AgentEvent, prev: AgentEvent): boolean {
  const p = prev.payload ?? {}, n = next.payload ?? {}
  if (prev.time !== next.time || prev.imported !== next.imported || prev.replayed !== next.replayed) return false
  if (!isReading(n.tokens) || n.tokens < (isReading(p.tokens) ? p.tokens : 0)) return false
  return hasBreakdown(n.breakdown) && (hasWindow(n) || !hasWindow(p))
}

/** Remove from `buf` the earlier reading `next` supersedes, if any; record `next` as the agent's candidate. Bounded work. */
function replaceSupersededReading(buf: AgentEvent[], event: AgentEvent): void {
  if (!CONTEXT_NEUTRAL_TYPES.has(event.type)) { contextCandidates.delete(buf); return }
  if (event.type !== CONTEXT_TYPE) return
  const agent = event.payload?.agent
  if (typeof agent !== 'string') return
  let candidates = contextCandidates.get(buf)
  if (!candidates || candidates.size >= CONTEXT_MAX_CANDIDATES) { candidates = new Map(); contextCandidates.set(buf, candidates) }
  const prev = candidates.get(agent)
  if (prev && supersedes(event, prev)) {
    for (let i = buf.length - 1; i >= Math.max(0, buf.length - CONTEXT_SCAN_LIMIT); i--) {
      if (buf[i] === prev) { buf.splice(i, 1); break }
    }
  }
  candidates.set(agent, event)
}

/** Trim a buffer to `max` events, evicting the oldest non-lifecycle event first. Lifecycle events
 *  are only evicted (oldest first) when they alone exceed RELAY_REPLAY_LIFECYCLE_RESERVE. */
export function trimKeepingLifecycle(buf: AgentEvent[], max: number, out?: AgentEvent[]): number {
  let removed = 0
  while (buf.length > max) {
    let lifecycle = 0
    let victim = -1
    for (let i = 0; i < buf.length; i++) {
      if (LIFECYCLE_TYPES.has(buf[i].type)) { lifecycle++; continue }
      if (buf[i].type === ACTIVITY_TYPE) continue
      victim = i
      break
    }
    if (victim < 0 || lifecycle > RELAY_REPLAY_LIFECYCLE_RESERVE) victim = 0
    const [gone] = buf.splice(victim, 1)
    if (out) out.push(gone)
    removed++
  }
  return removed
}

/**
 * Append an event to a per-session buffer, keeping memory bounded: at most
 * `perSession` events per session, `sessions` sessions (least recently written
 * evicted first) and `total` events overall. `protect` is never evicted.
 * Only the latest agent_activity per agent is kept, and a context_update superseded at the same instant is
 * replaced (#567, see supersedes): neither is counted in `evicted`, the state they lead to is the same.
 */
export function appendBounded(
  buffers: Map<string, AgentEvent[]>,
  sessionId: string,
  event: AgentEvent,
  limits: Partial<BufferLimits> = {},
  /** Events the buffer let go of (#366): what a replay can no longer show. Bounded, see EvictedTally. */
  evicted?: EvictedTally,
  /** Receives the events the buffer let go of, with their session (#366, see EvictionLog); not replaced readings */
  onEvict?: (sessionId: string, events: readonly AgentEvent[]) => void,
): void {
  const lim = { ...DEFAULT_BUFFER_LIMITS, ...limits }
  const buf = buffers.get(sessionId) ?? []
  replaceSupersededReading(buf, event)
  const previous = event.type === ACTIVITY_TYPE ? buf.findIndex(e => e.type === ACTIVITY_TYPE && agentNameOf(e) === agentNameOf(event)) : -1
  // Only the latest activity per (session, agent) is replayed: replace in place, it stays after the spawn
  if (previous >= 0) buf[previous] = event
  else buf.push(event)
  const gone: AgentEvent[] | undefined = onEvict ? [] : undefined
  const trimmed = trimKeepingLifecycle(buf, lim.perSession, gone)
  if (evicted) addEvicted(evicted, sessionId, trimmed, lim.sessions)
  if (onEvict && gone && gone.length > 0) onEvict(sessionId, gone)
  // Re-insert so Map order reflects recency of writes
  buffers.delete(sessionId)
  buffers.set(sessionId, buf)

  let totalEvents = 0
  for (const b of buffers.values()) { totalEvents += b.length }
  while (buffers.size > 1 && (buffers.size > lim.sessions || totalEvents > lim.total)) {
    const oldest = buffers.keys().next().value
    if (oldest === undefined || oldest === sessionId) { break }
    const lostEvents = buffers.get(oldest) ?? []
    const lost = lostEvents.length
    totalEvents -= lost
    if (evicted) addEvicted(evicted, oldest, lost, lim.sessions)
    if (onEvict && lost > 0) onEvict(oldest, lostEvents)
    buffers.delete(oldest)
  }
  // A single session may still exceed the total: trim its head
  if (totalEvents > lim.total) {
    const cut = Math.min(buf.length - 1, totalEvents - lim.total)
    const head = buf.splice(0, cut)
    if (evicted) addEvicted(evicted, sessionId, cut, lim.sessions)
    if (onEvict && head.length > 0) onEvict(sessionId, head)
  }
}

/** Truthy env/flag values: 1, true, yes, on. */
export function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())
}

/** True when the request path (query ignored) is exactly /scope: the run-time scope of the relay (#291). */
export function isScopePath(url: string | undefined): boolean {
  if (!url) { return false }
  try { return new URL(url, 'http://localhost').pathname === '/scope' } catch { return false }
}

/** True when the request path (query ignored) is exactly /quota: the subscription quota posted by the status line (#467). */
export function isQuotaPath(url: string | undefined): boolean {
  if (!url) { return false }
  try { return new URL(url, 'http://localhost').pathname === '/quota' } catch { return false }
}

/** True for `/launch` and `/launch/<id>/stop` (#229): the routes that start and stop an agent process. <id> is 16 lower-case hex digits. */
export function isLaunchPath(url: string | undefined): boolean {
  if (!url) { return false }
  try { return /^\/launch(?:\/[0-9a-f]{16}\/stop)?$/.test(new URL(url, 'http://localhost').pathname) } catch { return false }
}

export interface DiscoveredSession { sessionId: string; filePath: string; dirPath: string; mtimeMs: number; size: number }

export interface DiscoveryOptions {
  /** Directories (absolute) to scan; each must be a direct child of root */
  dirs: string[]
  maxFilesPerDir?: number
  maxFileBytes?: number
  /** Fichiers écartés (au-delà du plafond, trop gros, non réguliers) : pas de lstat avant COLD_RESCAN_CYCLES cycles */
  cold?: ColdScan
  /** Appelé pour chaque transcript écarté par un plafond (taille, nombre par dossier), pour l'afficher et non le taire (#291).
   *  Pas rappelé pour un fichier déjà mis au froid : l'appelant garde sa propre liste. */
  onSkipped?: (reason: 'sizeLimit' | 'fileLimit', f: { sessionId: string; filePath: string }) => void
}

/** État de scan froid du relais : `cycle` est incrémenté par l'appelant à chaque scan. */
export interface ColdScan { cycle: number; until: Map<string, number> }
export function createColdScan(): ColdScan { return { cycle: 0, until: new Map() } }

/** mtime of the most recent `.jsonl` directly in `dir` (0 when none or unreadable). Regular files only. */
function newestTranscriptMs(dir: string): number {
  let newest = 0
  let files: string[]
  try { files = fs.readdirSync(dir) } catch { return 0 }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue
    try {
      const st = fs.lstatSync(path.join(dir, f))
      if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs
    } catch { /* vanished */ }
  }
  return newest
}

/**
 * Safe lookup of Claude Code project directories under `root`.
 * Only real directories (symlinks are skipped) are returned, at most `maxDirs`. Within the cap they are sorted
 * by name; past it, the ones with the most recent transcript are kept (ties by name), so a workspace that sorts late
 * is not hidden behind hundreds of old worktree folders. `report.truncated` says whether another
 * eligible directory was left out (#291): the cap is shown, not silent.
 * With `match` only matching dirs (exact or `<encoded>-...` sub-projects) are returned.
 */
export function listProjectDirs(
  root: string,
  match: ((name: string) => boolean) | null,
  maxDirs = RELAY_MAX_PROJECT_DIRS,
  report?: { truncated: boolean },
): string[] {
  const out: string[] = []
  if (report) { report.truncated = false }
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  const names = entries
    .filter(e => e.isDirectory() && !e.isSymbolicLink() && (!match || match(e.name)))
    .map(e => e.name)
    .sort()
  if (names.length > maxDirs) {
    const newest = new Map(names.map(n => [n, newestTranscriptMs(path.join(root, n))]))
    // Stable sort: equal activity keeps the by-name order
    names.sort((a, b) => (newest.get(b) ?? 0) - (newest.get(a) ?? 0))
  }
  for (const name of names) {
    if (out.length >= maxDirs) { if (report) { report.truncated = true } break }
    out.push(path.join(root, name))
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
  if (opts.cold) { for (const [f, until] of opts.cold.until) { if (until <= opts.cold.cycle) { opts.cold.until.delete(f) } } }
  for (const dirPath of opts.dirs) {
    let names: string[]
    try { names = fs.readdirSync(dirPath) } catch { continue }
    // Le plafond s'applique après le tri par date : l'ordre de readdir n'est pas chronologique
    const found: DiscoveredSession[] = []
    const cold = opts.cold
    for (const file of names) {
      if (!file.endsWith('.jsonl')) { continue }
      const sessionId = path.basename(file, '.jsonl')
      if (!isValidSessionId(sessionId)) { continue }
      const filePath = path.join(dirPath, file)
      if (cold && (cold.until.get(filePath) ?? 0) > cold.cycle) { continue }
      try {
        const st = fs.lstatSync(filePath)
        if (st.isFile() && st.size > maxBytes) opts.onSkipped?.('sizeLimit', { sessionId, filePath })
        if (!st.isFile() || st.size > maxBytes) { cold?.until.set(filePath, cold.cycle + COLD_RESCAN_CYCLES); continue }
        found.push({ sessionId, filePath, dirPath, mtimeMs: st.mtimeMs, size: st.size })
      } catch { /* vanished */ }
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const f of found.slice(0, maxFiles)) { out.push(f) }
    // Au-delà du plafond : écartés et mis au froid, pas de lstat à chaque cycle
    for (const f of found.slice(maxFiles)) {
      opts.onSkipped?.('fileLimit', f)
      cold?.until.set(f.filePath, cold.cycle + COLD_RESCAN_CYCLES)
    }
  }
  return out
}

/** Sort un transcript du froid (événement de watch). Vrai s'il était froid. */
export function wakeColdFile(cold: ColdScan, filePath: string): boolean {
  return cold.until.delete(filePath)
}

/** Sort `<dirPath>/<sessionId>.jsonl` du froid. */
export function wakeColdSession(cold: ColdScan, dirPath: string, sessionId: string): boolean {
  return wakeColdFile(cold, path.join(dirPath, `${sessionId}.jsonl`))
}

/**
 * Admission dans un ensemble borné de surveillances (dossiers subagents des sessions froides). Plein, il
 * garde les sessions les plus récentes : sinon les premières sessions inactives vues (souvent très
 * anciennes) occuperaient les places pour toute la vie du relais et une session devenue inactive plus tard
 * n'aurait jamais de réveil par son dossier subagents.
 */
export function admitWatchSlot(
  slots: ReadonlyMap<string, { mtimeMs: number }>, max: number, mtimeMs: number,
): { admit: boolean; evict?: string } {
  if (slots.size < max) return { admit: true }
  let oldest: string | undefined
  let oldestMtime = Infinity
  for (const [key, s] of slots) { if (s.mtimeMs < oldestMtime) { oldestMtime = s.mtimeMs; oldest = key } }
  return oldest !== undefined && mtimeMs > oldestMtime ? { admit: true, evict: oldest } : { admit: false }
}

export interface ActiveSessionsOptions extends DiscoveryOptions {
  /** Au-delà de cet âge (s), le transcript principal est jugé inactif : on regarde ses sous-agents */
  activeAgeS: number
  now?: () => number
  /** Sessions déjà suivies : ignorées sans examen des sous-agents */
  skip?: (sessionId: string) => boolean
  /** Appelé quand une session est jugée inactive (et mise au froid) */
  onIdle?: (s: DiscoveredSession) => void
}

export interface ActiveSessionCandidate { sessionId: string; filePath: string; newestMtime: number }

/**
 * Sessions récemment actives parmi les transcripts découverts (fichier principal ou sous-agents,
 * dont ceux du Workflow tool). Une session jugée inactive est mise au froid COLD_RESCAN_CYCLES
 * cycles : ni lstat ni readdir de ses sous-agents tant qu'un événement de watch (wakeColdFile)
 * ne la réveille pas (#211).
 */
export function findActiveSessions(opts: ActiveSessionsOptions): ActiveSessionCandidate[] {
  const now = opts.now ?? Date.now
  const out: ActiveSessionCandidate[] = []
  for (const f of discoverSessionFiles(opts)) {
    if (opts.skip?.(f.sessionId)) { continue }
    let newestMtime = f.mtimeMs
    if ((now() - newestMtime) / 1000 > opts.activeAgeS) {
      // Fichier principal inactif : un sous-agent peut encore tourner (agents du Workflow tool compris)
      newestMtime = newestTranscriptMtime(
        listSubagentTranscripts(path.join(f.dirPath, f.sessionId, 'subagents')), newestMtime, now() - opts.activeAgeS * 1000,
      )
    }
    if ((now() - newestMtime) / 1000 <= opts.activeAgeS) {
      opts.cold?.until.delete(f.filePath)
      out.push({ sessionId: f.sessionId, filePath: f.filePath, newestMtime })
    } else if (opts.cold) {
      opts.cold.until.set(f.filePath, opts.cold.cycle + COLD_RESCAN_CYCLES)
      opts.onIdle?.(f)
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

/** True when the request path (query ignored) is the relay's GET /context endpoint (project context, #64). */
export function isContextPath(url: string | undefined): boolean {
  if (!url) { return false }
  try { return new URL(url, 'http://localhost').pathname === '/context' } catch { return false }
}

/**
 * True when a browser-issued request comes from another site (#102): Sec-Fetch-Site cross-site, or an Origin
 * that is neither the relay's own (standalone app) nor a dev web origin. Requests carrying neither header
 * (curl, MCP clients) are not browser-driven and pass.
 */
export function isCrossOriginRequest(headers: { origin?: string | string[]; 'sec-fetch-site'?: string | string[]; host?: string }, host: string | undefined): boolean {
  const origin = headers.origin
  // Sans Origin (fetch no-cors, iframe) : seul Sec-Fetch-Site peut trahir un appel d'un autre site.
  // Avec Origin : on décide d'après lui seul. L'UI de dev (localhost:3000 -> 127.0.0.1) est cross-site
  // pour le navigateur mais son Origin est autorisé.
  if (origin === undefined) return headers['sec-fetch-site'] === 'cross-site'
  if (typeof origin !== 'string') return true
  if (host !== undefined && origin === `http://${host}`) return false
  return !isDevWebOrigin(origin)
}

/** Ports of the dev web server allowed to call the relay: AGENT_LENS_WEB_PORT (comma list), default 3000. */
function devWebPorts(env: Record<string, string | undefined>): number[] {
  const ports = (env.AGENT_LENS_WEB_PORT ?? '').split(',')
    .map(p => p.trim())
    .filter(p => /^\d{1,5}$/.test(p))
    .map(Number)
    .filter(p => p >= 1 && p <= 65535)
  return ports.length > 0 ? ports.slice(0, 5) : [DEFAULT_DEV_PORT]
}

/**
 * True when `origin` is the dev web server (#201): http on localhost or 127.0.0.1 and one of the configured
 * ports only. Any other local port (another app, Jupyter, a compromised dev server) is refused.
 */
export function isDevWebOrigin(origin: string, env: Record<string, string | undefined> = process.env): boolean {
  const m = /^http:\/\/(?:localhost|127\.0\.0\.1):(\d{1,5})$/.exec(origin)
  return m !== null && devWebPorts(env).includes(Number(m[1]))
}
