/**
 * In-process Agent Team teammates (#42).
 *
 * A teammate runs as a sidechain: <session>/subagents/agent-<id>.jsonl plus an
 * agent-<id>.meta.json sidecar { name, agentType, teamName, color, taskKind, ... }.
 * Unlike ordinary subagents a teammate stays on screen when it is idle or finished, so this
 * module holds the pure pieces: sidecar validation, activity tracking and bounded history
 * replay. No vscode dependency; everything read from disk is untrusted.
 */
import * as fs from 'fs'
import type { AgentActivity } from './protocol'
import {
  TEAMMATE_RECENT_WRITE_MS, TEAMMATE_STALE_WORKING_MS, TEAMMATE_REPLAY_MAX_MESSAGES,
  TEAMMATE_REPLAY_MAX_BYTES, TEAM_FIELD_MAX,
} from './constants'
import { sanitizeAgentName } from './team-links'

const COLOR_RE = /^#[0-9a-fA-F]{6}$/

/** Only '#rrggbb' is a valid team color; anything else is dropped. */
export function sanitizeTeamColor(value: unknown): string | undefined {
  return typeof value === 'string' && COLOR_RE.test(value) ? value.toLowerCase() : undefined
}

/** Short single-line untrusted string (model, agent type, team name). */
export function sanitizeTeamField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = sanitizeAgentName(value)
  return v ? v.slice(0, TEAM_FIELD_MAX) : undefined
}

export interface TeammateMeta {
  /** Display name: meta.name, else meta.agentType */
  name: string
  teamName: string
  color?: string
  /** spawnedAgentType from the sidecar (the role) */
  agentType?: string
  model?: string
}

/** Validate a parsed .meta.json; null when the sidecar does not describe a teammate. */
export function parseTeammateMeta(meta: unknown): TeammateMeta | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const m = meta as Record<string, unknown>
  const teamName = sanitizeTeamField(m.teamName)
  if (m.taskKind !== 'in_process_teammate' && !teamName) return null
  const name = sanitizeAgentName(m.name) ?? sanitizeAgentName(m.agentType)
  if (!name) return null
  return {
    name,
    teamName: teamName ?? 'team',
    color: sanitizeTeamColor(m.color),
    agentType: sanitizeTeamField(m.spawnedAgentType) ?? sanitizeTeamField(m.agentType),
    model: sanitizeTeamField(m.model),
  }
}

const MAX_PENDING_IDS = 256

/** Follows one teammate transcript to decide working / idle / done. */
export class TeammateTracker {
  readonly pending = new Set<string>()
  /** True when the last conversation entry is an assistant message that ended the turn */
  turnEnded = false
  lastWriteMs: number
  /** Sticky until the next transcript line (set by the team config / lead session end) */
  done = false

  constructor(lastWriteMs = Date.now()) { this.lastWriteMs = lastWriteMs }

  /** Feed one raw JSONL line (any garbage is ignored). */
  feed(line: string, writeMs = Date.now()): void {
    let entry: unknown
    try { entry = JSON.parse(line) } catch { return }
    if (!entry || typeof entry !== 'object') return
    const e = entry as { type?: unknown; message?: { content?: unknown } }
    if (e.type !== 'user' && e.type !== 'assistant') return
    this.lastWriteMs = writeMs
    this.done = false
    const content = e.message?.content
    if (typeof content === 'string') { this.turnEnded = e.type === 'assistant'; return }
    if (!Array.isArray(content)) { this.turnEnded = false; return }
    let hasToolUse = false
    let hasText = false
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue
      const b = raw as { type?: unknown; id?: unknown; tool_use_id?: unknown; text?: unknown }
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        hasToolUse = true
        if (this.pending.size < MAX_PENDING_IDS) this.pending.add(b.id)
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        this.pending.delete(b.tool_use_id)
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        hasText = true
      }
    }
    // A thinking-only assistant fragment does not end the turn
    this.turnEnded = e.type === 'assistant' && !hasToolUse && (hasText || content.length === 0)
  }

  activity(now = Date.now()): AgentActivity {
    if (this.done) return 'done'
    if (this.pending.size > 0) return 'working'
    const age = now - this.lastWriteMs
    if (age < TEAMMATE_RECENT_WRITE_MS) return 'working'
    if (!this.turnEnded && age < TEAMMATE_STALE_WORKING_MS) return 'working'
    return 'idle'
  }
}

/** Runtime state attached to a SubagentState for a teammate. */
export interface TeammateRuntime {
  meta: TeammateMeta
  tracker: TeammateTracker
  /** Last agent_activity emitted (to avoid repeats) */
  lastActivity?: AgentActivity
  /** True once an agent_spawn with teammate extras has been emitted */
  spawned: boolean
}

export interface TranscriptTail {
  /** Complete non-empty lines of the window */
  lines: string[]
  /** Byte offset just after the last complete line: where live tailing continues */
  size: number
}

/**
 * Read the end of a transcript: at most `maxBytes` bytes. The first (possibly cut) line is dropped
 * when the window does not start at 0, and a trailing partial line (writer mid-flush) is left
 * for the live tail by returning a `size` that stops after the last newline.
 */
export function readTranscriptTail(filePath: string, maxBytes = TEAMMATE_REPLAY_MAX_BYTES): TranscriptTail {
  try {
    const st = fs.statSync(filePath)
    if (!st.isFile() || st.size === 0) return { lines: [], size: 0 }
    const start = Math.max(0, st.size - maxBytes)
    const fd = fs.openSync(filePath, 'r')
    let buf: Buffer
    try {
      buf = Buffer.alloc(st.size - start)
      const n = fs.readSync(fd, buf, 0, buf.length, start)
      buf = buf.subarray(0, n)
    } finally {
      fs.closeSync(fd)
    }
    const end = buf.lastIndexOf(0x0a) + 1
    if (end === 0) return { lines: [], size: start }
    const lines = buf.toString('utf-8', 0, end).split(/\r?\n/)
    if (start > 0) lines.shift()
    return { lines: lines.filter(l => l.trim() !== ''), size: start + end }
  } catch {
    return { lines: [], size: 0 }
  }
}

/** The last `max` user/assistant lines (other entry types are noise for the replay). */
export function selectReplayLines(lines: readonly string[], max = TEAMMATE_REPLAY_MAX_MESSAGES): string[] {
  const out: string[] = []
  for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
    const line = lines[i]
    try {
      const t = (JSON.parse(line) as { type?: unknown } | null)?.type
      if (t === 'user' || t === 'assistant') out.push(line)
    } catch { /* skip unparseable */ }
  }
  return out.reverse()
}
