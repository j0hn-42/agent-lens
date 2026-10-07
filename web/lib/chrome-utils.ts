/**
 * Pure helpers for the visualizer chrome (top bar, session tabs, control bar,
 * announcements). Kept free of React/DOM so they can be unit-tested with node:test.
 */
import { formatDuration, pluralize } from './utils'
import type { ConnectionStatus, SessionInfo } from './bridge-types'

/** Shared visible keyboard-focus style for every interactive control in the chrome. */
export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#99e0ff]'

// ─── Session tabs ────────────────────────────────────────────────────────────

export type SessionStatusKind = 'new-activity' | 'active' | 'completed'

/** Status of a session tab. Unseen background activity wins over the plain active state. */
export function sessionStatusKind(
  session: Pick<SessionInfo, 'status'>,
  hasActivity: boolean,
  isSelected: boolean,
): SessionStatusKind {
  if (hasActivity && !isSelected) return 'new-activity'
  return session.status === 'active' ? 'active' : 'completed'
}

export const SESSION_STATUS_TEXT: Record<SessionStatusKind, string> = {
  'new-activity': 'new activity',
  active: 'active',
  completed: 'completed',
}

/** Roving-tabindex arrow navigation: returns the index to focus, or null when the key is not ours. */
export function nextTabIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight': return (current + 1) % count
    case 'ArrowLeft': return (current - 1 + count) % count
    case 'Home': return 0
    case 'End': return count - 1
    default: return null
  }
}

// ─── Scrubber ────────────────────────────────────────────────────────────────

/** New scrubber position for a keydown, or null when the key is not handled. Result is clamped to [0, total]. */
export function scrubberKeyTarget(key: string, shiftKey: boolean, current: number, total: number): number | null {
  const step = shiftKey ? 10 : 1
  let next: number
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp': next = current + step; break
    case 'ArrowLeft':
    case 'ArrowDown': next = current - step; break
    case 'PageUp': next = current + 10; break
    case 'PageDown': next = current - 10; break
    case 'Home': next = 0; break
    case 'End': next = total; break
    default: return null
  }
  return Math.max(0, Math.min(total > 0 ? total : 0, next))
}

/** Convert a pointer x position into a time on the scrubber. */
export function scrubberTimeFromX(clientX: number, left: number, width: number, total: number): number {
  if (!(width > 0) || !(total > 0)) return 0
  const ratio = Math.max(0, Math.min(1, (clientX - left) / width))
  return ratio * total
}

export function scrubberValueText(current: number, total: number): string {
  return `${formatDuration(current)} of ${formatDuration(total)}`
}

// ─── Top bar ─────────────────────────────────────────────────────────────────

/** "5 agents: 2 active - 3 done" */
export function formatAgentCounts(active: number, done: number): string {
  return `${pluralize(active + done, 'agent')}: ${active} active - ${done} done`
}

export type ConnectionTone = 'ok' | 'pending' | 'error' | 'demo'

export interface ConnectionDisplay { label: string; tone: ConnectionTone; description: string }

/** Single place that decides the connection badge: DEMO never masquerades as LIVE. */
export function connectionDisplay(status: ConnectionStatus, isDemo: boolean): ConnectionDisplay {
  if (isDemo) return { label: 'DEMO', tone: 'demo', description: 'Showing demo data, not a live session' }
  switch (status) {
    case 'watching': return { label: 'LIVE', tone: 'ok', description: 'Live: watching for agent activity' }
    case 'connected': return { label: 'CONNECTED', tone: 'ok', description: 'Connected, waiting for agent activity' }
    case 'connecting': return { label: 'CONNECTING', tone: 'pending', description: 'Connecting to the relay' }
    default: return { label: 'OFFLINE', tone: 'error', description: 'Relay offline' }
  }
}

/** Text for the sr-only polite live region. Only state changes alter it. */
export function buildAnnouncement(opts: {
  connection: ConnectionDisplay
  sessionLabel: string | null
  isReviewing: boolean
  isEmpty: boolean
}): string {
  const parts = [`Connection: ${opts.connection.label.toLowerCase()}`]
  if (opts.sessionLabel) parts.push(`Session: ${opts.sessionLabel}`)
  parts.push(opts.isReviewing ? 'Review mode' : 'Live mode')
  if (opts.isEmpty) parts.push('Waiting for an agent session')
  return parts.join('. ')
}

export function formatMissedEvents(n: number): string | null {
  return n > 0 ? `${pluralize(n, 'event')} missed while reviewing` : null
}

// ─── Empty state ─────────────────────────────────────────────────────────────

export interface ChecklistItem { id: string; label: string; ok: boolean; detail?: string }

export function emptyStateChecklist(opts: {
  status: ConnectionStatus
  relayPort?: string
  sessionCount: number
}): ChecklistItem[] {
  const relayOk = opts.status === 'connected' || opts.status === 'watching'
  return [
    {
      id: 'relay',
      label: 'Relay connected',
      ok: relayOk,
      detail: relayOk ? undefined : opts.status === 'connecting' ? 'connecting...' : opts.relayPort ? `unreachable on :${opts.relayPort}` : 'unreachable',
    },
    { id: 'workspace', label: 'Workspace watched', ok: opts.status === 'watching', detail: opts.status === 'watching' ? undefined : 'only the current workspace is watched' },
    { id: 'runtime', label: 'Claude Code or Codex session detected', ok: opts.sessionCount > 0, detail: opts.sessionCount > 0 ? undefined : 'start a session to see activity' },
  ]
}

// ─── Focus return ────────────────────────────────────────────────────────────

interface ContainsLike { contains(other: unknown): boolean }

/** Restore focus to the trigger only when focus is still inside the closed panel or was dropped on <body>. */
export function shouldRestoreFocus(active: unknown, panel: ContainsLike | null, body: unknown): boolean {
  if (active == null || active === body) return true
  return !!panel && panel.contains(active)
}
