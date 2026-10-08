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
} from './constants'
import { readTrackedLines, readJsonFileSafe, listSubagentTranscripts } from './fs-utils'
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
  }
  if (!toolUseId || !parentAgentId) {
    const first = readFirstEntry(jsonlPath)
    if (first) {
      toolUseId = toolUseId ?? pickString(first, TOOL_USE_HINT_KEYS)
      parentAgentId = parentAgentId ?? pickString(first, PARENT_AGENT_HINT_KEYS)
    }
  }
  return { label: label || generateSubagentFallbackName('', fallbackIndex), agentId, toolUseId, parentAgentId, ...(teammate ? { teammate } : {}) }
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
      session.subagentsDirWatcher = fs.watch(session.subagentsDir, () => {
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
    for (const { filePath } of ordered) {
      startWatchingSubagentFile(delegate, parser, filePath, sessionId)
    }
    tickWorkflowGroups(delegate, session, sessionId, selection.workflows)
  } catch (err) { log.debug('Subagent dir scan failed:', err) }
}

function spawnFromRecord(
  delegate: SubagentWatcherDelegate,
  session: WatchedSession,
  record: SubagentRecord,
  sessionId: string,
): void {
  record.spawned = true
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
  const pendingToolUseIds = new Set<string>()
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > 0) {
      const content = fs.readFileSync(filePath, 'utf-8')
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const raw: unknown = JSON.parse(line.trim())
          const entry = raw as { message?: { content?: Array<{ type: string; id?: string; tool_use_id?: string }> } }
          if (raw && typeof raw === 'object' && entry.message && Array.isArray(entry.message.content)) {
            for (const block of entry.message.content) {
              if (block.type === 'tool_use' && block.id) {
                state.seenToolUseIds.add(block.id)
                pendingToolUseIds.add(block.id)
              } else if (block.type === 'tool_result' && block.tool_use_id) {
                pendingToolUseIds.delete(block.tool_use_id)
              }
            }
          }
        } catch { /* skip unparseable subagent transcript lines */ }
      }
      state.fileSize = stat.size
    }
  } catch (err) { log.debug('Subagent initial read failed:', err) }

  // Only emit spawn for subagents that are still active (have pending work)
  // AND haven't already been spawned by the transcript parser.
  const alreadySpawned = record.spawned || session.spawnedSubagents.has(agentName)
  state.spawnEmitted = pendingToolUseIds.size > 0 || alreadySpawned
  if (pendingToolUseIds.size > 0 && !alreadySpawned) {
    spawnFromRecord(delegate, session, record, sessionId)
  }

  // Watch for new content
  try {
    state.watcher = fs.watch(filePath, () => {
      readSubagentNewLines(delegate, parser, filePath, sessionId)
    })
  } catch (err) { log.debug('Subagent file watch failed:', err) }
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

  try {
    state.watcher = fs.watch(filePath, () => {
      readSubagentNewLines(delegate, parser, filePath, sessionId)
    })
  } catch (err) { log.debug('Teammate file watch failed:', err) }
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
    const record = state.agentId ? parser.getSubagentRegistry(sessionId).getByFileKey(state.agentId) : undefined
    if (record) {
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
