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
import { AgentEvent, RelayStatus, SessionInfo, WatchedSession } from '../extension/src/protocol'
import { TranscriptParser } from '../extension/src/transcript-parser'
import { safeWatch, readTrackedLines, foldPathCase, runGuarded } from '../extension/src/fs-utils'
import { scanSubagentsDir, readSubagentNewLines, markTeammatesDone } from '../extension/src/subagent-watcher'
import { TeamWatcher, readSessionHeader, type TeamSessionTags } from '../extension/src/team-watcher'
import { handlePermissionDetection } from '../extension/src/permission-detection'
import { projectTags, branchTag } from '../extension/src/project-identity'
import { CodexSessionWatcher } from '../extension/src/codex-session-watcher'
import { CopilotSessionWatcher } from '../extension/src/copilot-session-watcher'
import { readSessionIndex, mergeIndexedSessions, withIndexedFacts, filterIndexedByWorkspace, type IndexOpener, type SessionIndexResult } from '../extension/src/session-index'
import {
  INACTIVITY_TIMEOUT_MS, SCAN_INTERVAL_MS, ACTIVE_SESSION_AGE_S, POLL_FALLBACK_MS,
  SESSION_ID_DISPLAY, SYSTEM_PROMPT_BASE_TOKENS, ORCHESTRATOR_NAME,
  HOOK_SERVER_NOT_STARTED, WORKSPACE_HASH_LENGTH,
  RELAY_MAX_SSE_CLIENTS, RELAY_SSE_HEARTBEAT_MS, RELAY_MAX_WATCHED_SESSIONS, RELAY_MAX_SESSION_FILE_BYTES,
  RELAY_STATUS_RATE_BURST, RELAY_STATUS_RATE_PER_S, RELAY_STATUS_RATE_MAX_KEYS,
  RELAY_ISSUE_LINKS_RATE_BURST, RELAY_ISSUE_LINKS_RATE_PER_S, RELAY_ISSUE_LINKS_CACHE_TTL_MS, RELAY_ISSUE_LINKS_CACHE_MAX_ROLES,
  RELAY_ISSUE_LINKS_MAX_GH_IN_FLIGHT, RELAY_ISSUE_LINKS_MAX_PROBES_PER_WINDOW, RELAY_ISSUE_LINKS_PROBE_WINDOW_MS,
  RELAY_SESSION_INDEX_CACHE_MS, SESSION_TAG_MAX, RELAY_CONTEXT_RATE_BURST, RELAY_CONTEXT_RATE_PER_S,
} from '../extension/src/constants'
import { claudeConfigDir, claudeProjectsDir, claudeTeamsDir, discoveryDir } from '../extension/src/claude-config-dir'
import { purgeStaleDiscoveryFiles } from '../extension/src/discovery-purge'
import { setLogLevel, createLogger } from '../extension/src/logger'
import { buildReplayBatches } from '../extension/src/event-replay'
import {
  parseSessionParam, isBackedUp, capReplayBatches, appendBounded, isTruthyFlag, statusRateKey,
  listProjectDirs, findActiveSessions, wakeColdFile, createColdScan, isValidSessionId, observationsRoute, isCrossOriginRequest,
} from '../extension/src/relay-guards'
import { isLoopbackAddress, isLoopbackHostHeader, KeyedRateLimiter } from '../extension/src/hook-guards'
import { isHooksConfigured } from '../extension/src/claude-settings'
import { createObservationsAction, AgentStateTracker } from '../extension/src/observations'
import { fetchIssueLinks, resolveRepoUrl, createRepoUrlCache, type IssueLink } from '../extension/src/issue-links'
import { EventReconciler, type EventSource } from '../extension/src/event-source-priority'
import { applySecurityHeaders, KeyedCoalescer, SharedTicker } from './server-hardening'
import type { TelemetryClient } from './telemetry'
import { createIssueLinksRoute } from './routes/issue-links'
import { createStatusRoute, type StatusSnapshot } from './routes/status'
import { createContextRoute } from './routes/context'
import { createObservationsRoute } from './routes/observations'

const DISCOVERY_DIR = discoveryDir()
const CLAUDE_DIR = claudeProjectsDir()
const TEAMS_DIR = claudeTeamsDir()

let relayCreated = false
let verbose = false
let sessionEventCount = 0
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

