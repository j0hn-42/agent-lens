/**
 * Subagent file watching logic extracted from SessionWatcher.
 *
 * Manages per-session subagent JSONL file discovery, tailing, and event emission.
 *
 * When inline progress events are active for a subagent (tracked via
 * session.inlineProgressAgents), the file watcher still tracks file position
 * but skips event emission to avoid duplicates. This allows seamless fallback
 * to file-based watching on reconnection when inline progress is no longer flowing.
 */

import * as fs from 'fs'
import * as path from 'path'
import { AgentEvent, SubagentState, WatchedSession, emitSubagentSpawn } from './protocol'
import {
  workflowRefFromPath, workflowIdOf, parseWorkflowMeta, workflowFallbackLabel, selectWorkflowTranscripts,
  isSafeTranscript, getWorkflowRegistry, WorkflowAgentTracker,
  type WorkflowGroup, type WorkflowEnv,
} from './workflow-group'
import {
  SESSION_ID_DISPLAY, ORCHESTRATOR_NAME, generateSubagentFallbackName, resolveSubagentChildName,
  SUBAGENT_ID_SUFFIX_LENGTH, TEAMMATE_MAX_PER_SESSION, TEAMMATE_META_MAX_BYTES, WORKFLOW_AGENT_TYPE,
  SUBAGENT_CATCH_UP_SPAWNS_MAX, ACTIVE_SESSION_AGE_S, SUBAGENT_WATCH_IDLE_MS,
} from './constants'
import { safeWatch, readTrackedLines, readLinesChunked, readJsonFileSafe, listSubagentTranscripts } from './fs-utils'
import {
  parseTeammateMeta, readTranscriptTail, selectReplayLines, TeammateTracker,
  type TeammateMeta,
} from './teammate'
import { TranscriptParser } from './transcript-parser'
import type { SubagentRecord } from './subagent-registry'
import { handlePermissionDetection, PermissionDetectionDelegate } from './permission-detection'
import { createLogger } from './logger'

const log = createLogger('SubagentWatcher')

export interface SubagentWatcherDelegate extends PermissionDetectionDelegate {
  getSession(sessionId: string): WatchedSession | undefined
  resetInactivityTimer(sessionId: string): void
}

