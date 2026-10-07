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
import { SESSION_ID_DISPLAY, ORCHESTRATOR_NAME, generateSubagentFallbackName, resolveSubagentChildName } from './constants'
import { readNewFileLines } from './fs-utils'
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
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json')
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>
    const name = resolveSubagentChildName(meta)
    if (name && name !== 'subagent') label = name
    toolUseId = pickString(meta, TOOL_USE_HINT_KEYS)
    parentAgentId = pickString(meta, PARENT_AGENT_HINT_KEYS)
  } catch { /* meta file may not exist for older Claude Code versions */ }
  if (!toolUseId || !parentAgentId) {
    const first = readFirstEntry(jsonlPath)
    if (first) {
      toolUseId = toolUseId ?? pickString(first, TOOL_USE_HINT_KEYS)
      parentAgentId = parentAgentId ?? pickString(first, PARENT_AGENT_HINT_KEYS)
    }
  }
  return { label: label || generateSubagentFallbackName('', fallbackIndex), agentId, toolUseId, parentAgentId }
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
    const fresh = fs.readdirSync(subDir)
      .filter(file => file.endsWith('.jsonl'))
      .map(file => path.join(subDir, file))
      .filter(filePath => !session.subagentWatchers.has(filePath))
    // Start parents before children so a nested subagent can resolve its parent's name
    const isNested = (filePath: string) => (fresh.length > 1 && resolveSubagentFileInfo(filePath, 0).parentAgentId) ? 1 : 0
    const ordered = fresh.map(filePath => ({ filePath, rank: isNested(filePath) })).sort((x, y) => x.rank - y.rank)
    for (const { filePath } of ordered) {
      startWatchingSubagentFile(delegate, parser, filePath, sessionId)
    }
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
  const agentName = record.name
  log.info(`Tailing subagent: ${path.basename(filePath)} as "${agentName}" (session ${sessionId.slice(0, SESSION_ID_DISPLAY)})`)

  const state: SubagentState = {
    watcher: null,
    fileSize: 0,
    agentName,
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    permissionTimer: null,
    permissionEmitted: false,
    spawnEmitted: false,
    agentId: info.agentId,
  }
  session.subagentWatchers.set(filePath, state)

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

  const result = readNewFileLines(filePath, state.fileSize)
  if (!result) return
  state.fileSize = result.newSize

  // If inline progress events are handling this subagent, skip event emission
  // from the file watcher to avoid duplicates. We still advance fileSize above
  // so that if inline progress stops (e.g. reconnection), we resume from the
  // correct position without re-emitting old events.
  if (session.inlineProgressAgents.has(state.agentName)) {
    // Still keep the session alive — the subagent is working
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

  for (const line of result.lines) {
    parser.processTranscriptLine(line, state.agentName, state.pendingToolCalls, state.seenToolUseIds, sessionId)
  }

  // Permission detection for subagent tools
  handlePermissionDetection(delegate, state.agentName, state.pendingToolCalls, state, sessionId)

  // Keep main session alive while subagents are working
  delegate.resetInactivityTimer(sessionId)
}
