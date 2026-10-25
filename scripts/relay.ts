/**
 * Shared relay module — receives agent events and streams them to SSE clients.
 * Used by both the dev relay server and the standalone app.
 */
import * as http from 'http'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { HookServer } from '../extension/src/hook-server'
import { AgentEvent, RelayStatus, SessionInfo, WatchedSession, type TranscriptEntry } from '../extension/src/protocol'
import { ClaudeSessionPipeline, listedStartTimes } from '../extension/src/claude-session-pipeline'
import { safeWatch, readLinesChunked, runGuarded, newestSessionMtime } from '../extension/src/fs-utils'
import { scanSubagentsDir, markTeammatesDone } from '../extension/src/subagent-watcher'
import { filterOrchestratorCompletion } from '../extension/src/orchestrator-completion'
import { TeamWatcher, completeSessionHeader, readSessionHeader, type TeamSessionTags } from '../extension/src/team-watcher'
import { projectTags, branchTag } from '../extension/src/project-identity'
import { CodexSessionWatcher } from '../extension/src/codex-session-watcher'
import { CopilotSessionWatcher } from '../extension/src/copilot-session-watcher'
import { PiSessionWatcher } from '../extension/src/pi-session-watcher'
import { GeminiSessionWatcher } from '../extension/src/gemini-session-watcher'
import { OpenCodeSessionWatcher } from '../extension/src/opencode-session-watcher'
import { lifecycleTags } from '../extension/src/session-runtime'
import { readSessionIndex, mergeIndexedSessions, withIndexedFacts, filterIndexedByWorkspace, type IndexOpener, type SessionIndexResult } from '../extension/src/session-index'
import {
  SCAN_INTERVAL_MS, RUNTIME_RELEASE_INTERVAL_MS, ACTIVE_SESSION_AGE_S, SESSION_ID_DISPLAY, ORCHESTRATOR_NAME,
  HOOK_SERVER_NOT_STARTED, WORKSPACE_HASH_LENGTH,
  RELAY_MAX_SSE_CLIENTS, RELAY_MAX_REMOTE_SSE_CLIENTS, RELAY_SSE_HEARTBEAT_MS, RELAY_MAX_WATCHED_SESSIONS, RELAY_MAX_SESSION_FILE_BYTES, RELAY_MAX_IMPORTED_SESSIONS,
  RELAY_STATUS_RATE_BURST, RELAY_STATUS_RATE_PER_S, RELAY_STATUS_RATE_MAX_KEYS, RELAY_SSE_RATE_BURST, RELAY_SSE_RATE_PER_S,
  RELAY_ISSUE_LINKS_RATE_BURST, RELAY_ISSUE_LINKS_RATE_PER_S, RELAY_ISSUE_LINKS_CACHE_TTL_MS, RELAY_ISSUE_LINKS_CACHE_MAX_ROLES,
  RELAY_ISSUE_LINKS_MAX_GH_IN_FLIGHT, RELAY_ISSUE_LINKS_MAX_PROBES_PER_WINDOW, RELAY_ISSUE_LINKS_PROBE_WINDOW_MS,
  RELAY_SESSION_INDEX_CACHE_MS, SESSION_TAG_MAX, RELAY_CONTEXT_RATE_BURST, RELAY_CONTEXT_RATE_PER_S,
  RELAY_SCOPE_RATE_BURST, RELAY_LAUNCH_RATE_BURST, RELAY_LAUNCH_RATE_PER_S, RELAY_SCOPE_RATE_PER_S, RELAY_MAX_PROJECT_DIRS, RELAY_MAX_FILES_PER_DIR,
  RELAY_QUOTA_RATE_BURST, RELAY_QUOTA_RATE_PER_S, RELAY_REPLAY_BATCH_SIZE, RELAY_MAX_PACED_BACKLOG_BYTES, WATCH_SCAN_DEBOUNCE_MS,
} from '../extension/src/constants'
import { claudeConfigDir, claudeProjectsDir, claudeTeamsDir, discoveryDir } from '../extension/src/claude-config-dir'
import { purgeStaleDiscoveryFiles } from '../extension/src/discovery-purge'
import { colorEnabled, colorizeLog } from './log-color'
import { setLogLevel, createLogger } from '../extension/src/logger'
import { CONTROL_ALL } from '../extension/src/control-chars'
import { buildReplayBatches } from '../extension/src/event-replay'
import {
  parseSessionParam, isBackedUp, capReplayBatches, appendBounded, createEvictedTally, isTruthyFlag, statusRateKey,
  createEvictionLog, logEvicted, evictedAfter, parseSinceParam,
  listProjectDirs, findActiveSessions, wakeColdFile, admitWatchSlot, createColdScan, isValidSessionId, observationsRoute, isCrossOriginRequest,
} from '../extension/src/relay-guards'
import { isLoopbackAddress, KeyedRateLimiter } from '../extension/src/hook-guards'
import { isHooksConfigured, isDisable1MContext } from '../extension/src/claude-settings'
import { projectDirMatcher, encodeProjectDirName, PROJECT_DIR_NAME_MAX } from '../extension/src/project-dir'
import { createObservationsAction, AgentStateTracker } from '../extension/src/observations'
import { fetchIssueLinks, resolveRepoUrl, createRepoUrlCache, defaultExec, type IssueLink } from '../extension/src/issue-links'
import { parseRepoAllowlist, resolveBudgetUsd, LAUNCH_CAPS } from '../extension/src/launch-policy'
import type { LaunchView } from '../extension/src/protocol'
import { fetchSessionWork, type SessionWork } from '../extension/src/session-work'
import { EventReconciler, type EventSource } from '../extension/src/event-source-priority'
import { parseImportPaths, resolveImportedTranscripts, transcriptTimeRange } from '../extension/src/imported-transcripts'
import { createProjectWatchScan } from './project-watch-scan'
import { applySecurityHeaders, KeyedCoalescer, SharedTicker } from './server-hardening'
import { nodeIo, sampleSystem, type CpuCounters } from './system-stats'
import type { TelemetryClient } from './telemetry'
import { createIssueLinksRoute } from './routes/issue-links'
import { createStatusRoute, type StatusSnapshot } from './routes/status'
import { createContextRoute } from './routes/context'
import { parseWebhookDestinations, parseWebhookEvents, createWebhookDispatcher, type WebhookDispatcher, type WebhookEventType, type WebhookStats } from './webhooks'
import { createObservationsRoute } from './routes/observations'
import { createStatusLineRoute } from './routes/statusline'
import { createScopeRoute, type RelayScope } from './routes/scope'
import { createQuotaRoute } from './routes/quota'
import { createQuotaStore } from './quota'
import { createLaunchRoute, createLaunchDisabledRoute, newLaunchToken } from './routes/launch'
import { createLaunchSupervisor, type Journal, type KillGroupFn, type SpawnFn, type LaunchSupervisor } from './launch-supervisor'
import { createFileJournal } from './launch-journal'
import { requestHostClass, isRemoteCrossOrigin, parseAllowedHosts, remoteRateKey, bindRemoteAuth, isRemotePaired } from './remote-access'
import { createRemotePairing, writeTokenFile, type RemotePairing } from './remote-pairing'

/** Period of the machine health sample (#357) */
const SYSTEM_INTERVAL_MS = 2_000

const DISCOVERY_DIR = discoveryDir()
const CLAUDE_DIR = claudeProjectsDir()
const TEAMS_DIR = claudeTeamsDir()

let relayCreated = false
let verbose = false
let sessionEventCount = 0
/** Webhooks (#236): null without destinations. Only live events of watched Claude sessions are notified. */
let webhooks: WebhookDispatcher | null = null
/** > 0 while a transcript history is read: its events are replayed, not live (the reconciler marks them `replayed`, #361), and never notified */
let historyDepth = 0
function withHistory<T>(load: () => T): T {
  historyDepth++
  try { return reconciler.withHistory(load) } finally { historyDepth-- }
}
/** Distinct model IDs seen across all watched sessions during this relay session.
 *  Populated from `model_detected` events (emitted by both the Claude transcript
 *  parser and the Codex rollout parser). Read at session_end for telemetry. */
const observedModels = new Set<string>()

// agent-lens-app version. Inlined by esbuild at bundle time via `define`.
// In dev (running from source via tsx), falls back to reading app/package.json.
declare const AGENT_LENS_APP_VERSION: string | undefined
function resolveAgentLensVersion(): string {
  try {
    if (typeof AGENT_LENS_APP_VERSION === 'string' && AGENT_LENS_APP_VERSION) {
      return AGENT_LENS_APP_VERSION
    }
  } catch { /* ReferenceError in unbundled dev — fall through */ }
  try {
    const pkgPath = path.join(__dirname, '..', 'app', 'package.json')
    if (fs.existsSync(pkgPath)) {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0'
    }
  } catch { /* ignore */ }
  return '0.0.0'
}

const useColor = colorEnabled(process.env, Boolean(process.stdout.isTTY))

function log(...args: unknown[]) {
  if (!verbose) return
  // Only a leading string carries the [tag]; other args (errors, ids) stay as they are.
  if (typeof args[0] === 'string') args[0] = colorizeLog(args[0], useColor)
  console.log(...args)
}

/** Shown without --verbose: what the user must know (a session Agent Lens stopped following). */
const relayLog = createLogger('Relay')

/** Transcript size past which a session is no longer followed (injectable for tests). */
let maxSessionFileBytes = RELAY_MAX_SESSION_FILE_BYTES

/**
 * Sessions the relay does not follow, by reason, for GET /status (#208): watch limit reached when
 * the session was found, or transcript grown past the size cap. Distinct ids, bounded.
 */
const SKIPPED_SESSIONS_MAX = 1000
/** Ceiling of a runtimeLosses count on /status (#420): the largest count the web page accepts. */
const RUNTIME_LOSS_MAX = 1e9
const skippedSessions = { watchLimit: new Set<string>(), sizeLimit: new Set<string>(), fileLimit: new Set<string>() }
/** More project folders than RELAY_MAX_PROJECT_DIRS exist in the scanned scope: the others are not scanned (#291) */
let projectDirsCapped = false

/** Records a skipped session; true the first time it is recorded for that reason. */
function noteSkipped(reason: keyof typeof skippedSessions, sessionId: string): boolean {
  const set = skippedSessions[reason]
  if (set.has(sessionId)) return false
  if (set.size >= SKIPPED_SESSIONS_MAX) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
  set.add(sessionId)
  return true
}

// ─── SSE client management ──────────────────────────────────────────────────

const sseClients = new Set<http.ServerResponse>()
/** SSE clients accepted and waiting for the attaches in progress to end before they join (#651): they count toward the cap */
let pendingSseClients = 0
/** Of those, the ones that came through an allowed tunnel Host (#241): they count toward the remote cap too */
let pendingRemoteSseClients = 0
/** The same waiting clients, to close them when the relay is disposed: they must not join a dead relay (#613) */
const waitingSseClients = new Set<http.ServerResponse>()
/** Clients that came through an allowed tunnel Host (#241): counted among sseClients, capped separately. */
const remoteSseClients = new WeakSet<http.ServerResponse>()

function remoteSseCount(): number {
  let n = 0
  for (const res of sseClients) if (remoteSseClients.has(res)) n++
  return n
}

/** Drop a client: remove it from the set and destroy its connection (frees its buffers/listeners). */
function dropClient(res: http.ServerResponse) {
  sseClients.delete(res)
  clientSessionFilter.delete(res)
  outboxes.delete(res)
  try { res.destroy() } catch { /* already closed */ }
}

/**
 * Messages written at the pace of a client's socket: its connect replay (issue #203), then the histories read while
 * it is connected (#652). Each one waits for 'drain' before the next, so live messages broadcast meanwhile are queued
 * behind them and sent after, in order, instead of overtaking older replayed events. Bounded: a client whose held live
 * messages exceed the slow-client limit is dropped, and so is one whose paced backlog exceeds
 * RELAY_MAX_PACED_BACKLOG_BYTES (it never reads).
 */
interface Outbox { items: Array<{ payload: string; live: boolean }>; next: number; liveBytes: number; pacedBytes: number }
const outboxes = new WeakMap<http.ServerResponse, Outbox>()

/** Live write path (broadcasts): queued behind the client's paced messages, otherwise written with the slow-client check. */
function writeLive(res: http.ServerResponse, payload: string) {
  const box = outboxes.get(res)
  if (!box) return writeToClient(res, payload)
  box.items.push({ payload, live: true })
  box.liveBytes += payload.length
  if (isBackedUp(box.liveBytes)) {
    log('[sse] Dropping client: live backlog overflowed during replay')
    dropClient(res)
  }
}

