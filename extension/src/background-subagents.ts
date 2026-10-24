/**
 * Background subagents (#239).
 *
 * Claude Code runs Agent/Task calls in the background by default (always for `isolation: "worktree"`).
 * Their tool_result is only a launch receipt: the entry's `toolUseResult` says
 * `{ status: "async_launched", agentId }`. The finish arrives later in the parent's transcript as a
 *   <task-notification><task-id>agentId</task-id><tool-use-id>..</tool-use-id><status>completed</status>..</task-notification>
 * either in a user turn or, when absorbed mid-turn, only in a `queue-operation` line.
 *
 * Proof rule (docs/reading-the-ui.md): a background subagent is finished only by a notification that
 * names a launch we saw and carries a known terminal status. No status (a restarted agent), an unknown
 * status or an unknown launch prove nothing.
 */

import { NORM_ID_MAX, TEAM_NOTIFICATION_SCAN_MAX, TEAM_NOTIFICATIONS_PER_TURN_MAX } from './constants'
import { ostr } from './event-normalize'
import { sanitizeAgentName, sanitizeMessageContent } from './team-links'

/** Statuses that end a background task. `completed` is a success, the others an error. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled'])

/** Launches remembered at once (oldest evicted): a bound, not an expected size. */
export const BACKGROUND_LAUNCHES_MAX = 256

export interface TaskNotification {
  toolUseId?: string
  taskId?: string
  /** Lower-case status, only when it is a known terminal one */
  terminalStatus?: string
  /** <result> when present, else <summary> (sanitized, bounded) */
  report: string
  /** <usage><duration_ms> when it is a positive whole number */
  durationMs?: number
}

export interface BackgroundLaunch {
  toolUseId: string
  childName: string
  parent: string
  sessionId: string
  agentId?: string
  /** When the dispatch was seen live; absent for launches found while pre-scanning history */
  startTime?: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** The agentId a SendMessage result says it resumed ("Resuming agent"), undefined when it resumed none. */
export function resumedAgentOf(toolUseResult: unknown): string | undefined {
  if (!isRecord(toolUseResult) || toolUseResult.success !== true) return undefined
  return sanitizeAgentName(toolUseResult.resumedAgentId) ?? undefined
}

/** The agentId of an async launch receipt, '' when it carries none; null when it is not one. */
export function asyncLaunchOf(toolUseResult: unknown): { agentId?: string } | null {
  if (!isRecord(toolUseResult) || toolUseResult.status !== 'async_launched') return null
  const agentId = sanitizeAgentName(toolUseResult.agentId) ?? undefined
  return agentId ? { agentId } : {}
}

function tagContent(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)
  return m ? m[1] : ''
}

/** <task-notification> blocks of a text (scan and count bounded). [] for anything else. */
export function parseTaskNotifications(text: unknown): TaskNotification[] {
  if (typeof text !== 'string' || !text.includes('<task-notification>')) return []
  const scan = text.length > TEAM_NOTIFICATION_SCAN_MAX ? text.slice(0, TEAM_NOTIFICATION_SCAN_MAX) : text
  const out: TaskNotification[] = []
  const re = /<task-notification>([\s\S]*?)<\/task-notification>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(scan)) && out.length < TEAM_NOTIFICATIONS_PER_TURN_MAX) {
    const body = m[1]
    const toolUseId = ostr(tagContent(body, 'tool-use-id').trim(), NORM_ID_MAX) || undefined
    const taskId = sanitizeAgentName(tagContent(body, 'task-id')) ?? undefined
    const status = tagContent(body, 'status').trim().toLowerCase()
    const report = sanitizeMessageContent(tagContent(body, 'result')) || sanitizeMessageContent(tagContent(body, 'summary'))
    const ms = Number(tagContent(body, 'duration_ms').trim())
    out.push({
      ...(toolUseId ? { toolUseId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(TERMINAL_STATUSES.has(status) ? { terminalStatus: status } : {}),
      report,
      ...(Number.isSafeInteger(ms) && ms > 0 ? { durationMs: ms } : {}),
    })
  }
  return out
}

/** Open background launches, by tool_use_id and by agentId (bounded, oldest evicted). */
export class BackgroundLaunches {
  private byToolUseId = new Map<string, BackgroundLaunch>()
  private byAgentId = new Map<string, string>()
  /** Launches already finished, by agentId (bounded, oldest evicted): a SendMessage resume re-opens one (#433) */
  private finished = new Map<string, BackgroundLaunch>()

  register(launch: BackgroundLaunch): void {
    this.delete(launch.toolUseId)
    if (this.byToolUseId.size >= BACKGROUND_LAUNCHES_MAX) {
      const oldest = this.byToolUseId.keys().next().value
      if (oldest !== undefined) this.delete(oldest)
    }
    this.byToolUseId.set(launch.toolUseId, launch)
    if (launch.agentId) this.byAgentId.set(launch.agentId, launch.toolUseId)
  }

  /**
   * The open launch a terminal notification finishes, removed so it is finished once.
   * Undefined when the notification proves no finish or names no launch of this session.
   */
  take(n: TaskNotification, sessionId: string): BackgroundLaunch | undefined {
    if (!n.terminalStatus) return undefined
    const id = (n.toolUseId && this.byToolUseId.has(n.toolUseId))
      ? n.toolUseId
      : (n.taskId ? this.byAgentId.get(n.taskId) : undefined)
    const launch = id ? this.byToolUseId.get(id) : undefined
    if (!launch || launch.sessionId !== sessionId) return undefined
    this.delete(launch.toolUseId)
    if (launch.agentId) {
      this.finished.delete(launch.agentId)
      if (this.finished.size >= BACKGROUND_LAUNCHES_MAX) {
        const oldest = this.finished.keys().next().value
        if (oldest !== undefined) this.finished.delete(oldest)
      }
      this.finished.set(launch.agentId, launch)
    }
    return launch
  }

  /**
   * A finished launch resumed by a SendMessage whose result names `agentId` as resumed (#433): it is open
   * again, and the next terminal notification for that task-id (its tool-use-id is the SendMessage call's)
   * finishes it. Nothing is re-opened for an agent this session never saw finish.
   */
  resume(agentId: string, sessionId: string): boolean {
    const launch = this.finished.get(agentId)
    if (!launch || launch.sessionId !== sessionId) return false
    this.finished.delete(agentId)
    this.register({ ...launch, startTime: undefined })
    return true
  }

  has(toolUseId: string): boolean {
    return this.byToolUseId.has(toolUseId)
  }

  delete(toolUseId: string): void {
    const launch = this.byToolUseId.get(toolUseId)
    if (!launch) return
    this.byToolUseId.delete(toolUseId)
    if (launch.agentId && this.byAgentId.get(launch.agentId) === toolUseId) this.byAgentId.delete(launch.agentId)
  }

  clearSession(sessionId: string): void {
    for (const launch of [...this.byToolUseId.values()]) {
      if (launch.sessionId === sessionId) this.delete(launch.toolUseId)
    }
    for (const [agentId, launch] of [...this.finished]) {
      if (launch.sessionId === sessionId) this.finished.delete(agentId)
    }
  }
}