/** What we can learn about a subagent from its transcript file name and sidecars. */
export interface SubagentFileInfo {
  /** Display label (description or subagent type) */
  label: string
  /** agent_id parsed from the `agent-<id>.jsonl` file name */
  agentId: string
  /** tool_use_id of the Agent/Task call that spawned it, when the files expose it */
  toolUseId?: string
  /** agent_id of the spawning subagent, when the files expose it (nested subagents) */
  parentAgentId?: string
  /** Set when the .meta.json describes an Agent Team teammate (in_process_teammate / teamName) */
  teammate?: TeammateMeta
  /** The .meta.json says the user stopped this subagent (`stoppedByUser: true`): an end proven on disk (#446) */
  stoppedByUser?: boolean
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

const TOOL_USE_HINT_KEYS = ['toolUseId', 'tool_use_id', 'parentToolUseID', 'parentToolUseId']
const PARENT_AGENT_HINT_KEYS = ['parentAgentId', 'parent_agent_id']

/** Read the first transcript line (bounded) — entries may carry parentToolUseID. */
function readFirstEntry(jsonlPath: string): Record<string, unknown> | undefined {
  try {
    const fd = fs.openSync(jsonlPath, 'r')
    try {
      const buf = Buffer.alloc(64 * 1024)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      const first = buf.toString('utf8', 0, n).split('\n')[0]
      const parsed: unknown = JSON.parse(first)
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
}

/**
 * Resolve label, agent id and parent hints for a subagent transcript.
 * The .meta.json sidecar wins; the first transcript entry is a fallback source for
 * parentToolUseID. Falls back to generateSubagentFallbackName for the label.
 */
export function resolveSubagentFileInfo(jsonlPath: string, fallbackIndex: number): SubagentFileInfo {
  const base = path.basename(jsonlPath, '.jsonl')
  const agentId = base.startsWith('agent-') ? base.slice('agent-'.length) : base
  let label = ''
  let toolUseId: string | undefined
  let parentAgentId: string | undefined
  let teammate: TeammateMeta | undefined
  let stoppedByUser = false
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json')
  // Size-capped, symlinks refused; the file may not exist for older Claude Code versions
  const meta = readJsonFileSafe(metaPath, TEAMMATE_META_MAX_BYTES)
  const wf = workflowRefFromPath(jsonlPath)
  if (wf) {
    // Workflow agent (#79): identity comes from the path; the label only from the sidecar's description
    // (never from transcript content), and no spawn hints: the parent is always the orchestrator.
    const wm = parseWorkflowMeta(meta)
    label = wm.label ?? workflowFallbackLabel(agentId)
    teammate = {
      name: label, teamName: wf.name, agentType: WORKFLOW_AGENT_TYPE, teamKind: 'workflow',
      ...(wm.phase ? { phase: wm.phase } : {}),
    }
    return { label, agentId, teammate }
  }
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const rec = meta as Record<string, unknown>
    teammate = parseTeammateMeta(rec) ?? undefined
    const name = teammate ? teammate.name : resolveSubagentChildName(rec)
    if (name && name !== 'subagent') label = name
    toolUseId = pickString(rec, TOOL_USE_HINT_KEYS)
    parentAgentId = pickString(rec, PARENT_AGENT_HINT_KEYS)
    stoppedByUser = rec.stoppedByUser === true
  }
  if (!toolUseId || !parentAgentId) {
    const first = readFirstEntry(jsonlPath)
    if (first) {
      toolUseId = toolUseId ?? pickString(first, TOOL_USE_HINT_KEYS)
      parentAgentId = parentAgentId ?? pickString(first, PARENT_AGENT_HINT_KEYS)
    }
  }
  return { label: label || generateSubagentFallbackName('', fallbackIndex), agentId, toolUseId, parentAgentId, ...(teammate ? { teammate } : {}), ...(stoppedByUser ? { stoppedByUser } : {}) }
}

/** Scan the subagents directory for new JSONL files and start tailing them */
export function scanSubagentsDir(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  sessionId: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session || !session.subagentsDir) return

  // Start watching the directory itself once it exists
  if (!session.subagentsDirWatcher && fs.existsSync(session.subagentsDir)) {
    try {
      session.subagentsDirWatcher = safeWatch(session.subagentsDir, () => {
        scanSubagentsDir(delegate, parser, sessionId)
      })
    } catch (err) { log.debug('Subagent dir watch failed:', err) }
  }

  const subDir = session.subagentsDir
  if (!fs.existsSync(subDir)) return

  try {
    // Includes workflows/<wf_id>/agent-*.jsonl (Workflow tool agents); the dir watch is not recursive,
    // the periodic rescan picks the workflow files up. Workflow transcripts are capped per workflow and
    // per session, and must be regular files that stay inside the subagents directory.
    const selection = selectWorkflowTranscripts(listSubagentTranscripts(subDir), subDir)
    const fresh = selection.files
      .filter(filePath => !session.subagentWatchers.has(filePath))
      .filter(filePath => !workflowIdOf(filePath) || isSafeTranscript(filePath, subDir))
    // Start parents before children so a nested subagent can resolve its parent's name
    const isNested = (filePath: string) => (fresh.length > 1 && resolveSubagentFileInfo(filePath, 0).parentAgentId) ? 1 : 0
    const ordered = fresh.map(filePath => ({ filePath, rank: isNested(filePath) })).sort((x, y) => x.rank - y.rank)
    // The parents' catch-up spawns (#446) go out before a child is started: a child with pending work is
    // announced at once, and its parent must already exist on the web side to be its parent there
    for (const { filePath } of ordered.filter(o => o.rank === 0)) startWatchingSubagentFile(delegate, parser, filePath, sessionId)
    emitCatchUpSpawns(delegate, parser, session, sessionId)
    for (const { filePath } of ordered.filter(o => o.rank === 1)) startWatchingSubagentFile(delegate, parser, filePath, sessionId)
    emitCatchUpSpawns(delegate, parser, session, sessionId)
    tickWorkflowGroups(delegate, session, sessionId, selection.workflows)
    releaseIdleSubagentWatchers(parser, session, sessionId)
  } catch (err) { log.debug('Subagent dir scan failed:', err) }
}

/**
 * The spawns owed to subagents whose dispatch was read from the history and shows no end (#446): the
 * prescan registered them without emitting anything. Emitted in dispatch order, at most
 * SUBAGENT_CATCH_UP_SPAWNS_MAX per session; beyond it, readSubagentNewLines announces a subagent on its
 * first new line (still only while its dispatch shows no end). Runs before any line of theirs is emitted.
 */
function emitCatchUpSpawns(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  session: WatchedSession,
  sessionId: string,
): void {
  const registry = parser.getSubagentRegistry(sessionId)
  const owed: Array<{ state: SubagentState; record: SubagentRecord; order: number }> = []
  for (const state of session.subagentWatchers.values()) {
    if (!state.catchUpSpawn) continue
    state.catchUpSpawn = false
    const record = state.agentId ? registry.getByFileKey(state.agentId) : undefined
    if (!record || record.historyOrder === undefined || state.spawnEmitted) continue
    owed.push({ state, record, order: record.historyOrder })
  }
  owed.sort((a, b) => a.order - b.order)
  let deferred = 0
  for (const { state, record } of owed) {
    if ((session.catchUpSpawns ?? 0) >= SUBAGENT_CATCH_UP_SPAWNS_MAX) { deferred++; continue }
    session.catchUpSpawns = (session.catchUpSpawns ?? 0) + 1
    state.spawnEmitted = true
    spawnFromRecord(delegate, session, record, sessionId)
  }
  if (deferred > 0) {
    log.warn(`${deferred} running subagent(s) beyond the ${SUBAGENT_CATCH_UP_SPAWNS_MAX} announced at attach (session ${sessionId.slice(0, SESSION_ID_DISPLAY)}): each is announced on its next transcript line`)
  }
}

function spawnFromRecord(
  delegate: SubagentWatcherDelegate,
  session: WatchedSession,
  record: SubagentRecord,
  sessionId: string,
): void {
  record.spawned = true
  record.historyOrder = undefined
  session.spawnedSubagents.add(record.name)
  emitSubagentSpawn(delegate, record.parentName, record.name, record.label, sessionId, {
    label: record.label,
    ...(record.toolUseId ? { toolUseId: record.toolUseId } : {}),
  })
}

function startWatchingSubagentFile(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  filePath: string,
  sessionId: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session) return