/** Queue messages written as the client drains (see Outbox); the first ones are written now when nothing is queued. */
function writePaced(res: http.ServerResponse, payloads: readonly string[]) {
  if (payloads.length === 0) return
  let box = outboxes.get(res)
  const idle = box === undefined
  if (!box) { box = { items: [], next: 0, liveBytes: 0, pacedBytes: 0 }; outboxes.set(res, box) }
  for (const payload of payloads) { box.items.push({ payload, live: false }); box.pacedBytes += payload.length }
  if (isBackedUp(box.pacedBytes, RELAY_MAX_PACED_BACKLOG_BYTES)) {
    log('[sse] Dropping client: paced backlog overflowed')
    dropClient(res)
    return
  }
  if (idle) void pumpOutbox(res, box)
}

async function pumpOutbox(res: http.ServerResponse, box: Outbox) {
  while (box.next < box.items.length) {
    if (res.destroyed || outboxes.get(res) !== box) return
    const item = box.items[box.next]
    box.items[box.next++] = { payload: '', live: item.live }
    if (item.live) box.liveBytes -= item.payload.length
    else box.pacedBytes -= item.payload.length
    writeToClient(res, item.payload)
    if (res.writableNeedDrain && !res.destroyed) {
      await new Promise<void>(resolve => {
        const done = () => { res.off('drain', done); res.off('close', done); resolve() }
        res.once('drain', done)
        res.once('close', done)
      })
    }
    // Written ones are let go of in bulk (amortised), not one shift per message
    if (box.next > 1024 && box.next * 2 > box.items.length) { box.items.splice(0, box.next); box.next = 0 }
  }
  if (outboxes.get(res) === box) outboxes.delete(res)
}

/** Write one SSE message; drops the client when it is gone or too slow (res.writableLength backlog). */
function writeToClient(res: http.ServerResponse, payload: string) {
  if (res.destroyed || res.writableEnded || isBackedUp(res.writableLength)) {
    log('[sse] Dropping slow or closed client')
    dropClient(res)
    return
  }
  try { res.write(`data: ${payload}\n\n`) } catch { dropClient(res) }
}

const HEARTBEAT_PAYLOAD = JSON.stringify({ type: 'heartbeat' })

function sendSSE(res: http.ServerResponse, data: unknown) {
  writeToClient(res, JSON.stringify(data))
}

/** Clients that connected with /events?session=<id> only receive that session's events. */
const clientSessionFilter = new WeakMap<http.ServerResponse, string>()

function broadcast(data: string, sessionId?: string) {
  // A history read before this message reaches the clients before it (#652)
  flushHistory()
  for (const res of [...sseClients]) {
    const only = clientSessionFilter.get(res)
    if (only && sessionId && only !== sessionId) continue
    writeLive(res, data)
  }
}

/** Local clients only: what a launch is doing is not for a tunnel Host (#241 keeps /launch off the remote surface). */
function broadcastLocal(data: string) {
  flushHistory()
  for (const res of [...sseClients]) if (!remoteSseClients.has(res)) writeLive(res, data)
}

// ─── Event buffering ────────────────────────────────────────────────────────

const eventBuffer = new Map<string, AgentEvent[]>()
/** Events the buffer let go of (#366), bounded: the replay is then partial and must not read as complete. */
const evictedCounts = createEvictedTally()
/**
 * Events a reconnecting client missed (#366). Every delivered event gets a number (`seq`, increasing for the life of
 * this relay process, named by `relayInstance`); live events carry it, and each connection starts with a `relay-cursor`
 * (instance, last number delivered). A client back with `?since=<instance>.<seq>` is told, per session, how many events
 * numbered after it the buffer evicted (evictionLog) or the replay cap leaves out: a lower bound of what it never got.
 */
let relayInstance = crypto.randomBytes(8).toString('hex')
let eventSeq = 0
const eventSeqs = new WeakMap<AgentEvent, number>()
const evictionLog = createEvictionLog()
const seqsOf = (events: readonly AgentEvent[]) => events.map(e => eventSeqs.get(e) ?? 0)
const logBufferEviction = (sessionId: string, events: readonly AgentEvent[]) => {
  logEvicted(evictionLog, sessionId, seqsOf(events))
  // Evicted before it was sent: no connected client got it (#652)
  for (const e of events) if (historyPendingSet.has(e)) historyUnsent.set(sessionId, Math.min((historyUnsent.get(sessionId) ?? 0) + 1, Number.MAX_SAFE_INTEGER))
}
/**
 * History read from transcripts (#652): the replayed events a history load delivered, not sent yet. They go to the
 * clients once the load's synchronous run is over (or before anything broadcast after it), the buffer cap applied
 * first: the ones still in the buffer, in `agent-event-batch` messages per session, written at each client's pace.
 */
const historyPending = new Map<string, AgentEvent[]>()
const historyPendingSet = new Set<AgentEvent>()
/** Of those, per session, the events the buffer let go of before they were sent: lost for every connected client */
const historyUnsent = new Map<string, number>()
let historyFlushQueued = false
/** The loss figure each client was last given (event-loss), to which what it never received is added (#652) */
const clientLoss = new WeakMap<http.ServerResponse, { evicted: Record<string, number>; otherEvents: number }>()

function queueHistory(sessionId: string, event: AgentEvent) {
  let list = historyPending.get(sessionId)
  if (!list) { list = []; historyPending.set(sessionId, list) }
  list.push(event)
  historyPendingSet.add(event)
  if (historyFlushQueued) return
  historyFlushQueued = true
  queueMicrotask(flushHistory)
}

/** Send the pending history (see historyPending): batches, then what the cap let go of (event-loss), then a cursor. */
function flushHistory() {
  historyFlushQueued = false
  if (historyPending.size === 0 && historyUnsent.size === 0) return
  const pending = [...historyPending]
  const unsent = [...historyUnsent]
  historyPending.clear()
  historyPendingSet.clear()
  historyUnsent.clear()
  const batches = new Map<string, string[]>()
  for (const [sid, events] of pending) {
    const buf = eventBuffer.get(sid)
    if (!buf) continue
    // An activity replaced in place or a superseded reading is not sent, nor lost (see appendBounded)
    const kept = new Set(buf)
    const out = events.filter(e => kept.has(e))
    const list: string[] = []
    for (let i = 0; i < out.length; i += RELAY_REPLAY_BATCH_SIZE) {
      list.push(JSON.stringify({ type: 'agent-event-batch', events: out.slice(i, i + RELAY_REPLAY_BATCH_SIZE) }))
    }
    if (list.length > 0) batches.set(sid, list)
  }
  // Every event numbered up to here is now sent (above or before) or counted lost (below)
  const cursor = JSON.stringify({ type: 'relay-cursor', instance: relayInstance, seq: eventSeq })
  for (const res of [...sseClients]) {
    const only = clientSessionFilter.get(res)
    const items: string[] = []
    for (const [sid, list] of batches) if (!only || only === sid) items.push(...list)
    const gap: Record<string, number> = {}
    for (const [sid, n] of unsent) if (n > 0 && (!only || only === sid)) gap[sid] = n
    if (Object.keys(gap).length > 0) {
      // The figure of a first connection (replaced by the page) and the gap of a reconnected one (added by it)
      const figure = clientLoss.get(res) ?? { evicted: {}, otherEvents: 0 }
      const evicted = { ...figure.evicted }
      for (const [sid, n] of Object.entries(gap)) evicted[sid] = Math.min((evicted[sid] ?? 0) + n, Number.MAX_SAFE_INTEGER)
      clientLoss.set(res, { evicted, otherEvents: figure.otherEvents })
      items.push(JSON.stringify({ type: 'event-loss', evicted, ...(figure.otherEvents > 0 ? { otherEvents: figure.otherEvents } : {}), gap }))
    }
    if (items.length === 0) continue
    items.push(cursor)
    writePaced(res, items)
  }
}
/** Agent states for /observations: fed on every event, not subject to the replay buffer's eviction */
const agentTracker = new AgentStateTracker()

/**
 * Single entry point for every event, whatever its source. Events go through the reconciler
 * (extension/src/event-source-priority.ts): held while a session history loads, deduplicated
 * across hooks and JSONL, then delivered by deliverEvent.
 */
function broadcastEvent(event: AgentEvent, source: EventSource = 'jsonl') {
  reconciler.submit(event, { source })
}

const reconciler = new EventReconciler({ deliver: (event) => deliverEvent(event) })

function deliverEvent(delivered: AgentEvent) {
  // Every event of an imported transcript carries its provenance to the clients (#294)
  const event = delivered.sessionId && importedSessions.has(delivered.sessionId) ? { ...delivered, imported: true } : delivered
  sessionEventCount++
  if (event.type === 'model_detected') {
    const m = (event.payload as { model?: unknown } | undefined)?.model
    if (typeof m === 'string' && m.length > 0) observedModels.add(m)
  }
  const sid = event.sessionId?.slice(0, SESSION_ID_DISPLAY) || '?'
  log(`[event] ${event.type} (session ${sid})`)

  // History (#652): sent in batches once the load is over, after the buffer cap; live events one by one, after it.
  // The history read before a live event goes out before it, with a cursor taken BEFORE this event is numbered: its
  // agent-event is queued after that cursor, so a page resuming from the cursor still gets it (or counts it lost).
  const live = !(event.sessionId && event.replayed === true)
  if (live) flushHistory()
  const seq = ++eventSeq
  eventSeqs.set(event, seq)
  if (event.sessionId) {
    // Bounded per session, in number of sessions and in total events (see relay-guards.ts)
    appendBounded(eventBuffer, event.sessionId, event, {}, evictedCounts, logBufferEviction)
    agentTracker.ingest(event)
  }

  if (!live) queueHistory(event.sessionId!, event)
  else broadcast(JSON.stringify({ type: 'agent-event', event, seq }), event.sessionId)

  // Webhooks: a replayed history or an imported session is not something that just happened. During a Claude attach
  // (#651) only the history copies are `replayed`: a hook pushed meanwhile for that session is live and notified
  if (webhooks && historyDepth === 0 && !event.imported && !event.replayed && event.sessionId && sessions.has(event.sessionId)) webhooks.notify(event)
}

/** Untrusted text shown as a session tag: single line, no controls, capped. */
function tagText(value: string | undefined): string | undefined {
  if (!value) return undefined
  const clean = value.replace(CONTROL_ALL, ' ').trim().slice(0, SESSION_TAG_MAX)
  return clean || undefined
}

/** Tags of a watcher's lifecycle (runtime, cwd...): untrusted text like the other session fields, bounded the same way (#420). */
export function boundedTags(tags: Partial<SessionInfo>): Partial<SessionInfo> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(tags)) {
    const text = typeof value === 'string' ? tagText(value) : undefined
    if (text) out[key] = text
  }
  return out as Partial<SessionInfo>
}

/**
 * Sessions read once from an imported transcript (#294): when they were read and the time range the file
 * records. Never followed live, never 'active', never matched to a local project.
 */
const importedSessions = new Map<string, { importedAt: number; first?: number; last?: number }>()

/** Working directory of each watched Claude session (read once from its transcript head). */
const sessionCwd = new Map<string, string>()
/** Git branch of each watched Claude session, as recorded at the head of its transcript. */
const sessionBranch = new Map<string, string>()
let relayWorkspace = ''
let teamWatcher: TeamWatcher | null = null

/** Session list entry with team/runtime/workspace tags (all optional, all untrusted-capped). */
function toSessionInfo(session: WatchedSession): SessionInfo {
  const tags = teamWatcher?.getSessionTags(session.sessionId)
  const cwd = tagText(sessionCwd.get(session.sessionId))
  const imported = importedSessions.get(session.sessionId)
  if (imported) {
    // Times come from the file itself; the end of the session is not proven, so it is listed as not active
    const start = imported.first ?? imported.importedAt
    return {
      id: session.sessionId, label: session.label,
      status: 'completed', imported: true, importedAt: imported.importedAt,
      startTime: start, lastActivityTime: imported.last ?? start,
      ...(imported.last === undefined ? { lastActivityUnknown: true } : {}),
      runtime: 'claude',
      ...(cwd ? { cwd } : {}),
      ...branchTag(sessionBranch.get(session.sessionId)),
    }
  }
  const workspace = tagText(relayWorkspace)
  return {
    id: session.sessionId, label: session.label,
    status: session.sessionCompleted ? 'completed' : 'active',
    ...listedStartTimes(session), lastActivityTime: session.lastActivityTime,
    runtime: 'claude',
    ...(tags ? { teamName: tags.teamName, ...(tags.memberName ? { memberName: tags.memberName } : {}) } : {}),
    ...(workspace ? { workspace } : {}),
    ...(cwd ? { cwd } : {}),
    ...projectTags(sessionCwd.get(session.sessionId)),
    ...branchTag(sessionBranch.get(session.sessionId)),
  }
}