function log(...args: unknown[]) {
  if (verbose) console.log(...args)
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
const skippedSessions = { watchLimit: new Set<string>(), sizeLimit: new Set<string>() }

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

/** Drop a client: remove it from the set and destroy its connection (frees its buffers/listeners). */
function dropClient(res: http.ServerResponse) {
  sseClients.delete(res)
  clientSessionFilter.delete(res)
  replayHeld.delete(res)
  try { res.destroy() } catch { /* already closed */ }
}

/**
 * Live messages held for a client whose initial replay is still being written (issue #203). The replay
 * waits for 'drain' between batches, so live events arriving meanwhile are queued and sent after it,
 * in order, instead of overtaking older replayed events. Bounded: a client that cannot absorb the
 * replay before the held backlog exceeds the slow-client limit is dropped.
 */
const replayHeld = new WeakMap<http.ServerResponse, { payloads: string[]; bytes: number }>()

/** Live write path (broadcasts): held during the client's replay, otherwise written with the slow-client check. */
function writeLive(res: http.ServerResponse, payload: string) {
  const held = replayHeld.get(res)
  if (!held) return writeToClient(res, payload)
  held.payloads.push(payload)
  held.bytes += payload.length
  if (isBackedUp(held.bytes)) {
    log('[sse] Dropping client: live backlog overflowed during replay')
    dropClient(res)
  }
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
  for (const res of [...sseClients]) {
    const only = clientSessionFilter.get(res)
    if (only && sessionId && only !== sessionId) continue
    writeLive(res, data)
  }
}

// ─── Event buffering ────────────────────────────────────────────────────────

const eventBuffer = new Map<string, AgentEvent[]>()
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

function deliverEvent(event: AgentEvent) {
  sessionEventCount++
  if (event.type === 'model_detected') {
    const m = (event.payload as { model?: unknown } | undefined)?.model
    if (typeof m === 'string' && m.length > 0) observedModels.add(m)
  }
  const sid = event.sessionId?.slice(0, SESSION_ID_DISPLAY) || '?'
  log(`[event] ${event.type} (session ${sid})`)

  if (event.sessionId) {
    // Bounded per session, in number of sessions and in total events (see relay-guards.ts)
    appendBounded(eventBuffer, event.sessionId, event)
    agentTracker.ingest(event)
  }

  broadcast(JSON.stringify({ type: 'agent-event', event }), event.sessionId)
}

/** Untrusted text shown as a session tag: single line, no controls, capped. */
function tagText(value: string | undefined): string | undefined {
  if (!value) return undefined
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, SESSION_TAG_MAX)
  return clean || undefined
}

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
  const workspace = tagText(relayWorkspace)
  return {
    id: session.sessionId, label: session.label,
    status: session.sessionCompleted ? 'completed' : 'active',
    startTime: session.sessionStartTime, lastActivityTime: session.lastActivityTime,
    runtime: 'claude',
    ...(tags ? { teamName: tags.teamName, ...(tags.memberName ? { memberName: tags.memberName } : {}) } : {}),
    ...(workspace ? { workspace } : {}),
    ...(cwd ? { cwd } : {}),
    ...projectTags(sessionCwd.get(session.sessionId)),
    ...branchTag(sessionBranch.get(session.sessionId)),
  }
}

/** Adds the facts of the session index (declared parent, cwd) to a session entry; set up by createRelay. */
let enrichSession: (info: SessionInfo) => SessionInfo = info => info

function broadcastSessionLifecycle(type: 'started' | 'ended' | 'updated', sessionId: string, label: string) {
  if (type === 'started') {
    const live = sessions.get(sessionId)
    const base: SessionInfo = live
      ? toSessionInfo(live)
      : { id: sessionId, label, status: 'active', startTime: Date.now(), lastActivityTime: Date.now() }
    broadcast(JSON.stringify({
      type: 'session-started',
      session: enrichSession({ ...base, label, status: 'active', lastActivityTime: Date.now() } as SessionInfo),
    }), sessionId)
  } else if (type === 'ended') {
    broadcast(JSON.stringify({ type: 'session-ended', sessionId }), sessionId)
  } else if (type === 'updated') {
    const tags = teamWatcher?.getSessionTags(sessionId)
    broadcast(JSON.stringify({
      type: 'session-updated', sessionId, label,
      ...(tags ? { teamName: tags.teamName, ...(tags.memberName ? { memberName: tags.memberName } : {}) } : {}),
    }), sessionId)
  }
}

function onSessionTags(sessionId: string, _tags: TeamSessionTags | null) {
  const session = sessions.get(sessionId)
  if (session) broadcastSessionLifecycle('updated', sessionId, session.label)
}

// ─── Session watcher ────────────────────────────────────────────────────────