  // Resolve identity from the meta file / first entry, then bind to the dispatch
  // (tool_use_id) that spawned it so same-description subagents stay distinct.
  const info = resolveSubagentFileInfo(filePath, session.subagentWatchers.size + 1)
  const registry = parser.getSubagentRegistry(sessionId)
  const parentRecord = info.parentAgentId ? registry.getByFileKey(info.parentAgentId) : undefined
  const record = registry.claimForFile(info.agentId, info.label, {
    toolUseId: info.toolUseId,
    parentName: parentRecord?.name,
  })
  const isWorkflow = info.teammate?.teamKind === 'workflow'
  // Workflow agents are bounded by the per-workflow / per-session selection instead
  const isTeammate = !!info.teammate && (isWorkflow || countTeammates(session) < TEAMMATE_MAX_PER_SESSION)
  if (isTeammate && (record.name !== info.label || info.label === ORCHESTRATOR_NAME)) {
    // Name collision (a respawned teammate, an ordinary subagent with the same label): keep names unique
    record.name = `${info.label}-${info.agentId.slice(-SUBAGENT_ID_SUFFIX_LENGTH)}`
  }
  const agentName = record.name
  log.info(`Tailing subagent: ${path.basename(filePath)} as "${agentName}" (session ${sessionId.slice(0, SESSION_ID_DISPLAY)})`)

  const state: SubagentState = {
    watcher: null,
    fileSize: 0,
    fileTail: '',
    agentName,
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    permissionTimer: null,
    permissionEmitted: false,
    spawnEmitted: false,
    agentId: info.agentId,
  }
  session.subagentWatchers.set(filePath, state)

  if (isTeammate && info.teammate) {
    const ref = isWorkflow ? workflowRefFromPath(filePath) : null
    if (ref) {
      const group = getWorkflowRegistry(session)!.groupFor(ref, info.teammate.teamName)
      group.members.set(filePath, state)
      // The group name is unique within the session: members must carry it, not the raw script name
      startTeammate(delegate, parser, session, state, record, { ...info.teammate, teamName: group.name }, info, filePath, sessionId, group)
      return
    }
    startTeammate(delegate, parser, session, state, record, info.teammate, info, filePath, sessionId)
    return
  }