/** Set by createRelay when launching is enabled (#229): tells the supervisor that a transcript of this session id was seen. */
let launchSessionSeen: ((sessionId: string) => void) | null = null
/** Set by createRelay when launching is enabled: the launches a newly connected LOCAL client is told about. */
let launchSnapshot: (() => LaunchView[]) | null = null
/** Kills every launched child (SIGKILL). Also called by the crash handler: the children are detached and would outlive the relay. */
let launchKillAll: (() => void) | null = null

/** Adds the facts of the session index (declared parent, cwd) to a session entry; set up by createRelay. */
let enrichSession: (info: SessionInfo) => SessionInfo = info => info

/** `tags`: the runtime and directory a watcher puts on its lifecycle event, for a session the relay does not hold itself (#420). */
function broadcastSessionLifecycle(type: 'started' | 'ended' | 'updated', sessionId: string, label: string, tags: Partial<SessionInfo> = {}) {
  if (type === 'started') {
    launchSessionSeen?.(sessionId)
    const live = sessions.get(sessionId)
    if (live && importedSessions.has(sessionId)) {
      broadcast(JSON.stringify({ type: 'session-started', session: enrichSession(toSessionInfo(live)) }), sessionId)
      return
    }
    // A watched session keeps its own last activity (the file's mtime at attach, now on a resume): announcing it
    // is not activity (#365)
    const base: SessionInfo = live
      ? toSessionInfo(live)
      : { ...boundedTags(tags), id: sessionId, label, status: 'active', startTime: Date.now(), lastActivityTime: Date.now(), startTimeWatched: true }
    broadcast(JSON.stringify({
      type: 'session-started',
      session: enrichSession({ ...base, label, status: 'active' } as SessionInfo),
    }), sessionId)
  } else if (type === 'ended') {
    broadcast(JSON.stringify({ type: 'session-ended', sessionId }), sessionId)
  } else if (type === 'updated') {
    const tags = teamWatcher?.getSessionTags(sessionId)
    // The place of a watched session (an imported one is never matched to a local project, see toSessionInfo)
    const cwd = importedSessions.has(sessionId) ? '' : tagText(sessionCwd.get(sessionId))
    broadcast(JSON.stringify({
      type: 'session-updated', sessionId, label,
      ...(tags ? { teamName: tags.teamName, ...(tags.memberName ? { memberName: tags.memberName } : {}) } : {}),
      ...(cwd ? { cwd, ...projectTags(sessionCwd.get(sessionId)), ...branchTag(sessionBranch.get(sessionId)) } : {}),
    }), sessionId)
  }
}

function onSessionTags(sessionId: string, _tags: TeamSessionTags | null) {
  const session = sessions.get(sessionId)
  if (session) broadcastSessionLifecycle('updated', sessionId, session.label)
}

// ─── Session watcher ────────────────────────────────────────────────────────

const sessions = new Map<string, WatchedSession>()

/**
 * Tracking of a transcript (attach, reads, activity and end, context_update): the same code as the extension's
 * SessionWatcher (extension/src/claude-session-pipeline.ts, #218). The relay plugs in its reconciler,
 * its lifecycle tags, its size cap and its error guard.
 */
const pipeline = new ClaudeSessionPipeline({
  sessions,
  submit: (event) => broadcastEvent(event),
  fireLifecycle: broadcastSessionLifecycle,
  withHistory,
  // A history read over several ticks (a Claude attach, #651) holds only its session's events; its transcript
  // copies come out marked `replayed`, which keeps them away from the webhooks (deliverEvent)
  withSessionHistory: (sessionId, load) => reconciler.withSessionHistory(sessionId, load),
  // An imported transcript is not live: no activity is inferred from reading it, and no end either
  isLive: (sessionId) => !importedSessions.has(sessionId),
  // An exception here would reach uncaughtException and stop the relay for every client (#206)
  guard: (fn, sessionId) => runGuarded(fn, (err) => detachSessionOnError(sessionId, err)),
  maxFileBytes: () => maxSessionFileBytes,
  // A session found before its first entry with a cwd: its project is learnt now and the clients told
  onTranscriptLines: (sessionId, lines) => {
    const session = sessions.get(sessionId)
    if (session && completeSessionHeader(sessionId, lines, sessionCwd, sessionBranch)) broadcastSessionLifecycle('updated', sessionId, session.label)
  },
  // The size cap is also enforced after discovery: a transcript that grows past it is dropped.
  // Clients are told (session-ended), otherwise they keep showing it active and frozen (#208).
  onOversize: (sessionId) => {
    const session = sessions.get(sessionId)
    relayLog.warn(`Session ${sessionId.slice(0, SESSION_ID_DISPLAY)} exceeds ${maxSessionFileBytes} bytes — no longer watched`)
    noteSkipped('sizeLimit', sessionId)
    if (session) broadcastSessionLifecycle('ended', sessionId, session.label)
    dropSession(sessionId)
  },
  log: (message) => log(`[session] ${message}`),
})
const parser = pipeline.parser
const watcherDelegate = pipeline.delegate

/** Stop all watchers/timers of a session and forget it. */
function dropSession(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return
  // Watchers, timers and per-session parser state (registries, link/dedupe sets)
  pipeline.release(session)
  // Team bookkeeping and relay-side tags
  sessionCwd.delete(sessionId)
  sessionBranch.delete(sessionId)
  importedSessions.delete(sessionId)
  reconciler.forgetSession(sessionId)
  sessions.delete(sessionId)
  teamWatcher?.forgetSession(sessionId)
}

/** A watcher or poll callback of the session threw: log it, stop watching, tell the clients (#206). */
function detachSessionOnError(sessionId: string, err: unknown) {
  const session = sessions.get(sessionId)
  console.error(`[session] ${sessionId.slice(0, SESSION_ID_DISPLAY)} read failed, no longer watched:`, err)
  if (!session) return
  const announced = session.sessionDetected
  dropSession(sessionId)
  if (announced) broadcastSessionLifecycle('ended', sessionId, session.label)
}

/**
 * Make room for one more watched session. Only sessions idle for longer than the discovery window are
 * evicted, ended or silent: nothing is announced, a transcript that grows again is rediscovered; returns false when full.
 */
function ensureWatchCapacity(): boolean {
  // Imported sessions hold no watcher: they neither count against the live budget nor get evicted
  const liveCount = () => sessions.size - importedSessions.size
  if (liveCount() < RELAY_MAX_WATCHED_SESSIONS) return true
  let victim: WatchedSession | undefined
  for (const s of sessions.values()) {
    if (importedSessions.has(s.sessionId)) continue
    // Ended or only silent (#360): no activity for longer than the discovery window
    if ((Date.now() - s.lastActivityTime) / 1000 <= ACTIVE_SESSION_AGE_S) continue
    if (!victim || s.lastActivityTime < victim.lastActivityTime) victim = s
  }
  if (!victim) return false
  dropSession(victim.sessionId)
  return liveCount() < RELAY_MAX_WATCHED_SESSIONS
}

/**
 * Read an imported transcript once (#294) through the same parser and reconciler as a live session. Its events
 * carry `imported` (deliverEvent); nothing watches the file afterwards, and no end is invented for it.
 */
function importSession(sessionId: string, filePath: string, importedAt: number) {
  const session = pipeline.newSession(sessionId, filePath)
  // Registered first: every event emitted below is tagged, and no activity is ever inferred from it
  importedSessions.set(sessionId, { importedAt, ...transcriptTimeRange(filePath) })
  session.sessionCompleted = true
  sessions.set(sessionId, session)
  const header = readSessionHeader(filePath)
  // The cwd of a cloud agent is a container path: shown as a tag, never used to read local files
  if (header.cwd) sessionCwd.set(sessionId, header.cwd)
  if (header.branch) sessionBranch.set(sessionId, header.branch)
  withHistory(() => {
    const size = fs.statSync(filePath).size
    // Label first (first user prompt), so the orchestrator is announced with it
    for (const line of readLinesChunked(filePath, size)) {
      if (session.labelSet) break
      try { parser.extractSessionLabel([JSON.parse(line) as TranscriptEntry], session) } catch { /* not a turn */ }
    }
    broadcastSessionLifecycle('started', sessionId, session.label)
    broadcastEvent({
      time: 0, type: 'agent_spawn',
      payload: { name: ORCHESTRATOR_NAME, isMain: true, task: session.label },
      sessionId,
    })
    session.sessionDetected = true
    // Unlike a live attach (current turn only), the whole file is replayed line by line through the live
    // parser: tool calls, results and subagent dispatches included. The relay buffer caps keep the newest.
    for (const line of readLinesChunked(filePath, size, undefined, session)) {
      if (!line.trim()) continue
      parser.processTranscriptLine(line, ORCHESTRATOR_NAME, session.pendingToolCalls, session.seenToolUseIds, sessionId, session.seenMessageHashes)
    }
    pipeline.emitContextUpdate(ORCHESTRATOR_NAME, session, sessionId)
    // Subagent transcripts next to it (<dir>/<session id>/subagents/), read once as well
    session.subagentsDir = path.join(path.dirname(filePath), sessionId, 'subagents')
    scanSubagentsDir(watcherDelegate, parser, sessionId)
  })
  // Read once: drop the watchers the subagent scan opened
  session.subagentsDirWatcher?.close()
  session.subagentsDirWatcher = null
  for (const sub of session.subagentWatchers.values()) {
    sub.watcher?.close()
    sub.watcher = null
    if (sub.permissionTimer) { clearTimeout(sub.permissionTimer); sub.permissionTimer = null }
  }
  log(`[session] Imported ${sessionId.slice(0, SESSION_ID_DISPLAY)} — "${session.label}"`)
}

function trackSession(sessionId: string, filePath: string) {
  skippedSessions.watchLimit.delete(sessionId)
  skippedSessions.sizeLimit.delete(sessionId)
  skippedSessions.fileLimit.delete(sessionId)
  const header = readSessionHeader(filePath)
  // Times from the file (#365): last written, and the start it records; never the moment the relay attached
  const session = pipeline.newSession(sessionId, filePath, {
    lastActivityTime: newestSessionMtime(filePath, sessionId), recordedStartTime: header.startMs,
  })
  sessions.set(sessionId, session)
  if (header.cwd) sessionCwd.set(sessionId, header.cwd)
  if (header.branch) sessionBranch.set(sessionId, header.branch)
  // Queued and read over several ticks (#651): the relay keeps answering hooks, SSE and /status meanwhile.
  // A transcript that cannot be read is no longer watched, as when the attach was synchronous.
  pipeline.attach(session).catch((e) => {
    if (sessions.get(sessionId) === session) dropSession(sessionId)
    log('[session] Failed to watch', sessionId, e)
  })
}

// ─── Session scanner ────────────────────────────────────────────────────────

const coldScan = createColdScan()

// Transcripts froids (#211) : un événement de watch les réveille tout de suite, sinon ils sont réexaminés
// tous les COLD_RESCAN_CYCLES scans. Un watcher par dossier de projet (borné par RELAY_MAX_PROJECT_DIRS)
// et, pour les sessions inactives, un sur leur dossier subagents (borné par COLD_SUBAGENT_WATCH_MAX).
const COLD_SUBAGENT_WATCH_MAX = 64
const projectDirWakeWatchers = new Map<string, fs.FSWatcher>()
const subagentWakeWatchers = new Map<string, { w: fs.FSWatcher; mtimeMs: number }>()
let wakeScan: (() => void) | null = null

function wakeAndRescan(woken: boolean) {
  if (woken) wakeScan?.()
}

function watchProjectDirsForWake(dirs: string[]) {
  for (const dir of dirs) {
    if (projectDirWakeWatchers.has(dir)) continue
    const w = safeWatch(dir, (_eventType, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return
      wakeAndRescan(wakeColdFile(coldScan, path.join(dir, filename)))
    }, undefined, () => projectDirWakeWatchers.delete(dir))
    if (w) projectDirWakeWatchers.set(dir, w)
  }
}