const sessions = new Map<string, WatchedSession>()

function elapsed(sessionId?: string): number {
  if (sessionId) {
    const session = sessions.get(sessionId)
    if (session) return (Date.now() - session.sessionStartTime) / 1000
  }
  return 0
}

function emitContextUpdate(agentName: string, session: WatchedSession, sessionId?: string) {
  const bd = session.contextBreakdown
  const total = bd.systemPrompt + bd.userMessages + bd.toolResults + bd.reasoning + bd.subagentResults
  broadcastEvent({
    time: elapsed(sessionId),
    type: 'context_update',
    payload: { agent: agentName, tokens: total, breakdown: { ...bd } },
    sessionId,
  })
}

function emitEvent(event: AgentEvent, sessionId?: string) {
  broadcastEvent(sessionId ? { ...event, sessionId } : event)
}

const parser = new TranscriptParser({
  emit: emitEvent,
  elapsed,
  getSession: (sessionId: string) => sessions.get(sessionId),
  fireSessionLifecycle: (event) => broadcastSessionLifecycle(event.type, event.sessionId, event.label),
  emitContextUpdate,
})

const watcherDelegate = {
  emit: emitEvent,
  elapsed,
  getSession: (sessionId: string) => sessions.get(sessionId),
  getLastActivityTime: (sessionId: string) => sessions.get(sessionId)?.lastActivityTime,
  resetInactivityTimer: (sessionId: string) => resetInactivityTimer(sessionId),
}

function resetInactivityTimer(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  const wasCompleted = session.sessionCompleted
  session.lastActivityTime = Date.now()
  session.sessionCompleted = false

  if (wasCompleted) {
    broadcastEvent({
      time: elapsed(sessionId),
      type: 'agent_spawn',
      payload: { name: ORCHESTRATOR_NAME, isMain: true, task: session.label, ...(session.model ? { model: session.model, modelSource: 'runtime' } : {}) },
      sessionId,
    })
    broadcastSessionLifecycle('started', sessionId, session.label)
  }

  if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
  session.inactivityTimer = setTimeout(() => {
    if (!session.sessionCompleted && session.sessionDetected) {
      log(`[session] ${sessionId.slice(0, SESSION_ID_DISPLAY)} inactive`)
      session.sessionCompleted = true
      // Teammates stay on screen but are finished with their lead (never agent_complete)
      markTeammatesDone(watcherDelegate, session, sessionId)
      broadcastEvent({
        time: elapsed(sessionId),
        type: 'agent_complete',
        payload: { name: ORCHESTRATOR_NAME, inactivity: true },
        sessionId,
      })
      broadcastSessionLifecycle('ended', sessionId, session.label)
    }
  }, INACTIVITY_TIMEOUT_MS)
}

/** Stop all watchers/timers of a session and forget it. */
function unwatchSession(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return
  session.fileWatcher?.close()
  session.subagentsDirWatcher?.close()
  if (session.pollTimer) clearInterval(session.pollTimer)
  if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
  if (session.permissionTimer) clearTimeout(session.permissionTimer)
  for (const sub of session.subagentWatchers.values()) {
    sub.watcher?.close()
    if (sub.permissionTimer) clearTimeout(sub.permissionTimer)
  }
  // Free per-session parser state (registries, link/dedupe sets) and team bookkeeping
  parser.clearSessionState(session.pendingToolCalls.keys(), sessionId)
  sessionCwd.delete(sessionId)
  sessionBranch.delete(sessionId)
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
  unwatchSession(sessionId)
  if (announced) broadcastSessionLifecycle('ended', sessionId, session.label)
}

/**
 * Make room for one more watched session. Only completed sessions idle for longer than
 * the discovery window are evicted (they cannot be rediscovered); returns false when full.
 */
function ensureWatchCapacity(): boolean {
  if (sessions.size < RELAY_MAX_WATCHED_SESSIONS) return true
  let victim: WatchedSession | undefined
  for (const s of sessions.values()) {
    if (!s.sessionCompleted || (Date.now() - s.lastActivityTime) / 1000 <= ACTIVE_SESSION_AGE_S) continue
    if (!victim || s.lastActivityTime < victim.lastActivityTime) victim = s
  }
  if (!victim) return false
  unwatchSession(victim.sessionId)
  return sessions.size < RELAY_MAX_WATCHED_SESSIONS
}