  // Pre-scan existing content for dedup IDs and determine if the subagent
  // is still active (has unmatched tool_use blocks = pending work).
  // Bounded by the stat size (a tool_use written later must stay out of the dedup set, the tail
  // emits it) and streamed in chunks; an unfinished last line is kept in fileTail.
  const pendingToolUseIds = new Set<string>()
  let mtimeMs: number | undefined
  try {
    const stat = fs.statSync(filePath)
    mtimeMs = stat.mtimeMs
    for (const line of readLinesChunked(filePath, stat.size, undefined, state)) {
      if (!line.trim()) continue
      try {
        const raw: unknown = JSON.parse(line)
        const message = isObject(raw) ? raw.message : undefined
        const content = isObject(message) ? message.content : undefined
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (!isObject(block)) continue
          if (block.type === 'tool_use' && typeof block.id === 'string' && block.id) {
            state.seenToolUseIds.add(block.id)
            pendingToolUseIds.add(block.id)
          } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            pendingToolUseIds.delete(block.tool_use_id)
          }
        }
      } catch { /* skip unparseable subagent transcript lines */ }
    }
  } catch (err) { log.debug('Subagent initial read failed:', err) }

  // Only emit spawn for subagents that are still active (have pending work)
  // AND haven't already been spawned by the transcript parser.
  const alreadySpawned = record.spawned || session.spawnedSubagents.has(agentName)
  state.spawnEmitted = pendingToolUseIds.size > 0 || alreadySpawned
  if (pendingToolUseIds.size > 0 && !alreadySpawned) {
    spawnFromRecord(delegate, session, record, sessionId)
  }
  // Dispatched in the history (#446): `spawned` comes from the prescan, nothing was emitted. Its spawn is
  // owed while the history shows no end (emitCatchUpSpawns); an ended one is never brought back here,
  // nor one whose meta says the user stopped it (no task notification is written for that stop), nor a
  // file bound to its dispatch by the label alone (which dispatch it belongs to is not proven).
  if (record.historyOrder !== undefined) {
    if (record.toolUseId && !info.stoppedByUser && record.boundBy !== 'label' && parser.isSubagentDispatchOpen(session, record.toolUseId)) {
      state.spawnEmitted = false
      // Announced at attach only if its file was written within ACTIVE_SESSION_AGE_S; an older one waits for
      // its next line (readSubagentNewLines), still only while its dispatch shows no end
      const recent = mtimeMs !== undefined && Date.now() - mtimeMs <= ACTIVE_SESSION_AGE_S * 1000
      if (recent) state.catchUpSpawn = true
    } else {
      record.historyOrder = undefined
    }
  }

  // Watch for new content
  state.lastWriteMs = mtimeMs ?? Date.now()
  armSubagentWatcher(delegate, parser, state, filePath, sessionId)
}

function armSubagentWatcher(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  state: SubagentState,
  filePath: string,
  sessionId: string,
): void {
  try {
    state.watcher = safeWatch(filePath, () => {
      readSubagentNewLines(delegate, parser, filePath, sessionId)
    })
  } catch (err) { log.debug('Subagent file watch failed:', err) }
}

/**
 * Close the fs.watch of the subagents that are no longer active (#654): nothing written for
 * SUBAGENT_WATCH_IDLE_MS and no open dispatch. The state stays (offset, dedup ids); the poll keeps reading
 * the file, so a subagent resumed later is still seen, and its first new line re-arms the watcher.
 * Teammates and workflow agents follow the same rule once their tracker no longer reports them working
 * (the workflow ones are the bulk of the watchers of a loaded session).
 */
function releaseIdleSubagentWatchers(parser: TranscriptParser, session: WatchedSession, sessionId: string, now = Date.now()): void {
  const registry = parser.getSubagentRegistry(sessionId)
  for (const state of session.subagentWatchers.values()) {
    if (!state.watcher || state.lastWriteMs === undefined) continue
    if (now - state.lastWriteMs < SUBAGENT_WATCH_IDLE_MS) continue
    // Teammates and workflow agents are judged by their tracker: working (open tool, recent write) keeps the watcher
    if (state.teammate && state.teammate.tracker.activity(now) === 'working') continue
    const record = state.agentId ? registry.getByFileKey(state.agentId) : undefined
    if (record?.toolUseId && parser.isSubagentDispatchOpen(session, record.toolUseId)) continue
    try { state.watcher.close() } catch { /* already closed */ }
    state.watcher = null
  }
}

function countTeammates(session: WatchedSession): number {
  let n = 0
  for (const sub of session.subagentWatchers.values()) if (sub.teammate && sub.teammate.meta.teamKind !== 'workflow') n++
  return n
}

/**
 * First discovery of an in-process teammate: ALWAYS announce it (also when idle or finished),
 * replay its recent history (last TEAMMATE_REPLAY_MAX_MESSAGES entries, at most
 * TEAMMATE_REPLAY_MAX_BYTES read from the end of the file), report its activity, then tail it.
 */