/** The scope narrowed (or a folder vanished): wake-up watchers of folders no longer scanned are closed, none is left behind. */
function releaseWakeWatchersOutside(scanned: string[]) {
  const inScope = new Set(scanned)
  for (const [dir, w] of [...projectDirWakeWatchers]) {
    if (inScope.has(dir)) continue
    try { w.close() } catch {}
    projectDirWakeWatchers.delete(dir)
  }
  for (const [file, slot] of [...subagentWakeWatchers]) {
    if (inScope.has(path.dirname(file))) continue
    try { slot.w.close() } catch {}
    subagentWakeWatchers.delete(file)
  }
}

/**
 * Narrowing to the workspace: the sessions of other project folders stop being followed, their clients are told
 * (session-ended), and their buffered events are dropped so a later connection does not replay a scope that is gone.
 */
function dropSessionsOutsideWorkspace(workspace: string) {
  let resolved = workspace
  try { resolved = fs.realpathSync(resolved) } catch {}
  const inWorkspace = projectDirMatcher(resolved)
  for (const [id, s] of [...sessions]) {
    // Imported transcripts are not discovered by the scan: the scope never removes them
    if (importedSessions.has(id) || inWorkspace(path.basename(path.dirname(s.filePath)))) continue
    const announced = s.sessionDetected
    const label = s.label
    dropSession(id)
    eventBuffer.delete(id)
    evictedCounts.bySession.delete(id)
    evictionLog.bySession.delete(id)
    if (announced) broadcastSessionLifecycle('ended', id, label)
  }
}

function watchIdleSubagentsDir(f: { sessionId: string; filePath: string; dirPath: string; mtimeMs: number }) {
  if (subagentWakeWatchers.has(f.filePath)) return
  const subagentsDir = path.join(f.dirPath, f.sessionId, 'subagents')
  if (!fs.existsSync(subagentsDir)) return
  // Plein : les sessions les plus récentes gardent leur surveillance (une ancienne n'occupe pas la place à vie)
  const slot = admitWatchSlot(subagentWakeWatchers, COLD_SUBAGENT_WATCH_MAX, f.mtimeMs)
  if (!slot.admit) return
  if (slot.evict) {
    try { subagentWakeWatchers.get(slot.evict)?.w.close() } catch {}
    subagentWakeWatchers.delete(slot.evict)
  }
  let w: fs.FSWatcher | null = null
  const release = () => {
    if (subagentWakeWatchers.get(f.filePath)?.w !== w) return // déjà évincée ou remplacée
    try { w?.close() } catch {}
    subagentWakeWatchers.delete(f.filePath)
  }
  w = safeWatch(subagentsDir, () => { release(); wakeAndRescan(wakeColdFile(coldScan, f.filePath)) }, { recursive: true }, release)
  if (w) subagentWakeWatchers.set(f.filePath, { w, mtimeMs: f.mtimeMs })
}


function scanTranscripts(workspace: string, allWorkspaces = false) {
  if (!fs.existsSync(CLAUDE_DIR)) return

  let match: ((name: string) => boolean) | null = null
  if (!allWorkspaces) {
    let resolved = workspace
    try { resolved = fs.realpathSync(resolved) } catch {}
    // Case-folded on Windows, cut-and-hashed names matched by prefix (#249)
    match = projectDirMatcher(resolved)
  }
  // All workspaces: every real (non-symlink) project dir directly under ~/.claude/projects, the first RELAY_MAX_PROJECT_DIRS by name
  const dirReport = { truncated: false }
  const dirsToScan = listProjectDirs(CLAUDE_DIR, match, RELAY_MAX_PROJECT_DIRS, dirReport, coldScan)
  projectDirsCapped = dirReport.truncated

  coldScan.cycle++
  releaseWakeWatchersOutside(dirsToScan)
  watchProjectDirsForWake(dirsToScan)
  const candidates = findActiveSessions({
    dirs: dirsToScan, maxFileBytes: maxSessionFileBytes, cold: coldScan, activeAgeS: ACTIVE_SESSION_AGE_S,
    skip: (id) => sessions.has(id),
    onIdle: watchIdleSubagentsDir,
    // A ceiling is a visible fact (GET /status), not a silent cut (#291)
    onSkipped: (reason, f) => { if (!sessions.has(f.sessionId)) noteSkipped(reason, f.sessionId) },
  })

  // Newest first so the bounded watcher budget goes to the most recent sessions
  candidates.sort((a, b) => b.newestMtime - a.newestMtime)
  for (const [i, c] of candidates.entries()) {
    if (sessions.has(c.sessionId)) continue
    if (!ensureWatchCapacity()) {
      // Every remaining candidate is skipped: counted in /status, warned once per session
      for (const skipped of candidates.slice(i)) {
        if (sessions.has(skipped.sessionId) || !noteSkipped('watchLimit', skipped.sessionId)) continue
        relayLog.warn(`Watch limit (${RELAY_MAX_WATCHED_SESSIONS}) reached — session ${skipped.sessionId.slice(0, SESSION_ID_DISPLAY)} is not watched`)
      }
      break
    }
    try { trackSession(c.sessionId, c.filePath) } catch (e) {
      dropSession(c.sessionId)
      log('[session] Failed to watch', c.sessionId, e)
    }
  }
}

// ─── Discovery file ─────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  let resolved = path.resolve(p)
  try { resolved = fs.realpathSync(resolved) } catch {}
  return resolved
}

function hashWorkspace(workspace: string): string {
  return crypto.createHash('sha256').update(normalizePath(workspace)).digest('hex').slice(0, WORKSPACE_HASH_LENGTH)
}

let discoveryFilePath: string | null = null

function writeDiscoveryFile(port: number, workspace: string) {
  if (!fs.existsSync(DISCOVERY_DIR)) fs.mkdirSync(DISCOVERY_DIR, { recursive: true })
  const hash = hashWorkspace(workspace)
  discoveryFilePath = path.join(DISCOVERY_DIR, `${hash}-${process.pid}.json`)
  fs.writeFileSync(discoveryFilePath, JSON.stringify({ port, pid: process.pid, workspace: normalizePath(workspace) }, null, 2) + '\n')
}