function watchSession(sessionId: string, filePath: string) {
  skippedSessions.watchLimit.delete(sessionId)
  skippedSessions.sizeLimit.delete(sessionId)
  const defaultLabel = `Session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`
  const session: WatchedSession = {
    sessionId, filePath,
    fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
    sessionStartTime: Date.now(),
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    seenMessageHashes: new Set(),
    sessionDetected: false, sessionCompleted: false,
    lastActivityTime: Date.now(),
    inactivityTimer: null,
    subagentWatchers: new Map(),
    spawnedSubagents: new Set(),
    inlineProgressAgents: new Set(),
    subagentsDirWatcher: null, subagentsDir: null,
    label: defaultLabel, labelSet: false,
    model: null,
    modelDetectedAgents: new Map(),
    permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: SYSTEM_PROMPT_BASE_TOKENS, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
  sessions.set(sessionId, session)
  const header = readSessionHeader(filePath)
  if (header.cwd) sessionCwd.set(sessionId, header.cwd)
  if (header.branch) sessionBranch.set(sessionId, header.branch)

  // The live flow (hooks) is already subscribed: events arriving while the history is read are held
  // and replayed, deduplicated against the history, when the load ends (issue #53).
  reconciler.withHistory(() => {
    const stat = fs.statSync(filePath)
    // Also positions the tail (fileSize, unfinished last line in fileTail) for readNewLines
    const catchUpEntries = parser.prescanExistingContent(filePath, stat.size, session)
    parser.extractSessionLabel(catchUpEntries, session)

    broadcastSessionLifecycle('started', sessionId, session.label)
    broadcastEvent({
      time: 0, type: 'agent_spawn',
      payload: { name: ORCHESTRATOR_NAME, isMain: true, task: session.label, ...(session.model ? { model: session.model, modelSource: 'runtime' } : {}) },
      sessionId,
    })
    session.sessionDetected = true

    emitContextUpdate(ORCHESTRATOR_NAME, session, sessionId)
    parser.emitCatchUpEntries(catchUpEntries, session, sessionId)
  })

  // An exception here would reach uncaughtException and stop the relay for every client (#206)
  const detachOnError = (err: unknown) => detachSessionOnError(sessionId, err)
  session.fileWatcher = safeWatch(filePath, (eventType) => {
    if (eventType === 'change') runGuarded(() => readNewLines(sessionId), detachOnError)
  })

  session.pollTimer = setInterval(() => runGuarded(() => {
    readNewLines(sessionId)
    for (const [subPath] of session.subagentWatchers) {
      readSubagentNewLines(watcherDelegate, parser, subPath, sessionId)
    }
    scanSubagentsDir(watcherDelegate, parser, sessionId)
  }, detachOnError), POLL_FALLBACK_MS)

  session.subagentsDir = path.join(path.dirname(filePath), sessionId, 'subagents')
  scanSubagentsDir(watcherDelegate, parser, sessionId)
  resetInactivityTimer(sessionId)

  log(`[session] Watching ${sessionId.slice(0, SESSION_ID_DISPLAY)} — "${session.label}"`)
}

function readNewLines(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  const lines = readTrackedLines(session.filePath, session)
  if (!lines) return
  // The size cap is also enforced after discovery: a transcript that grows past it is dropped.
  // Clients are told (session-ended), otherwise they keep showing it active and frozen (#208).
  if (session.fileSize > maxSessionFileBytes) {
    relayLog.warn(`Session ${sessionId.slice(0, SESSION_ID_DISPLAY)} exceeds ${maxSessionFileBytes} bytes — no longer watched`)
    noteSkipped('sizeLimit', sessionId)
    broadcastSessionLifecycle('ended', sessionId, session.label)
    unwatchSession(sessionId)
    return
  }
  for (const line of lines) {
    parser.processTranscriptLine(line, ORCHESTRATOR_NAME, session.pendingToolCalls, session.seenToolUseIds, sessionId, session.seenMessageHashes)
  }

  handlePermissionDetection(watcherDelegate, ORCHESTRATOR_NAME, session.pendingToolCalls, session, sessionId, session.sessionCompleted, true)
  scanSubagentsDir(watcherDelegate, parser, sessionId)
  resetInactivityTimer(sessionId)
}

// ─── Session scanner ────────────────────────────────────────────────────────

const coldScan = createColdScan()

// Transcripts froids (#211) : un événement de watch les réveille tout de suite, sinon ils sont réexaminés
// tous les COLD_RESCAN_CYCLES scans. Un watcher par dossier de projet (borné par RELAY_MAX_PROJECT_DIRS)
// et, pour les sessions inactives, un sur leur dossier subagents (borné par COLD_SUBAGENT_WATCH_MAX).
const COLD_SUBAGENT_WATCH_MAX = 64
const projectDirWakeWatchers = new Map<string, fs.FSWatcher>()
const subagentWakeWatchers = new Map<string, fs.FSWatcher>()
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

function watchIdleSubagentsDir(f: { sessionId: string; filePath: string; dirPath: string }) {
  if (subagentWakeWatchers.has(f.filePath) || subagentWakeWatchers.size >= COLD_SUBAGENT_WATCH_MAX) return
  const subagentsDir = path.join(f.dirPath, f.sessionId, 'subagents')
  if (!fs.existsSync(subagentsDir)) return
  const release = () => { try { subagentWakeWatchers.get(f.filePath)?.close() } catch {} subagentWakeWatchers.delete(f.filePath) }
  const w = safeWatch(subagentsDir, () => { release(); wakeAndRescan(wakeColdFile(coldScan, f.filePath)) }, { recursive: true }, release)
  if (w) subagentWakeWatchers.set(f.filePath, w)
}


function scanForActiveSessions(workspace: string, allWorkspaces = false) {
  if (!fs.existsSync(CLAUDE_DIR)) return

  let match: ((name: string) => boolean) | null = null
  if (!allWorkspaces) {
    let resolved = workspace
    try { resolved = fs.realpathSync(resolved) } catch {}
    const encoded = resolved.replace(/[^a-zA-Z0-9]/g, '-')
    // Case-folded on Windows — VS Code/shells report `c:\...` while Claude Code
    // encodes `C--...`, so exact string matching never found the project dir there.
    const encodedFolded = foldPathCase(encoded)
    match = (name) => {
      const nameFolded = foldPathCase(name)
      return nameFolded === encodedFolded || nameFolded.startsWith(encodedFolded + '-')
    }
  }
  // --all-workspaces: every real (non-symlink) project dir directly under ~/.claude/projects
  const dirsToScan = listProjectDirs(CLAUDE_DIR, match)

  coldScan.cycle++
  watchProjectDirsForWake(dirsToScan)
  const candidates = findActiveSessions({
    dirs: dirsToScan, maxFileBytes: maxSessionFileBytes, cold: coldScan, activeAgeS: ACTIVE_SESSION_AGE_S,
    skip: (id) => sessions.has(id),
    onIdle: watchIdleSubagentsDir,
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
    try { watchSession(c.sessionId, c.filePath) } catch (e) {
      unwatchSession(c.sessionId)
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
  /** Handle GET /issue-links?role=<role>: open PRs/issues labelled agent:<role> through gh (loopback only, rate-limited, cached) */
  handleIssueLinks: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
  /** Clean up all resources */
  dispose: () => void
  /** Counters for tests and diagnostics: connected clients, shared scan timer, refresh executions */
  debugState: () => { sseClients: number; scanTimerActive: boolean; heartbeatTimerActive: boolean; scanRuns: number; statusRuns: number; dedupSessions: number }
}

export type RelayRuntimeMode = 'claude' | 'codex' | 'copilot' | 'auto'

export interface RelayOptions {
  workspace: string
  verbose?: boolean
  telemetry?: TelemetryClient
  /** Which runtimes to watch. Defaults to AGENT_LENS_RUNTIME env var, or 'auto'.
   *  Mirrors the extension's `agentVisualizer.runtime` setting so users of the
   *  dev relay and `npx agent-lens-app` have a way to opt out of one runtime. */
  runtime?: RelayRuntimeMode
  /** Also discover Claude sessions from other workspaces (every project dir under
   *  ~/.claude/projects). Defaults to the AGENT_LENS_ALL_WORKSPACES env var (1/true). */
  allWorkspaces?: boolean
  /** Reads whether the hooks are configured for the workspace (GET /status). Injectable for tests;
   *  defaults to the settings-file check. Concurrent /status requests share ONE call. */
  hooksProbe?: (workspace: string) => Promise<boolean> | boolean
  /** Looks up the issues/PRs of an agent role (GET /issue-links). Injectable for tests; defaults to gh on the
   *  workspace's GitHub `origin`. Resolves [] only when there is truly no link; rejects when gh or git fails (the route answers 502, #205). */
  issueLinksProbe?: (role: string, cwd?: string) => Promise<IssueLink[]>
  /** Optional read-only session index (a local SQLite database), see session-index.ts. Defaults to the
   *  AGENT_LENS_SESSION_INDEX env var (file path). Its sessions are listed as completed, never as live. */
  sessionIndex?: RelaySessionIndexOptions
  /** Period of the SSE keep-alive (ms). Injectable for tests; defaults to RELAY_SSE_HEARTBEAT_MS. */
  sseHeartbeatMs?: number
  /** Transcript size past which a Claude session is not (or no longer) watched. Injectable for tests;
   *  defaults to RELAY_MAX_SESSION_FILE_BYTES. */
  maxSessionFileBytes?: number
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
  if (explicit === 'claude' || explicit === 'codex' || explicit === 'copilot' || explicit === 'auto') return explicit
  const raw = process.env.AGENT_LENS_RUNTIME
  return raw === 'claude' || raw === 'codex' || raw === 'copilot' ? raw : 'auto'
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
  relayCreated = true
  maxSessionFileBytes = options.maxSessionFileBytes ?? RELAY_MAX_SESSION_FILE_BYTES

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

  const allWorkspaces = options.allWorkspaces ?? isTruthyFlag(process.env.AGENT_LENS_ALL_WORKSPACES)
  const mode = resolveRuntimeMode(options.runtime)
  const wantClaude = mode === 'claude' || mode === 'auto'
  const wantCodex = mode === 'codex' || mode === 'auto'
  const wantCopilot = mode === 'copilot' || mode === 'auto'
  log(`[relay] Runtime mode: ${mode} (watching: ${[wantClaude && 'claude', wantCodex && 'codex', wantCopilot && 'copilot'].filter(Boolean).join(', ')})`)

  let hookServer: HookServer | null = null
  let scanTicker: SharedTicker | null = null
  let scanNow: (() => void) | null = null
  // Keep-alive (#141): one shared timer, running only while an SSE client is connected. EventSource hides SSE
  // comments from the page, so the beat is a data frame the web client reads as proof of life and discards.
  const heartbeatTicker = new SharedTicker(() => {
    // A client still receiving its replay gets data anyway, and a held beat would only arrive late
    for (const res of [...sseClients]) if (!replayHeld.has(res)) writeToClient(res, HEARTBEAT_PAYLOAD)
  }, options.sseHeartbeatMs ?? RELAY_SSE_HEARTBEAT_MS)
  const scanCoalescer = new KeyedCoalescer<void>()
  const statusCoalescer = new KeyedCoalescer<StatusSnapshot>()
  let statusComputations = 0
  let projectDirWatcher: fs.FSWatcher | null = null

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
      // The transcript parser emits agent_link/message_sent for watched sessions; hook copies would duplicate them
      if (TEAM_EVENTS.has(event.type) && event.sessionId && sessions.has(event.sessionId)) return
      if (!isOrchestrator && SUBAGENT_LIFECYCLE.has(event.type) && event.sessionId && sessions.has(event.sessionId)) return
      broadcastEvent(event, 'hook')
    })

    writeDiscoveryFile(hookPort, workspace)
    void purgeStaleDiscoveryFiles({ dir: DISCOVERY_DIR }).catch(() => {})

    scanForActiveSessions(workspace, allWorkspaces)
    // One shared interval for all SSE clients, stopped when the last one leaves (issue #68).
    // Without a client, new transcripts are still picked up by the project dir watcher and on connect.
    scanNow = () => {
      scanCoalescer.run('scan', () => scanForActiveSessions(workspace, allWorkspaces))
        .catch(e => log('[scan] Failed:', e))
    }
    wakeScan = scanNow
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
          time: elapsed(sessionId), type: 'team_info', payload: { ...payload }, sessionId,
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
    teamWatcher.start()

    const resolved = (() => { try { return fs.realpathSync(workspace) } catch { return workspace } })()
    const encoded = resolved.replace(/[^a-zA-Z0-9]/g, '-')
    const projectDir = path.join(CLAUDE_DIR, encoded)
    if (fs.existsSync(projectDir)) {
      try {
        projectDirWatcher = safeWatch(projectDir, (_eventType, filename) => {
          if (filename?.endsWith('.jsonl')) scanNow?.()
        })
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
      broadcastSessionLifecycle(lifecycle.type, lifecycle.sessionId, lifecycle.label)
    })
    codexWatcher.start()
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
      broadcastSessionLifecycle(lifecycle.type, lifecycle.sessionId, lifecycle.label)
    })
    copilotWatcher.start()
  }

  const telemetry = options.telemetry
  const sessionStart = Date.now()
  let relayDisposed = false
  const relaySessionId = `relay-${process.pid}-${Math.floor(sessionStart / 1000)}`
  sessionEventCount = 0

  const agentFlowVersion = resolveAgentLensVersion()

  const baseEvent = () => ({
    session_id: relaySessionId,
    agent_lens_version: agentFlowVersion,
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
    // Preserve default crash-on-uncaught behavior: log, then exit.
    console.error(err)
    process.exit(1)
  })

  const statusLimiter = new KeyedRateLimiter(RELAY_STATUS_RATE_BURST, RELAY_STATUS_RATE_PER_S, RELAY_STATUS_RATE_MAX_KEYS)
  const contextLimiter = new KeyedRateLimiter(RELAY_CONTEXT_RATE_BURST, RELAY_CONTEXT_RATE_PER_S, RELAY_STATUS_RATE_MAX_KEYS)
  const observationsLimiter = new KeyedRateLimiter(RELAY_STATUS_RATE_BURST, RELAY_STATUS_RATE_PER_S, RELAY_STATUS_RATE_MAX_KEYS)
  const issueLinksLimiter = new KeyedRateLimiter(RELAY_ISSUE_LINKS_RATE_BURST, RELAY_ISSUE_LINKS_RATE_PER_S, RELAY_STATUS_RATE_MAX_KEYS)
  const observations = createObservationsAction(() => {
    const list: SessionInfo[] = []
    for (const session of sessions.values()) if (session.sessionDetected) list.push(toSessionInfo(session))
    if (codexWatcher) list.push(...codexWatcher.getActiveSessions().map(s => ({ ...s, runtime: 'codex' })))
    if (copilotWatcher) list.push(...copilotWatcher.getActiveSessions())
    return { sessions: list, agents: agentTracker }
  })
  const hooksProbe = options.hooksProbe ?? defaultHooksProbe
  const runtimeList = [wantClaude && 'claude', wantCodex && 'codex', wantCopilot && 'copilot'].filter((r): r is string => typeof r === 'string')

  // Issue/PR links (#63): the repository is the workspace's own GitHub origin, resolved once per directory
  // One repository lookup per directory: a node's links come from the repository of its own session
  // A git failure is not kept: only a resolved repository is (#205)
  const repoUrlOf = createRepoUrlCache(dir => resolveRepoUrl(dir), RELAY_ISSUE_LINKS_CACHE_MAX_ROLES)
  const issueLinksProbe = options.issueLinksProbe ?? (async (role: string, cwd?: string): Promise<IssueLink[]> => {
    const repoUrl = await repoUrlOf(cwd ?? workspace)
    return repoUrl ? fetchIssueLinks(role, { repoUrl }) : []
  })

  // Routes HTTP : chacune dans scripts/routes/, derrière les mêmes gardes (guardedRoute)
  const handleIssueLinks = createIssueLinksRoute({
    limiter: issueLinksLimiter,
    allWorkspaces,
    cwdOf: sessionId => sessionCwd.get(sessionId) ?? readIndex()?.sessions.find(s => s.id === sessionId)?.cwd,
    probe: issueLinksProbe,
  })
  const handleStatus = createStatusRoute({
    limiter: statusLimiter,
    coalescer: statusCoalescer,
    computeSnapshot: async () => {
      statusComputations++
      const hooksConfigured = wantClaude ? await hooksProbe(workspace) : false
      let sessionCount = 0
      for (const session of sessions.values()) if (session.sessionDetected) sessionCount++
      if (codexWatcher) sessionCount += codexWatcher.getActiveSessions().length
      if (copilotWatcher) sessionCount += copilotWatcher.getActiveSessions().length
      return {
        sessionCount, hooksConfigured,
        skippedSessions: { watchLimit: skippedSessions.watchLimit.size, sizeLimit: skippedSessions.sizeLimit.size },
      }
    },
    base: { relayVersion: agentFlowVersion, workspace: normalizePath(workspace), runtimes: runtimeList, allWorkspaces },
    readIndex,
  })
  const handleContext = createContextRoute({
    limiter: contextLimiter,
    cwdOf: sessionId => sessions.has(sessionId) ? sessionCwd.get(sessionId) : undefined,
  })
  const handleObservations = createObservationsRoute({ limiter: observationsLimiter, observations })

  return {
    handleIssueLinks,
    handleStatus,
    handleContext,
    handleObservations,

    handleSSE(req: http.IncomingMessage, res: http.ServerResponse) {
      applySecurityHeaders(res, 'api')
      // Loopback only: reject non-local peers and foreign Host headers (DNS rebinding)
      if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHostHeader(req.headers.host)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden')
        return
      }
      const { session: sessionParam, invalid } = parseSessionParam(req.url)
      if (invalid) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('Invalid session parameter')
        return
      }
      if (sseClients.size >= RELAY_MAX_SSE_CLIENTS) {
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '5' })
        res.end('Too many clients')
        return
      }

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
      sseClients.add(res)
      log(`[sse] Client connected (${sseClients.size} total)`)
      // First client starts the shared scan timer; the last one leaving stops it
      const releaseTicker = scanTicker?.acquire()
      const releaseHeartbeat = heartbeatTicker.acquire()

      // Clean up on every way a connection can end; idempotent.
      let closed = false
      const onGone = () => {
        if (closed) return
        closed = true
        releaseTicker?.()
        releaseHeartbeat()
        sseClients.delete(res)
        clientSessionFilter.delete(res)
        replayHeld.delete(res)
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
      // Indexed sessions complete the list; a session that is also watched live keeps its live entry
      const indexed = readIndex()
      if (indexed) sessionList = mergeIndexedSessions(sessionList, indexed.sessions)
      if (sessionList.length > 0) {
        sendSSE(res, { type: 'session-list', sessions: sessionList })
      }

      // Replay buffered events: only the requested session with ?session=<id>,
      // otherwise every session's buffer (most recent active session last).
      const sorted = sessionList.filter(s => !s.indexedOnly).sort((a, b) => {
        const aActive = a.status === 'active' ? 1 : 0
        const bActive = b.status === 'active' ? 1 : 0
        if (aActive !== bActive) return bActive - aActive
        return b.lastActivityTime - a.lastActivityTime
      })
      // Volume is capped per session and in total (RELAY_MAX_REPLAY_*), newest events kept.
      const replay = capReplayBatches(buildReplayBatches(eventBuffer, { session: sessionParam, primarySessionId: sorted[0]?.id }))
      // The replay can exceed the slow-client backlog limit in one go (issue #203), so wait for the
      // socket to drain between batches instead of dropping a healthy client mid-replay. Live messages
      // arriving meanwhile are held (writeLive) and flushed after the replay, keeping arrival order.
      const held = { payloads: [] as string[], bytes: 0 }
      replayHeld.set(res, held)
      void (async () => {
        for (const batch of replay) {
          if (res.destroyed || closed || !replayHeld.has(res)) return
          sendSSE(res, batch)
          if (res.writableNeedDrain && !res.destroyed) {
            await new Promise<void>(resolve => {
              const done = () => { res.off('drain', done); res.off('close', done); resolve() }
              res.once('drain', done)
              res.once('close', done)
            })
          }
        }
        if (res.destroyed || closed || !replayHeld.has(res)) return
        replayHeld.delete(res)
        // Back on the live path: from here the slow-client limit applies to every write
        for (const payload of held.payloads) writeToClient(res, payload)
      })()
    },

    debugState: () => ({
      sseClients: sseClients.size,
      scanTimerActive: scanTicker?.active ?? false,
      heartbeatTimerActive: heartbeatTicker.active,
      scanRuns: scanCoalescer.runs,
      statusRuns: statusComputations,
      dedupSessions: reconciler.rememberedSessions,
    }),

    dispose() {
      // Defense in depth — server.ts already guards cleanup(), but direct
      // callers or hot-reload could call this twice.
      if (relayDisposed) return
      relayDisposed = true
      heartbeatTicker.stop()
      observations.dispose()
      const models = [...observedModels].sort().join(',').slice(0, 128)
      const runtimes = [wantClaude && 'claude', wantCodex && 'codex', wantCopilot && 'copilot'].filter(Boolean).join(',')
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
        hookServer?.dispose()
        scanTicker?.stop()
        teamWatcher?.dispose()
        teamWatcher = null
        projectDirWatcher?.close()
        for (const w of [...projectDirWakeWatchers.values(), ...subagentWakeWatchers.values()]) { try { w.close() } catch {} }
        projectDirWakeWatchers.clear(); subagentWakeWatchers.clear(); wakeScan = null
        for (const session of sessions.values()) {
          session.fileWatcher?.close()
          if (session.pollTimer) clearInterval(session.pollTimer)
          if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
        }
      }
      codexWatcher?.dispose()
      copilotWatcher?.dispose()
      for (const client of [...sseClients]) dropClient(client)
      for (const id of [...sessions.keys()]) unwatchSession(id)
      eventBuffer.clear()
      agentTracker.clear()
    },
  }
}