function startTeammate(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  session: WatchedSession,
  state: SubagentState,
  record: SubagentRecord,
  meta: TeammateMeta,
  info: SubagentFileInfo,
  filePath: string,
  sessionId: string,
  workflow?: WorkflowGroup,
): void {
  let mtimeMs = Date.now()
  try { mtimeMs = fs.statSync(filePath).mtimeMs } catch { /* vanished */ }
  const tracker = workflow ? new WorkflowAgentTracker(mtimeMs, workflow, info.agentId) : new TeammateTracker(mtimeMs)
  state.teammate = { meta, tracker, spawned: false }

  const tail = readTranscriptTail(filePath)
  state.fileSize = tail.size
  for (const line of tail.lines) tracker.feed(line, mtimeMs)

  const agentName = state.agentName
  const alreadySpawned = record.spawned || session.spawnedSubagents.has(agentName)
  const spawnExtras = {
    kind: 'teammate',
    teamName: meta.teamName,
    ...(meta.teamKind ? { teamKind: meta.teamKind } : {}),
    ...(meta.color ? { color: meta.color } : {}),
    ...(meta.agentType ? { agentType: meta.agentType } : {}),
    backendType: 'in-process',
    ...(meta.model ? { model: meta.model, modelSource: 'configured' } : {}),
  }
  // Workflow agents hang off the orchestrator; teammates off whoever dispatched them
  const parent = workflow ? ORCHESTRATOR_NAME : record.parentName ?? ORCHESTRATOR_NAME
  record.spawned = true
  session.spawnedSubagents.add(agentName)
  if (alreadySpawned) {
    // The transcript parser announced the dispatch already; upgrade the node with teammate fields
    delegate.emit({
      time: delegate.elapsed(sessionId),
      type: 'agent_spawn',
      payload: { name: agentName, parent, task: meta.name, label: meta.name, ...(record.toolUseId ? { toolUseId: record.toolUseId } : {}), ...spawnExtras },
    }, sessionId)
  } else {
    emitSubagentSpawn(delegate, parent, agentName, meta.name, sessionId, {
      label: meta.name,
      ...(record.toolUseId ? { toolUseId: record.toolUseId } : {}),
    }, spawnExtras)
  }
  state.spawnEmitted = true
  state.teammate.spawned = true
  log.info(`${workflow ? 'Workflow agent' : 'Teammate'} "${agentName}" (${meta.teamName}) discovered from ${info.agentId}`)

  for (const line of selectReplayLines(tail.lines)) {
    parser.processTranscriptLine(line, agentName, state.pendingToolCalls, state.seenToolUseIds, sessionId)
  }
  emitTeammateActivity(delegate, state, sessionId)

  state.lastWriteMs = mtimeMs
  armSubagentWatcher(delegate, parser, state, filePath, sessionId)
}

/** Emit agent_activity when a teammate's activity changed since the last emission. */
export function emitTeammateActivity(
  delegate: SubagentWatcherDelegate,
  state: SubagentState,
  sessionId: string,
  now = Date.now(),
): void {
  const tm = state.teammate
  if (!tm) return
  const activity = tm.tracker.activity(now)
  if (tm.lastActivity === activity) return
  tm.lastActivity = activity
  delegate.emit({
    time: delegate.elapsed(sessionId),
    type: 'agent_activity',
    payload: { name: state.agentName, activity },
  }, sessionId)
}

/**
 * Mark teammates 'done' (team config dropped the member, or the lead session ended).
 * Never emits agent_complete: a teammate stays visible. Any new transcript line revives it.
 * With `names` only the matching teammates (by display name) are marked.
 */
export function markTeammatesDone(
  delegate: SubagentWatcherDelegate,
  session: WatchedSession,
  sessionId: string,
  names?: ReadonlySet<string>,
): void {
  for (const state of session.subagentWatchers.values()) {
    const tm = state.teammate
    if (!tm) continue
    // The team config knows nothing about workflow agents: only the session end finishes them
    if (names && (tm.meta.teamKind === 'workflow' || (!names.has(state.agentName) && !names.has(tm.meta.name)))) continue
    tm.tracker.done = true
    emitTeammateActivity(delegate, state, sessionId)
  }
}