function removeDiscoveryFile() {
  if (discoveryFilePath) {
    try { fs.unlinkSync(discoveryFilePath) } catch {}
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface Relay {
  /** Handle an incoming SSE connection */
  handleSSE: (req: http.IncomingMessage, res: http.ServerResponse) => void
  /** Handle GET /status: small JSON snapshot (loopback only, rate-limited) */
  handleStatus: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
  /** Handle GET /context?session=<id>: project context (CLAUDE.md, memory) of a watched session */
  handleContext: (req: http.IncomingMessage, res: http.ServerResponse) => void
  /** Handle GET /observations and /observations/schema: the typed action Claude can query (loopback only, rate-limited) */
  handleObservations: (req: http.IncomingMessage, res: http.ServerResponse) => void
  /** Handle GET /statusline: one line of text for a tmux / zellij bar, derived from the observations (#236) */
  handleStatusLine: (req: http.IncomingMessage, res: http.ServerResponse) => void
  /** Handle GET /issue-links?role=<role>: open PRs/issues labelled agent:<role> through gh (loopback only, rate-limited, cached) */
  handleIssueLinks: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
  /** Handle POST /scope: change the discovery scope at run time, behind the same guards as the other routes (#291) */
  handleScope: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
  /** POST /quota: the subscription quota posted by the status line script (#467), same guards as /scope. Served by the
   *  HookServer on the discovery port (the relay installs it there); not mounted on the public HTTP server. */
  handleQuota: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
  /** Handle POST /launch and /launch/<id>/stop (#229): 404 unless the relay was started with --allow-launch */
  handleLaunch: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
  /** True when launching agents from the relay is on (--allow-launch) */
  launchEnabled: boolean
  /** Change what the scan covers without a restart (#291): 'workspace' = this workspace only, 'all' = every project folder.
   *  Returns the scope now in force. The flag / env var only gave the initial value. */
  setScope: (scope: RelayScope) => { scope: RelayScope; allWorkspaces: boolean }
  /** Counters of the webhooks (#236): sent, failed, dropped; null when no destination is configured */
  webhookStats: () => WebhookStats | null
  /** The validated tunnel Host allow list (#241): the one list the app gate and the relay guards both use */
  readonly allowedHosts: readonly string[]
  /** Pairing of the tunnel Hosts (#475): POST /pair and the cookie check. Null without an allow list. */
  readonly remotePairing: RemotePairing | null
  /** Clean up all resources */
  dispose: () => void
  /** Counters for tests and diagnostics: connected clients, shared scan timer, refresh executions, watched sessions, wake-up watchers, an attach in progress */
  debugState: () => { sseClients: number; remoteSseClients: number; scanTimerActive: boolean; runtimeScanTimerActive: boolean; systemTimerActive: boolean; heartbeatTimerActive: boolean; scanRuns: number; runtimeScanRuns: number; statusRuns: number; dedupSessions: number; watchedSessions: number; wakeWatchers: number; attaching: boolean }
}

export type RelayRuntimeMode = 'claude' | 'codex' | 'copilot' | 'pi' | 'gemini' | 'opencode' | 'auto'

export interface RelayOptions {
  workspace: string
  verbose?: boolean
  telemetry?: TelemetryClient
  /** Which runtimes to watch. Defaults to AGENT_LENS_RUNTIME env var, or 'auto'.
   *  Mirrors the extension's `agentVisualizer.runtime` setting so users of the
   *  dev relay and `npx agent-lens-app` have a way to opt out of one runtime. */
  runtime?: RelayRuntimeMode
  /** Also discover Claude sessions from other workspaces (every project dir under
   *  ~/.claude/projects). Defaults to the AGENT_LENS_ALL_WORKSPACES env var (1/true).
   *  Only the INITIAL scope: it can be changed at run time (setScope / POST /scope, #291). */
  allWorkspaces?: boolean
  /** Reads whether the hooks are configured for the workspace (GET /status). Injectable for tests;
   *  defaults to the settings-file check. Concurrent /status requests share ONE call. */
  hooksProbe?: (workspace: string) => Promise<boolean> | boolean
  /** Looks up the issues/PRs of an agent role (GET /issue-links). Injectable for tests; defaults to gh on the
   *  workspace's GitHub `origin`. Resolves [] only when there is truly no link; rejects when gh or git fails (the route answers 502, #205). */
  issueLinksProbe?: (role: string, cwd?: string) => Promise<IssueLink[]>
  /** Looks up the open PRs (branch, checks) and the issues without agent of a project (GET /issue-links?scope=session, #228).
   *  Injectable for tests; defaults to gh. `repo: null` only when the project has no GitHub origin; rejects when gh or git fails. */
  sessionWorkProbe?: (cwd?: string) => Promise<SessionWork>
  /** Optional read-only session index (a local SQLite database), see session-index.ts. Defaults to the
   *  AGENT_LENS_SESSION_INDEX env var (file path). Its sessions are listed as completed, never as live. */
  sessionIndex?: RelaySessionIndexOptions
  /** Period of the SSE keep-alive (ms). Injectable for tests; defaults to RELAY_SSE_HEARTBEAT_MS. */
  sseHeartbeatMs?: number
  /** Period of the machine health sample (ms). Injectable for tests; defaults to SYSTEM_INTERVAL_MS. */
  systemIntervalMs?: number
  /** Transcript size past which a Claude session is not (or no longer) watched. Injectable for tests;
   *  defaults to RELAY_MAX_SESSION_FILE_BYTES. */
  maxSessionFileBytes?: number
  /** Transcripts to import (#294): `<session id>.jsonl` files or folders of them, fetched from a cloud agent.
   *  Read once at startup, listed as imported, never followed live. Defaults to AGENT_LENS_IMPORT
   *  (paths separated by the platform delimiter). Only a local flag or variable sets it, never a request. */
  imports?: string[]
  /** Webhooks (#236): explicit destinations only. Defaults to AGENT_LENS_WEBHOOKS (URLs separated by commas) and
   *  AGENT_LENS_WEBHOOK_EVENTS. `post` is injectable for tests. */
  webhooks?: { destinations: string[]; events?: WebhookEventType[]; post?: (url: string, body: string) => Promise<number> }
  /** Tunnel Host names accepted besides loopback (--allow-host, #241). They only reach GET /events and GET /status,
   *  with their own https origin and RELAY_MAX_REMOTE_SSE_CLIENTS streams; the other routes stay loopback only.
   *  An invalid value makes createRelay throw (fail closed). Default: none. */
  allowedHosts?: string[]
  /** Pairing of the tunnel Hosts (#475). With allowedHosts, a pairing always exists, with a token drawn at this start;
   *  these options only say where the token goes. Refused without allowedHosts (a security option is never a no-op). */
  remotePairing?: RelayRemotePairingOptions
  /** Launching an agent on an issue (#229). Absent = OFF: POST /launch answers 404. Present = ON, which needs an explicit
   *  repository allow-list; an invalid value makes createRelay throw (fail closed). Only a local flag sets it, never a request. */
  launch?: RelayLaunchOptions
}

export interface RelayRemotePairingOptions {
  /** --token-file: the token of this start is written there (replaced at every start, never read back). POSIX: mode
   *  0600. Windows: the mode is ignored and the file inherits the ACL of its folder. A write failure makes createRelay throw. */
  tokenFile?: string
  /** Receives the token once, at creation, to print the pairing URL. The relay never logs nor serves it. */
  onToken?: (token: string) => void
  // Injectable for tests
  token?: string
  maxSessions?: number
  rate?: { burst: number; perSecond: number }
}

export interface RelayLaunchOptions {
  /** `owner/name` of the repositories that may be launched on (also required to be the workspace origin) */
  repos: string[]
  /** Bearer token. Default: random for this start. Injectable for tests only. */
  token?: string
  /** Receives the token once, at creation. The relay keeps it in memory only; it is never served over HTTP. */
  onToken?: (token: string) => void
  /** 1 (default) or 2 */
  maxConcurrent?: number
  /** `--max-budget-usd` (default and ceiling in launch-policy) */
  budgetUsd?: number
  /** Journal file (default `~/.agent-lens/launch-journal.jsonl`) */
  journalPath?: string
  // Injectable for tests
  /** Request budget of POST /launch (default RELAY_LAUNCH_RATE_BURST / RELAY_LAUNCH_RATE_PER_S) */
  rate?: { burst: number; perSecond: number }
  journal?: Journal
  spawn?: SpawnFn
  killGroup?: KillGroupFn
  workspaceOrigin?: () => Promise<string | undefined>
  lookupIssue?: (cmd: { file: 'gh'; args: string[] }) => Promise<string>
}

export interface RelaySessionIndexOptions {
  path: string
  table?: string
  maxRows?: number
  timeoutMs?: number
  /** Injectable driver (tests); defaults to node:sqlite when available */
  opener?: IndexOpener | null
  /** How long a read stays valid (default 30 s) */
  cacheMs?: number
}

/** Yield to the event loop first, so the settings read never blocks the request that triggered it. */
async function defaultHooksProbe(workspace: string): Promise<boolean> {
  await new Promise<void>(resolve => setImmediate(resolve))
  return isHooksConfigured(workspace)
}

function resolveRuntimeMode(explicit?: RelayRuntimeMode): RelayRuntimeMode {
  if (explicit === 'claude' || explicit === 'codex' || explicit === 'copilot' || explicit === 'pi' || explicit === 'gemini' || explicit === 'opencode' || explicit === 'auto') return explicit
  const raw = process.env.AGENT_LENS_RUNTIME
  return raw === 'claude' || raw === 'codex' || raw === 'copilot' || raw === 'pi' || raw === 'gemini' || raw === 'opencode' ? raw : 'auto'
}

export async function createRelay(options: RelayOptions): Promise<Relay> {
  const { workspace } = options
  verbose = options.verbose ?? false
  // Keep warnings visible without --verbose — actionable hints (e.g. "Codex
  // sessions exist but none match this workspace") must reach the user.
  if (!verbose) setLogLevel('warn')
  if (relayCreated) {
    throw new Error('createRelay() can only be called once per process')
  }
  // Tunnel Host names (#241): validated here too, so that no caller can pass a wildcard or an IP (fail closed)
  const remoteHosts = parseAllowedHosts(options.allowedHosts ?? [])
  if (remoteHosts.errors.length > 0) throw new Error(`allowedHosts: ${remoteHosts.errors.join('; ')}`)
  const allowedHosts: readonly string[] = Object.freeze(remoteHosts.hosts)
  // Pairing (#475): one per allow list, token drawn now; a token file that cannot be written stops the start here
  let remotePairing: RemotePairing | null = null
  if (options.remotePairing && allowedHosts.length === 0) throw new Error('remotePairing: needs at least one allowedHosts name')
  if (allowedHosts.length > 0) {
    const p = options.remotePairing
    remotePairing = createRemotePairing({
      allowedHosts,
      ...(p?.token !== undefined ? { token: p.token } : {}),
      ...(p?.maxSessions !== undefined ? { maxSessions: p.maxSessions } : {}),
      ...(p?.rate ? { rate: p.rate } : {}),
    })
    if (p?.tokenFile !== undefined) writeTokenFile(p.tokenFile, remotePairing.token)
  }
  // Launching (#229): validated before anything is started, so a bad flag stops the relay instead of silently disabling the guard
  let launchAllowlist: ReadonlySet<string> | null = null
  if (options.launch) {
    const list = parseRepoAllowlist(options.launch.repos)
    if (!list.ok || list.value.size === 0) throw new Error('launch: --allow-launch needs at least one valid --launch-repo owner/name')
    if (options.launch.budgetUsd !== undefined && !resolveBudgetUsd(options.launch.budgetUsd).ok) throw new Error('launch: invalid budget')
    const cap = options.launch.maxConcurrent
    if (cap !== undefined && (!Number.isInteger(cap) || cap < 1 || cap > LAUNCH_CAPS.concurrentMax)) {
      throw new Error(`launch: maxConcurrent must be an integer from 1 to ${LAUNCH_CAPS.concurrentMax}`)
    }
    launchAllowlist = list.value
  }
  relayCreated = true
  if (remotePairing) {
    bindRemoteAuth(allowedHosts, remotePairing)
    options.remotePairing?.onToken?.(remotePairing.token)
  }
  maxSessionFileBytes = options.maxSessionFileBytes ?? RELAY_MAX_SESSION_FILE_BYTES

  // Webhooks (#236): a URL may hold a secret, so problems are reported without it
  {
    const wanted = options.webhooks?.destinations ?? (process.env.AGENT_LENS_WEBHOOKS ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const parsedEvents = options.webhooks?.events ? { events: options.webhooks.events } : parseWebhookEvents(process.env.AGENT_LENS_WEBHOOK_EVENTS)
    const parsed = parseWebhookDestinations(wanted)
    for (const problem of parsed.errors) relayLog.warn(`Webhook: ${problem}`)
    if ('error' in parsedEvents && parsedEvents.error) relayLog.warn(`Webhook: ${parsedEvents.error}; using the defaults`)
    webhooks = parsed.destinations.length > 0
      ? createWebhookDispatcher({ destinations: parsed.destinations, events: parsedEvents.events, ...(options.webhooks?.post ? { post: options.webhooks.post } : {}) })
      : null
  }

  // Optional session index: read lazily, cached briefly, never fatal (a degraded index only logs and shows in /status)
  const indexConfig: RelaySessionIndexOptions | undefined = options.sessionIndex
    ?? (process.env.AGENT_LENS_SESSION_INDEX ? { path: process.env.AGENT_LENS_SESSION_INDEX } : undefined)
  let indexCache: { at: number; result: SessionIndexResult } | null = null
  const readIndex = (): SessionIndexResult | null => {
    if (!indexConfig) return null
    const now = Date.now()
    if (indexCache && now - indexCache.at < (indexConfig.cacheMs ?? RELAY_SESSION_INDEX_CACHE_MS)) return indexCache.result
    const { opener, cacheMs: _cacheMs, ...rest } = indexConfig
    const raw = opener === undefined ? readSessionIndex(rest) : readSessionIndex(rest, opener)
    // Scoped relay (default): only the index rows of this workspace, like the live scan
    const result = allWorkspaces ? raw : { ...raw, sessions: filterIndexedByWorkspace(raw.sessions, workspace) }
    if (result.status !== 'ok' && result.message && result.message !== indexCache?.result.message) log(`[relay] ${result.message}`)
    indexCache = { at: now, result }
    return result
  }

  enrichSession = info => {
    const indexed = readIndex()
    return indexed ? withIndexedFacts(info, indexed.sessions.find(s => s.id === info.id)) : info
  }

  let allWorkspaces = options.allWorkspaces ?? isTruthyFlag(process.env.AGENT_LENS_ALL_WORKSPACES)

  // Imported transcripts (#294): read before the scan, so a live session never takes their id first
  const importPaths = options.imports ?? parseImportPaths(process.env.AGENT_LENS_IMPORT)
  if (importPaths.length > 0) {
    const { transcripts, problems } = resolveImportedTranscripts(importPaths, { maxFileBytes: maxSessionFileBytes, maxSessions: RELAY_MAX_IMPORTED_SESSIONS })
    for (const problem of problems) relayLog.warn(`Import: ${problem}`)
    const importedAt = Date.now()
    for (const t of transcripts) {
      try { importSession(t.sessionId, t.filePath, importedAt) } catch (e) {
        dropSession(t.sessionId)
        relayLog.warn(`Import: ${t.filePath} could not be read (${e instanceof Error ? e.message : String(e)})`)
      }
    }
    if (transcripts.length > 0) relayLog.info(`Imported ${transcripts.length} transcript(s)`)
  }
  const mode = resolveRuntimeMode(options.runtime)
  const wantClaude = mode === 'claude' || mode === 'auto'
  const wantCodex = mode === 'codex' || mode === 'auto'
  const wantCopilot = mode === 'copilot' || mode === 'auto'
  const wantPi = mode === 'pi' || mode === 'auto'
  const wantGemini = mode === 'gemini' || mode === 'auto'
  const wantOpenCode = mode === 'opencode' || mode === 'auto'
  log(`[relay] Runtime mode: ${mode} (watching: ${[wantClaude && 'claude', wantCodex && 'codex', wantCopilot && 'copilot', wantPi && 'pi', wantGemini && 'gemini', wantOpenCode && 'opencode'].filter(Boolean).join(', ')})`)

  let hookServer: HookServer | null = null
  let scanTicker: SharedTicker | null = null
  let scanNow: (() => void) | null = null
  // Keep-alive (#141): one shared timer, running only while an SSE client is connected. EventSource hides SSE
  // comments from the page, so the beat is a data frame the web client reads as proof of life and discards.
  const heartbeatTicker = new SharedTicker(() => {
    // A client still receiving its replay gets data anyway, and a held beat would only arrive late
    for (const res of [...sseClients]) if (!outboxes.has(res)) writeToClient(res, HEARTBEAT_PAYLOAD)
  }, options.sseHeartbeatMs ?? RELAY_SSE_HEARTBEAT_MS)
  // System panel (#357): one shared sampler for the LOCAL clients; nothing runs without one, and nothing
  // machine-related goes through broadcast() (a tunnel Host never receives it, #241).
  let cpuCounters: CpuCounters[] | null = null
  const systemIo = nodeIo()
  const systemTicker = new SharedTicker(() => {
    const { sample, counters } = sampleSystem(cpuCounters, systemIo)
    cpuCounters = counters
    broadcastLocal(JSON.stringify({ type: 'system-stats', sample }))
  }, options.systemIntervalMs ?? SYSTEM_INTERVAL_MS)
  const scanCoalescer = new KeyedCoalescer<void>()
  const statusCoalescer = new KeyedCoalescer<StatusSnapshot>()
  let statusComputations = 0
  let projectDirWatcher: fs.FSWatcher | null = null
  let projectWatchScan: ReturnType<typeof createProjectWatchScan> | null = null

  if (wantClaude) {
    hookServer = new HookServer()
    const hookPort = await hookServer.start()
    if (hookPort === HOOK_SERVER_NOT_STARTED) {
      throw new Error('Failed to start hook server (port in use)')
    }

    // Go through broadcastEvent so hook events are buffered and replayed like transcript events
    // Subagent lifecycle for watched sessions is owned by the transcript parser (it has the
    // real names and ids); hook copies would duplicate nodes with divergent names.
    const TEAM_EVENTS = new Set(['agent_link', 'message_sent'])
    const SUBAGENT_LIFECYCLE = new Set(['agent_spawn', 'subagent_dispatch', 'subagent_return', 'agent_complete'])
    hookServer.onEvent((event: AgentEvent) => {
      const who = event.payload?.agent ?? event.payload?.name ?? event.payload?.child
      const isOrchestrator = !who || who === ORCHESTRATOR_NAME
      // An imported session is what its file recorded: a hook with its id would mix live states into it
      if (event.sessionId && importedSessions.has(event.sessionId)) return
      // The transcript parser emits agent_link/message_sent for watched sessions; hook copies would duplicate them
      if (TEAM_EVENTS.has(event.type) && event.sessionId && sessions.has(event.sessionId)) return
      if (!isOrchestrator && SUBAGENT_LIFECYCLE.has(event.type) && event.sessionId && sessions.has(event.sessionId)) return
      // A Stop is a turn end: only a SessionEnd finishes the orchestrator, as in the extension (#360)
      const filtered = filterOrchestratorCompletion(event)
      if (!filtered) return
      broadcastEvent(filtered, 'hook')
      // After the event: a SessionEnd ends a watched session, any other hook is activity
      pipeline.observeHookEvent(filtered)
    })

    writeDiscoveryFile(hookPort, workspace)
    void purgeStaleDiscoveryFiles({ dir: DISCOVERY_DIR }).catch(() => {})

    scanTranscripts(workspace, allWorkspaces)
    // One shared interval for all SSE clients, stopped when the last one leaves (issue #68).
    // Without a client, new transcripts are still picked up by the project dir watcher and on connect.
    scanNow = () => {
      scanCoalescer.run('scan', () => scanTranscripts(workspace, allWorkspaces))
        .catch(e => log('[scan] Failed:', e))
    }
    // A tracked transcript never scans; an unknown one scans at once, then at most every WATCH_SCAN_DEBOUNCE_MS (#650).
    // The wake-up of a cold transcript shares that debounce: a long session over maxSessionFileBytes is put back to
    // sleep by each scan and woken by its next write, so it scanned on every write (#613)
    projectWatchScan = createProjectWatchScan({ scan: () => scanNow?.(), isTracked: id => sessions.has(id) })
    wakeScan = () => projectWatchScan?.request()
    scanTicker = new SharedTicker(scanNow, SCAN_INTERVAL_MS)

    // Agent Teams: ~/.claude/teams config (team_info, member sessions, 'done' members) and inboxes
    relayWorkspace = normalizePath(workspace)
    teamWatcher = new TeamWatcher({
      teamsDir: TEAMS_DIR,
      workspaces: allWorkspaces ? null : [workspace],
      host: {
        listSessions: () => [...sessions.values()]
          .filter(s => s.sessionDetected)
          .map(s => ({ sessionId: s.sessionId, filePath: s.filePath, startTime: s.sessionStartTime })),
        emitTeamInfo: (sessionId, payload) => broadcastEvent({
          time: pipeline.elapsed(sessionId), type: 'team_info', payload: { ...payload }, sessionId,
        }),
        emitInbox: (sessionId, from, to, content) => parser.emitInboxMessage(sessionId, from, to, content),
        setLeadAlias: (sessionId, leadName) => parser.setLeadAlias(sessionId, leadName),
        onMembersGone: (sessionId, _team, names) => {
          const s = sessions.get(sessionId)
          if (s) markTeammatesDone(watcherDelegate, s, sessionId, names)
        },
        onSessionTags,
      },
    })
    // Its first pass reads the sessions found at start once they are attached (queued, over several ticks, #651),
    // as when they were attached synchronously before it: a team is first reported with its whole roster
    const startTeams = () => teamWatcher?.start()
    const startupAttaches = pipeline.whenAttached()
    if (startupAttaches) void startupAttaches.then(startTeams)
    else startTeams()

    const resolved = (() => { try { return fs.realpathSync(workspace) } catch { return workspace } })()
    const projectDir = encodeProjectDirName(resolved).length > PROJECT_DIR_NAME_MAX
      ? listProjectDirs(CLAUDE_DIR, projectDirMatcher(resolved), 1)[0]
      : path.join(CLAUDE_DIR, encodeProjectDirName(resolved))
    if (projectDir && fs.existsSync(projectDir)) {
      try {
        projectDirWatcher = safeWatch(projectDir, (_eventType, filename) => projectWatchScan?.onEvent(filename))
      } catch {}
    }
  }

  // ─── Codex runtime ────────────────────────────────────────────────────────
  // Watch Codex rollouts in parallel. No-op if ~/.codex/sessions doesn't
  // exist or no sessions match the current workspace.
  // We don't subscribe to onSessionDetected — it fires together with the
  // lifecycle 'started' event in CodexSessionWatcher.attachSession, so
  // wiring both would double-broadcast session-started to SSE clients.
  let codexWatcher: CodexSessionWatcher | null = null
  if (wantCodex) {
    codexWatcher = new CodexSessionWatcher(workspace)
    codexWatcher.onEvent((event) => broadcastEvent(event))
    codexWatcher.onSessionLifecycle((lifecycle) => {
      broadcastSessionLifecycle(lifecycle.type, lifecycle.sessionId, lifecycle.label, lifecycleTags(lifecycle))
    })
    codexWatcher.start({ ownTimer: false })
  }

  // ─── Copilot runtime ──────────────────────────────────────────────────────
  // Watch local GitHub Copilot sessions (~/.copilot/session-state/<id>/events.jsonl).
  // No-op if the directory doesn't exist or no session matches the workspace.
  // Same single-subscription rule as Codex: lifecycle 'started' already covers detection.
  let copilotWatcher: CopilotSessionWatcher | null = null
  if (wantCopilot) {
    copilotWatcher = new CopilotSessionWatcher(workspace)
    copilotWatcher.onEvent((event) => broadcastEvent(event))
    copilotWatcher.onSessionLifecycle((lifecycle) => {
      broadcastSessionLifecycle(lifecycle.type, lifecycle.sessionId, lifecycle.label, lifecycleTags(lifecycle))
    })
    copilotWatcher.start({ ownTimer: false })
  }

  // ─── Pi runtime ───────────────────────────────────────────────────────────
  // Watch Pi coding agent sessions (~/.pi/agent/sessions/--<path>--/<ts>_<id>.jsonl, #238).
  // No-op if the directory doesn't exist or no session matches the workspace.
  // Same single-subscription rule as Codex: lifecycle 'started' already covers detection.
  let piWatcher: PiSessionWatcher | null = null
  if (wantPi) {
    piWatcher = new PiSessionWatcher(workspace)
    piWatcher.onEvent((event) => broadcastEvent(event))
    piWatcher.onSessionLifecycle((lifecycle) => {
      broadcastSessionLifecycle(lifecycle.type, lifecycle.sessionId, lifecycle.label, lifecycleTags(lifecycle))
    })
    piWatcher.start({ ownTimer: false })
  }

  // ─── Gemini CLI runtime ───────────────────────────────────────────────────
  // Watch Gemini CLI sessions (~/.gemini/tmp/<project>/chats/session-*.jsonl, #238), matched to the
  // workspace by the project hash of the first record. No-op if the directory doesn't exist.
  let geminiWatcher: GeminiSessionWatcher | null = null
  if (wantGemini) {
    geminiWatcher = new GeminiSessionWatcher(workspace)
    geminiWatcher.onEvent((event) => broadcastEvent(event))
    geminiWatcher.onSessionLifecycle((lifecycle) => {
      broadcastSessionLifecycle(lifecycle.type, lifecycle.sessionId, lifecycle.label, lifecycleTags(lifecycle))
    })
    geminiWatcher.start({ ownTimer: false })
  }

  // ─── OpenCode runtime ─────────────────────────────────────────────────────
  // Watch OpenCode sessions (SQLite database, read-only, #346), matched to the workspace directory.
  let openCodeWatcher: OpenCodeSessionWatcher | null = null
  if (wantOpenCode) {
    // In auto mode OpenCode was not asked for: its missing database is reported only on proof of use (#420)
    openCodeWatcher = new OpenCodeSessionWatcher(workspace, { optional: mode === 'auto' })
    openCodeWatcher.onEvent((event) => broadcastEvent(event))
    openCodeWatcher.onSessionLifecycle((lifecycle) => {
      // Runtime and cwd ride on session-started: a session started while the page is open gets its badge (#420)
      broadcastSessionLifecycle(lifecycle.type, lifecycle.sessionId, lifecycle.label, lifecycleTags(lifecycle))
    })
    openCodeWatcher.start({ ownTimer: false })
  }

  // The discovery scans of the other runtimes run on one shared interval, like the Claude scan: started by the
  // first SSE client, stopped by the last (#654). It is a second SharedTicker next to scanTicker, not
  // scanTicker.acquire(): scanTicker only exists when the Claude runtime is on (and its tick is the Claude scan), while
  // these scans exist whenever another runtime does. In 'auto' mode a client therefore holds two one-second
  // intervals, the Claude scan and this one. Without a client the Codex, Copilot, Pi and Gemini fs.watch still react; OpenCode (no fs.watch) is read at the next connection.
  let runtimeScanRuns = 0
  let lastRuntimeScanAt = 0
  const scanOtherRuntimes = () => {
    runtimeScanRuns++
    lastRuntimeScanAt = Date.now()
    for (const scan of [
      () => codexWatcher?.scan(), () => copilotWatcher?.scan(), () => piWatcher?.scan(),
      () => geminiWatcher?.scan(), () => openCodeWatcher?.scanNow(),
    ]) {
      try { scan() } catch (e) { log('[scan] Runtime scan failed:', e) }
    }
  }
  // The scan of a connection (before the client joins, so what it finds reaches it through the list and the replay)
  // is skipped when one ran less than WATCH_SCAN_DEBOUNCE_MS ago: a burst of reconnections costs one scan of the five
  // runtimes (statSync of Copilot included), not one each. What appeared in that window comes at the next tick.
  const scanRuntimesOnConnect = () => {
    if (Date.now() - lastRuntimeScanAt < WATCH_SCAN_DEBOUNCE_MS) return
    scanOtherRuntimes()
  }
  // Release is not discovery: a session silent past ACTIVE_SESSION_AGE_S is retired (fs.watch, poll timer) even
  // with nobody connected, on a slow timer and before /status counts (#654)
  const releaseOtherRuntimes = () => {
    for (const w of [codexWatcher, copilotWatcher, piWatcher, geminiWatcher, openCodeWatcher]) {
      try { w?.releaseIdle() } catch (e) { log('[scan] Runtime release failed:', e) }
    }
  }
  const runtimeScanTicker = new SharedTicker(scanOtherRuntimes, SCAN_INTERVAL_MS)
  const hasOtherRuntimes = !!(codexWatcher || copilotWatcher || piWatcher || geminiWatcher || openCodeWatcher)
  const runtimeReleaseTimer = hasOtherRuntimes ? setInterval(releaseOtherRuntimes, RUNTIME_RELEASE_INTERVAL_MS) : null
  runtimeReleaseTimer?.unref()

  const telemetry = options.telemetry
  const sessionStart = Date.now()
  let relayDisposed = false
  const relaySessionId = `relay-${process.pid}-${Math.floor(sessionStart / 1000)}`
  sessionEventCount = 0

  const agentLensVersion = resolveAgentLensVersion()

  const baseEvent = () => ({
    session_id: relaySessionId,
    agent_lens_version: agentLensVersion,
    os: os.platform(),
    arch: os.arch(),
  })

  telemetry?.emit({ ...baseEvent(), event_type: 'session_start' })

  process.on('uncaughtException', (err) => {
    try {
      telemetry?.emit({
        ...baseEvent(),
        event_type: 'error',
        error_class: err?.constructor?.name ?? 'Error',
      })
    } catch { /* don't let the handler itself crash */ }
    // Detached launched agents do not die with us: kill them first (#229)
    try { launchKillAll?.() } catch { /* best effort */ }
    // Preserve default crash-on-uncaught behavior: log, then exit.
    console.error(err)
    process.exit(1)
  })

  const statusLimiter = new KeyedRateLimiter(RELAY_STATUS_RATE_BURST, RELAY_STATUS_RATE_PER_S, RELAY_STATUS_RATE_MAX_KEYS)
  const contextLimiter = new KeyedRateLimiter(RELAY_CONTEXT_RATE_BURST, RELAY_CONTEXT_RATE_PER_S, RELAY_STATUS_RATE_MAX_KEYS)
  const observationsLimiter = new KeyedRateLimiter(RELAY_STATUS_RATE_BURST, RELAY_STATUS_RATE_PER_S, RELAY_STATUS_RATE_MAX_KEYS)
  const sseLimiter = new KeyedRateLimiter(RELAY_SSE_RATE_BURST, RELAY_SSE_RATE_PER_S, RELAY_STATUS_RATE_MAX_KEYS)
  const issueLinksLimiter = new KeyedRateLimiter(RELAY_ISSUE_LINKS_RATE_BURST, RELAY_ISSUE_LINKS_RATE_PER_S, RELAY_STATUS_RATE_MAX_KEYS)
  const observations = createObservationsAction(() => {
    const list: SessionInfo[] = []
    for (const session of sessions.values()) if (session.sessionDetected) list.push(toSessionInfo(session))
    if (codexWatcher) list.push(...codexWatcher.getActiveSessions().map(s => ({ ...s, runtime: 'codex' })))
    if (copilotWatcher) list.push(...copilotWatcher.getActiveSessions())
    if (piWatcher) list.push(...piWatcher.getActiveSessions())
    if (geminiWatcher) list.push(...geminiWatcher.getActiveSessions())
    if (openCodeWatcher) list.push(...openCodeWatcher.getActiveSessions())
    return { sessions: list, agents: agentTracker }
  })
  const hooksProbe = options.hooksProbe ?? defaultHooksProbe
  const runtimeList = [wantClaude && 'claude', wantCodex && 'codex', wantCopilot && 'copilot', wantPi && 'pi', wantGemini && 'gemini', wantOpenCode && 'opencode'].filter((r): r is string => typeof r === 'string')

  // Issue/PR links (#63): the repository is the workspace's own GitHub origin, resolved once per directory
  // One repository lookup per directory: a node's links come from the repository of its own session
  // A git failure is not kept: only a resolved repository is (#205)
  const repoUrlOf = createRepoUrlCache(dir => resolveRepoUrl(dir), RELAY_ISSUE_LINKS_CACHE_MAX_ROLES)
  const issueLinksProbe = options.issueLinksProbe ?? (async (role: string, cwd?: string): Promise<IssueLink[]> => {
    const repoUrl = await repoUrlOf(cwd ?? workspace)
    return repoUrl ? fetchIssueLinks(role, { repoUrl }) : []
  })
  const sessionWorkProbe = options.sessionWorkProbe ?? (async (cwd?: string): Promise<SessionWork> => {
    const repoUrl = await repoUrlOf(cwd ?? workspace)
    return repoUrl ? { repo: repoUrl, ...await fetchSessionWork({ repoUrl }) } : { repo: null, prs: [], issues: [], prsTruncated: false, issuesTruncated: false }
  })

  // Routes HTTP : chacune dans scripts/routes/, derrière les mêmes gardes (guardedRoute)
  const handleIssueLinks = createIssueLinksRoute({
    limiter: issueLinksLimiter,
    allWorkspaces: () => allWorkspaces,
    cwdOf: sessionId => (importedSessions.has(sessionId) ? undefined : sessionCwd.get(sessionId)) ?? readIndex()?.sessions.find(s => s.id === sessionId)?.cwd,
    probe: issueLinksProbe,
    workProbe: sessionWorkProbe,
  })
  // Launch an agent on an issue (#229): OFF unless --allow-launch. The route is loopback only, behind a per-start token.
  let launchSupervisor: LaunchSupervisor | null = null
  let handleLaunch = createLaunchDisabledRoute()
  if (options.launch && launchAllowlist) {
    const opts = options.launch
    const token = opts.token ?? newLaunchToken()
    launchSupervisor = createLaunchSupervisor({
      workspace,
      journal: opts.journal ?? createFileJournal({ file: opts.journalPath ?? path.join(os.homedir(), '.agent-lens', 'launch-journal.jsonl') }),
      ...(opts.spawn ? { spawn: opts.spawn } : {}),
      ...(opts.killGroup ? { killGroup: opts.killGroup } : {}),
      ...(opts.maxConcurrent !== undefined ? { maxConcurrent: opts.maxConcurrent } : {}),
      onChange: launch => broadcastLocal(JSON.stringify({ type: 'launch', launch })),
    })
    const supervisor = launchSupervisor
    launchSessionSeen = id => supervisor.sessionSeen(id)
    launchSnapshot = () => supervisor.list()
    launchKillAll = () => supervisor.dispose()
    handleLaunch = createLaunchRoute({
      limiter: new KeyedRateLimiter(opts.rate?.burst ?? RELAY_LAUNCH_RATE_BURST, opts.rate?.perSecond ?? RELAY_LAUNCH_RATE_PER_S, RELAY_STATUS_RATE_MAX_KEYS),
      token, allowlist: launchAllowlist, supervisor,
      workspaceOrigin: opts.workspaceOrigin ?? (() => repoUrlOf(workspace)),
      lookupIssue: opts.lookupIssue ?? (cmd => defaultExec(cmd.file, cmd.args, { cwd: workspace })),
      ...(opts.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
    })
    opts.onToken?.(token)
  }
  const launchStatus = launchSupervisor
    ? () => ({ maxConcurrent: launchSupervisor!.maxConcurrent, launches: launchSupervisor!.list() })
    : undefined
  const handleStatus = createStatusRoute({
    limiter: statusLimiter,
    coalescer: statusCoalescer,
    computeSnapshot: async () => {
      statusComputations++
      const hooksConfigured = wantClaude ? await hooksProbe(workspace) : false
      const disable1MContext = wantClaude ? isDisable1MContext() : false
      releaseOtherRuntimes()
      let sessionCount = 0
      for (const session of sessions.values()) if (session.sessionDetected) sessionCount++
      if (codexWatcher) sessionCount += codexWatcher.getActiveSessions().length
      if (copilotWatcher) sessionCount += copilotWatcher.getActiveSessions().length
      if (piWatcher) sessionCount += piWatcher.getActiveSessions().length
      if (geminiWatcher) sessionCount += geminiWatcher.getActiveSessions().length
      if (openCodeWatcher) sessionCount += openCodeWatcher.getActiveSessions().length
      return { sessionCount, hooksConfigured, disable1MContext }
    },
    base: { relayVersion: agentLensVersion, workspace: normalizePath(workspace), runtimes: runtimeList },
    // Read when answering: the scope and the ceilings are those of the scan that really ran
    live: () => ({
      allWorkspaces,
      skippedSessions: { watchLimit: skippedSessions.watchLimit.size, sizeLimit: skippedSessions.sizeLimit.size, fileLimit: skippedSessions.fileLimit.size },
      discovery: { projectDirsCapped, maxProjectDirs: RELAY_MAX_PROJECT_DIRS, maxFilesPerDir: RELAY_MAX_FILES_PER_DIR },
      // A runtime that cannot read its source says so, as last observed by its watcher (#420)
      runtimeProblems: [openCodeWatcher?.statusProblem()].flatMap(m => (m ? [{ runtime: 'opencode', message: m }] : [])),
      // Losses no followed session counts (a session not followed at the time): counted here, never silent (#420)
      // capped at 1e9, where the page reads a count: beyond, it stays a lower bound instead of being dropped
      runtimeLosses: [openCodeWatcher?.unattributedLosses()].flatMap(l => (l && (l.unreadableRows > 0 || l.missedUpdates > 0)
        ? [{ runtime: 'opencode', unreadableRows: Math.min(l.unreadableRows, RUNTIME_LOSS_MAX), missedUpdates: Math.min(l.missedUpdates, RUNTIME_LOSS_MAX) }]
        : [])),
    }),
    readIndex,
    allowedHosts,
    ...(launchStatus ? { launch: launchStatus } : {}),
  })
  const handleContext = createContextRoute({
    limiter: contextLimiter,
    // The cwd of an imported session is a path on another machine: never read locally
    cwdOf: sessionId => sessions.has(sessionId) && !importedSessions.has(sessionId) ? sessionCwd.get(sessionId) : undefined,
    transcriptOf: sessionId => importedSessions.has(sessionId) ? undefined : sessions.get(sessionId)?.filePath,
  })
  const handleObservations = createObservationsRoute({ limiter: observationsLimiter, observations })
  const handleStatusLine = createStatusLineRoute({ limiter: observationsLimiter, observe: () => observations.run({ includeAgents: true }) })

  // Scope at run time (#291). One entry point (setScope), used by POST /scope, so the state shown by GET /status is the one the scan uses.
  const setScope = (scope: RelayScope): { scope: RelayScope; allWorkspaces: boolean } => {
    const wide = scope === 'all'
    if (wide !== allWorkspaces) {
      allWorkspaces = wide
      if (!wide) dropSessionsOutsideWorkspace(workspace)
      // What the previous scope found or cut is not true of the new one: forget it, the scan below recounts
      coldScan.until.clear()
      for (const set of Object.values(skippedSessions)) set.clear()
      projectDirsCapped = false
      indexCache = null
      teamWatcher?.setWorkspaces(wide ? null : [workspace])
      if (wantClaude) {
        scanTranscripts(workspace, allWorkspaces)
        teamWatcher?.scan()
      }
      // Clients (other tabs included) reload their view: sessions of the left scope must not linger
      broadcast(JSON.stringify({ type: 'relay-scope', allWorkspaces }))
    }
    return { scope: allWorkspaces ? 'all' : 'workspace', allWorkspaces }
  }
  const scopeLimiter = new KeyedRateLimiter(RELAY_SCOPE_RATE_BURST, RELAY_SCOPE_RATE_PER_S, RELAY_STATUS_RATE_MAX_KEYS)
  const handleScope = createScopeRoute({ limiter: scopeLimiter, apply: setScope })
  // Subscription quota (#467): last state kept in memory, sent to local clients only (never a tunnel Host)
  const quotaStore = createQuotaStore()
  const quotaLimiter = new KeyedRateLimiter(RELAY_QUOTA_RATE_BURST, RELAY_QUOTA_RATE_PER_S, RELAY_STATUS_RATE_MAX_KEYS)
  const handleQuota = createQuotaRoute({
    limiter: quotaLimiter,
    accept: body => {
      const quota = quotaStore.accept(body)
      // A copy: the store keeps its own object, which no message may alias
      broadcastLocal(JSON.stringify({ type: 'quota', quota: { ...quota } }))
      return quota
    },
  })

  // The status line script only knows the discovery port, which is the HookServer's: it serves POST /quota
  // through this route, with the route's own guards (#467). Removed again when the relay is disposed.
  hookServer?.setQuotaHandler(handleQuota)

  return {
    handleScope,
    handleQuota,
    handleLaunch,
    launchEnabled: launchSupervisor !== null,
    setScope,
    handleIssueLinks,
    handleStatus,
    handleContext,
    handleObservations,
    handleStatusLine,
    allowedHosts,
    remotePairing,

    handleSSE(req: http.IncomingMessage, res: http.ServerResponse) {
      applySecurityHeaders(res, 'api')
      // Loopback peer only; Host loopback or EXACTLY an allowed tunnel name (#241), anything else is DNS rebinding
      const hostClass = requestHostClass(req, allowedHosts)
      if (!isLoopbackAddress(req.socket.remoteAddress) || hostClass === 'foreign') {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden')
        return
      }
      // Another site (Origin / Sec-Fetch-Site) must not hold SSE slots or trigger a scan and a replay (#200);
      // through a tunnel, only the tunnel's own https origin
      const crossOrigin = hostClass === 'allowed'
        ? isRemoteCrossOrigin(req.headers, req.headers.host ?? '')
        : isCrossOriginRequest(req.headers, req.headers.host)
      if (crossOrigin) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden')
        return
      }
      // Through a tunnel, no stream without a live pairing cookie (#475): 401 without detail, before any work.
      // The pairing of a loopback Host while remote access is on (#517) is enforced by the app gate (gateRemoteRequest), the
      // first step of every createRelay caller that passes allowedHosts (remote-gate-wiring.test.ts, #535)
      if (hostClass === 'allowed' && !isRemotePaired(req, allowedHosts)) {
        res.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
        res.end('Unauthorized')
        return
      }
      // Through a tunnel the peer is always 127.0.0.1: one bucket per tunnel name, not per client-chosen User-Agent
      const rateKey = hostClass === 'allowed' ? remoteRateKey(req.headers.host ?? '') : statusRateKey(req.socket.remoteAddress, req.headers)
      if (!sseLimiter.allow(rateKey)) {
        res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '1' })
        res.end('Too many requests')
        return
      }
      const { session: sessionParam, invalid } = parseSessionParam(req.url)
      if (invalid) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('Invalid session parameter')
        return
      }
      if (sseClients.size + pendingSseClients >= RELAY_MAX_SSE_CLIENTS || (hostClass === 'allowed' && remoteSseCount() + pendingRemoteSseClients >= RELAY_MAX_REMOTE_SSE_CLIENTS)) {
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '5' })
        res.end('Too many clients')
        return
      }
      if (hostClass === 'allowed') remoteSseClients.add(res)

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
      })
      // Send headers now so clients see the stream open even before the first event
      res.flushHeaders()

      if (sessionParam) clientSessionFilter.set(res, sessionParam)
      // Refresh BEFORE this client joins the broadcast: a session found now reaches it once, through the
      // session list and the replay below, and not a second time as a live broadcast (issue #53).
      scanNow?.()
      if (hasOtherRuntimes) scanRuntimesOnConnect()
      const join = () => {
        // The history that scan read goes to the clients already there; this one gets it in its replay (#652)
        flushHistory()
        sseClients.add(res)
        log(`[sse] Client connected (${sseClients.size} total)`)
        // First client starts the shared scan timer; the last one leaving stops it
        const releaseTicker = scanTicker?.acquire()
        const releaseRuntimeScans = hasOtherRuntimes ? runtimeScanTicker.acquire() : undefined
        const releaseSystem = hostClass !== 'allowed' ? systemTicker.acquire() : undefined
        const releaseHeartbeat = heartbeatTicker.acquire()

        // Clean up on every way a connection can end; idempotent.
        let closed = false
        const onGone = () => {
          if (closed) return
          closed = true
          releaseTicker?.()
          releaseRuntimeScans?.()
          if (releaseSystem) {
            releaseSystem()
            // Timer stopped: the next sample starts a new CPU interval, so it carries no CPU figure
            if (!systemTicker.active) cpuCounters = null
          }
          releaseHeartbeat()
          sseClients.delete(res)
          clientSessionFilter.delete(res)
          outboxes.delete(res)
          log(`[sse] Client disconnected (${sseClients.size} total)`)
        }
        req.on('close', onGone)
        res.on('close', onGone)
        res.on('error', onGone)

        // Send current session list (Claude + Codex)
        let sessionList: SessionInfo[] = []
        for (const session of sessions.values()) {
          if (!session.sessionDetected) continue
          sessionList.push(toSessionInfo(session))
        }
        if (codexWatcher) sessionList.push(...codexWatcher.getActiveSessions().map(s => ({ ...s, runtime: 'codex' })))
        if (copilotWatcher) sessionList.push(...copilotWatcher.getActiveSessions())
        if (piWatcher) sessionList.push(...piWatcher.getActiveSessions())
        if (geminiWatcher) sessionList.push(...geminiWatcher.getActiveSessions())
        if (openCodeWatcher) sessionList.push(...openCodeWatcher.getActiveSessions())
        // Indexed sessions complete the list; a session that is also watched live keeps its live entry
        const indexed = readIndex()
        if (indexed) sessionList = mergeIndexedSessions(sessionList, indexed.sessions)
        if (sessionList.length > 0) {
          sendSSE(res, { type: 'session-list', sessions: sessionList })
        }

        // Local clients learn the launches in progress (a tunnel Host never does)
        if (launchSnapshot && hostClass !== 'allowed') {
          const launches = launchSnapshot()
          if (launches.length > 0) sendSSE(res, { type: 'launch-list', launches })
        }

        // Local clients get the last subscription quota (#467); a tunnel Host never does
        const quota = quotaStore.current()
        if (quota && hostClass !== 'allowed') sendSSE(res, { type: 'quota', quota: { ...quota } })

        // Replay buffered events: only the requested session with ?session=<id>,
        // otherwise every session's buffer (most recent active session last).
        const sorted = sessionList.filter(s => !s.indexedOnly).sort((a, b) => {
          const aActive = a.status === 'active' ? 1 : 0
          const bActive = b.status === 'active' ? 1 : 0
          if (aActive !== bActive) return bActive - aActive
          return b.lastActivityTime - a.lastActivityTime
        })
        // Volume is capped per session and in total (RELAY_MAX_REPLAY_*), newest events kept.
        const replayDropped = new Map<string, number>()
        // A client back from a cut link (#366): what it last received from THIS relay process, else nothing is counted
        const since = parseSinceParam(req.url)
        const sinceSeq = since && since.instance === relayInstance && since.seq <= eventSeq ? since.seq : null
        // Served all the same; a client that keeps sending an unusable cursor shows up in the log (never its value)
        if (sinceSeq === null && /[?&]since=/.test(req.url ?? '')) log('[sse] since ignored: malformed, repeated, ahead or from another relay instance')
        const gap: Record<string, number> = {}
        const addGap = (sid: string, n: number) => { if (n > 0) gap[sid] = Math.min((gap[sid] ?? 0) + n, Number.MAX_SAFE_INTEGER) }
        // The client keeps its graph across a reconnection (reconnect.ts): it already has what is numbered up to `since`
        // (#653). Nothing is lost by leaving it out; what the cap or the buffer cannot give back is still counted below.
        let buffers: ReadonlyMap<string, readonly AgentEvent[]> = eventBuffer
        if (sinceSeq !== null) {
          // With ?session=, only that buffer is read (the replay keeps nothing else): not the 50,000 events of all sessions
          const after = new Map<string, readonly AgentEvent[]>()
          const sources: Iterable<[string, readonly AgentEvent[]]> = sessionParam
            ? (eventBuffer.has(sessionParam) ? [[sessionParam, eventBuffer.get(sessionParam)!]] : [])
            : eventBuffer
          for (const [sid, events] of sources) after.set(sid, events.filter(e => (eventSeqs.get(e) ?? 0) > sinceSeq))
          buffers = after
        }
        const replay = capReplayBatches(
          buildReplayBatches(buffers, { session: sessionParam, primarySessionId: sorted[0]?.id }), {}, replayDropped,
          sinceSeq === null ? undefined : events => {
            for (const e of events) if (typeof e.sessionId === 'string' && (eventSeqs.get(e) ?? 0) > sinceSeq) addGap(e.sessionId, 1)
          },
        )
        if (sinceSeq !== null) {
          for (const sid of evictionLog.bySession.keys()) if (!sessionParam || sid === sessionParam) addGap(sid, evictedAfter(evictionLog, sid, sinceSeq))
        }
        // Tell the client how many events of each session this replay cannot give back (#366), before the replay
        // itself. Totals since the relay started, not per client: the client replaces its value on each connect.
        const loss: Record<string, number> = {}
        for (const [sid, n] of evictedCounts.bySession) if (n > 0 && (!sessionParam || sid === sessionParam)) loss[sid] = n
        for (const [sid, n] of replayDropped) loss[sid] = (loss[sid] ?? 0) + n
        const otherEvents = sessionParam ? 0 : evictedCounts.other
        const hasGap = Object.keys(gap).length > 0
        clientLoss.set(res, { evicted: { ...loss }, otherEvents })
        if (Object.keys(loss).length > 0 || otherEvents > 0 || hasGap) {
          sendSSE(res, { type: 'event-loss', evicted: loss, ...(otherEvents > 0 ? { otherEvents } : {}), ...(hasGap ? { gap } : {}) })
        }
        // Every buffered event numbered up to here is in the replay below or counted above (a first connection: evicted;
        // a reconnection: gap). Events of no session are never buffered nor counted. Sent once the replay is written
        // (below): a client cut during its replay gets no cursor and comes back with its previous one, so the events it
        // missed are still numbered after its `since`.
        const cursor = { type: 'relay-cursor', instance: relayInstance, seq: eventSeq }
        // The replay can exceed the slow-client backlog limit in one go (issue #203), so it is written as the socket
        // drains instead of dropping a healthy client mid-replay. Live messages arriving meanwhile wait behind it
        // (writeLive), keeping arrival order. The cursor follows the whole replay: the client may resume from there.
        writePaced(res, [...replay.map(batch => JSON.stringify(batch)), JSON.stringify(cursor)])
      }
      // The sessions that scan (or the start) found are attached over several ticks (#651): the client joins once
      // their attach ended, so they reach it once, through the list and the replay, as when attaching was synchronous.
      // The event loop is free meanwhile; a client gone before that never joins.
      const attaching = pipeline.whenAttached()
      if (!attaching) { join(); return }
      // Its slot is held from now: in the SSE cap and, through a tunnel, in the remote cap. Freed when it joins
      // (it is then in sseClients) or when it leaves before, so a client that reconnects in a loop holds one slot only
      const remote = hostClass === 'allowed'
      pendingSseClients++
      if (remote) pendingRemoteSseClients++
      let waiting = true
      waitingSseClients.add(res)
      const release = () => {
        if (!waiting) return
        waiting = false
        waitingSseClients.delete(res)
        pendingSseClients--
        if (remote) pendingRemoteSseClients--
        req.off('close', release)
        res.off('close', release)
      }
      req.once('close', release)
      res.once('close', release)
      void attaching.then(() => {
        const left = !waiting
        release()
        if (left || res.destroyed || relayDisposed) { clientSessionFilter.delete(res); return }
        join()
      })
    },

    debugState: () => ({
      sseClients: sseClients.size,
      remoteSseClients: remoteSseCount(),
      scanTimerActive: scanTicker?.active ?? false,
      runtimeScanTimerActive: runtimeScanTicker.active,
      systemTimerActive: systemTicker.active,
      heartbeatTimerActive: heartbeatTicker.active,
      scanRuns: scanCoalescer.runs,
      runtimeScanRuns,
      statusRuns: statusComputations,
      dedupSessions: reconciler.rememberedSessions,
      watchedSessions: sessions.size - importedSessions.size,
      wakeWatchers: projectDirWakeWatchers.size + subagentWakeWatchers.size,
      // A Claude attach queued or running (#651)
      attaching: pipeline.whenAttached() !== null,
    }),

    webhookStats: () => webhooks?.stats() ?? null,

    dispose() {
      // Defense in depth — server.ts already guards cleanup(), but direct
      // callers or hot-reload could call this twice.
      if (relayDisposed) return
      relayDisposed = true
      // Agents started from here do not outlive the relay (#229)
      launchSupervisor?.dispose()
      launchSessionSeen = null
      launchSnapshot = null
      launchKillAll = null
      heartbeatTicker.stop()
      systemTicker.stop()
      cpuCounters = null
      observations.dispose()
      webhooks?.dispose()
      webhooks = null
      const models = [...observedModels].sort().join(',').slice(0, 128)
      const runtimes = [wantClaude && 'claude', wantCodex && 'codex', wantCopilot && 'copilot', wantPi && 'pi', wantGemini && 'gemini', wantOpenCode && 'opencode'].filter(Boolean).join(',')
      telemetry?.emit({
        ...baseEvent(),
        event_type: 'session_end',
        duration_s: Math.round((Date.now() - sessionStart) / 1000),
        event_count: sessionEventCount,
        models: models || undefined,
        runtimes: runtimes || undefined,
      })
      if (wantClaude) {
        removeDiscoveryFile()
        hookServer?.setQuotaHandler(null)
        hookServer?.dispose()
        scanTicker?.stop()
        teamWatcher?.dispose()
        teamWatcher = null
        projectDirWatcher?.close()
        projectWatchScan?.dispose()
        for (const w of [...projectDirWakeWatchers.values(), ...[...subagentWakeWatchers.values()].map(s => s.w)]) { try { w.close() } catch {} }
        projectDirWakeWatchers.clear(); subagentWakeWatchers.clear(); wakeScan = null
        for (const session of sessions.values()) {
          session.fileWatcher?.close()
          if (session.pollTimer) clearInterval(session.pollTimer)
        }
      }
      runtimeScanTicker.stop()
      if (runtimeReleaseTimer) clearInterval(runtimeReleaseTimer)
      codexWatcher?.dispose()
      copilotWatcher?.dispose()
      piWatcher?.dispose()
      geminiWatcher?.dispose()
      openCodeWatcher?.dispose()
      for (const client of [...sseClients]) dropClient(client)
      for (const client of [...waitingSseClients]) dropClient(client)
      for (const id of [...sessions.keys()]) dropSession(id)
      eventBuffer.clear()
      historyPending.clear()
      historyPendingSet.clear()
      historyUnsent.clear()
      evictedCounts.bySession.clear()
      evictedCounts.other = 0
      evictionLog.bySession.clear()
      // A later relay in this process is another instance: a since of this one counts nothing there
      relayInstance = crypto.randomBytes(8).toString('hex')
      agentTracker.clear()
    },
  }
}