/** Re-announce teammate activity (replay for a newly connected webview). */
export function replayTeammates(delegate: SubagentWatcherDelegate, session: WatchedSession, sessionId: string): void {
  for (const state of session.subagentWatchers.values()) {
    if (state.teammate) state.teammate.lastActivity = undefined
    emitTeammateActivity(delegate, state, sessionId)
  }
  const registry = getWorkflowRegistry(session, false)
  if (registry) registry.replay(workflowEnv(delegate, session, sessionId))
}

function workflowEnv(delegate: SubagentWatcherDelegate, session: WatchedSession, sessionId: string): WorkflowEnv {
  return {
    sessionId,
    alive: () => delegate.getSession(sessionId) === session,
    emitTeamInfo: payload => delegate.emit({
      time: delegate.elapsed(sessionId), type: 'team_info', payload: { ...payload },
    }, sessionId),
    emitActivity: (state, now) => emitTeammateActivity(delegate, state, sessionId, now),
  }
}

/**
 * Periodic pass over the workflow groups of a session (runs from every directory scan, which the
 * poll timers drive): member activity, journal changes, debounced team_info, and release of finished
 * workflows that fell out of the per-session cap.
 */
function tickWorkflowGroups(
  delegate: SubagentWatcherDelegate,
  session: WatchedSession,
  sessionId: string,
  selected: ReadonlySet<string>,
): void {
  const registry = getWorkflowRegistry(session, false)
  if (!registry || registry.groups.size === 0) return
  for (const group of registry.prune(selected)) {
    for (const filePath of group.members.keys()) {
      session.subagentWatchers.get(filePath)?.watcher?.close()
      session.subagentWatchers.delete(filePath)
    }
  }
  registry.tick(workflowEnv(delegate, session, sessionId))
}

export function readSubagentNewLines(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  filePath: string,
  sessionId: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session) return
  const state = session.subagentWatchers.get(filePath)
  if (!state) return

  const lines = readTrackedLines(filePath, state)
  if (!lines) {
    // No new bytes: a teammate may still turn idle once the recent-write window passes
    emitTeammateActivity(delegate, state, sessionId)
    return
  }
  // New bytes: the subagent is active, a watcher closed while it was idle is armed again
  state.lastWriteMs = Date.now()
  if (!state.watcher) armSubagentWatcher(delegate, parser, state, filePath, sessionId)
  if (state.teammate) {
    let mtime = Date.now()
    try { mtime = fs.statSync(filePath).mtimeMs } catch { /* vanished */ }
    for (const line of lines) state.teammate.tracker.feed(line, mtime)
  }

  // If inline progress events are handling this subagent, skip event emission
  // from the file watcher to avoid duplicates. We still advance fileSize above
  // so that if inline progress stops (e.g. reconnection), we resume from the
  // correct position without re-emitting old events.
  if (session.inlineProgressAgents.has(state.agentName)) {
    // Still keep the session alive — the subagent is working
    emitTeammateActivity(delegate, state, sessionId)
    delegate.resetInactivityTimer(sessionId)
    return
  }

  // Lazily emit spawn on first new content if not already emitted
  if (!state.spawnEmitted) {
    state.spawnEmitted = true
    state.catchUpSpawn = false
    const record = state.agentId ? parser.getSubagentRegistry(sessionId).getByFileKey(state.agentId) : undefined
    if (record?.historyOrder !== undefined) {
      // Owed since the attach, beyond SUBAGENT_CATCH_UP_SPAWNS_MAX (#446): announced only while its dispatch shows no end
      if (record.toolUseId && parser.isSubagentDispatchOpen(session, record.toolUseId)) spawnFromRecord(delegate, session, record, sessionId)
      else record.historyOrder = undefined
    } else if (record) {
      if (!record.spawned && !session.spawnedSubagents.has(record.name)) spawnFromRecord(delegate, session, record, sessionId)
    } else if (!session.spawnedSubagents.has(state.agentName)) {
      session.spawnedSubagents.add(state.agentName)
      emitSubagentSpawn(delegate, ORCHESTRATOR_NAME, state.agentName, state.agentName, sessionId)
    }
  }

  for (const line of lines) {
    parser.processTranscriptLine(line, state.agentName, state.pendingToolCalls, state.seenToolUseIds, sessionId)
  }

  // Permission detection for subagent tools
  handlePermissionDetection(delegate, state.agentName, state.pendingToolCalls, state, sessionId)
  emitTeammateActivity(delegate, state, sessionId)

  // Keep main session alive while subagents are working
  delegate.resetInactivityTimer(sessionId)
}
