/**
 * Pure helpers for the visualizer chrome (top bar, session tabs, control bar,
 * announcements). Kept free of React/DOM so they can be unit-tested with node:test.
 */
import { formatDuration, pluralize } from './utils'
import { groupHeading, memberNoun, type GroupKind } from './ui-glossary'
import { formatTokenUsage, spokenCostUsage, USAGE_LABELS, type UsageTotal } from './usage'
import { deriveFreshness } from '../hooks/simulation/freshness'
import { SESSION_IMPORTED_TEXT, SESSION_INDEXED_TEXT, SESSION_NOT_OBSERVED_TEXT, SESSION_OFFLINE_TEXT, isSessionObserved, observedSessions } from './session-model'
import { ALL_SESSIONS_ID, teamSelectionId, type ConnectionStatus, type SessionInfo } from './bridge-types'

/**
 * The token and cost totals of the view in words, read by screen readers after the agent counts of the top bar (#523:
 * they are no longer drawn there; the Cost panel draws them on the canvas, which screen readers do not read). When the
 * runtime reports nothing, each one names what is missing ("tokens not reported", "cost not reported") instead of two
 * bare "not reported" in a row (#383).
 */
export function topBarContextText(tokens: UsageTotal, cost: UsageTotal): { tokens: string; spoken: string } {
  const missing = (u: UsageTotal) => u.status === 'unavailable' || u.value === null
  return {
    tokens: missing(tokens) ? `tokens ${USAGE_LABELS.unavailable}` : `${formatTokenUsage(tokens)} tokens in context`,
    // The cost in words (no "~"); a missing one reads "cost not reported"
    spoken: missing(cost) ? `cost ${USAGE_LABELS.unavailable}` : spokenCostUsage(cost),
  }
}

/** Time the pointer has to go from a top bar button to its tooltip, below it (WCAG 1.4.13, #523). */
export const TOOLTIP_CLOSE_DELAY_MS = 300

/**
 * Inks of the tooltips of the top bar panel buttons (#523), measured in every theme by scripts/theme-contrast.test.ts:
 * `ground` is a palette key or a theme variable, `text` the palette key of its text.
 */
export const TOPBAR_TOOLTIP = { ground: 'panelBg', text: 'textPrimary' } as const

// ─── Session tabs ────────────────────────────────────────────────────────────

export type SessionStatusKind = 'new-activity' | 'active' | 'completed' | 'unobserved' | 'indexed' | 'imported' | 'offline'

/**
 * Status of a session. Unseen background activity wins over the plain active state. An active
 * session that no event was ever received for (and with no live hook flag) is 'unobserved': it is
 * listed, but whether it is idle or working is unknown (issue #52), so it never reads 'active'.
 * `isObservedId` defaults to the app-wide observation tracker. While the relay is offline (`relayOffline`), an
 * active session is 'offline': no event can arrive, so it is not shown as active (#367).
 */
export function sessionStatusKind(
  session: Pick<SessionInfo, 'status' | 'indexedOnly' | 'imported'> & { id?: string },
  hasActivity: boolean,
  isSelected: boolean,
  isObservedId: (sessionId: string) => boolean = observedSessions.has,
  relayOffline = false,
): SessionStatusKind {
  // The index proves neither detection nor an end: never shown as completed
  if (session.indexedOnly) return 'indexed'
  // Read from a file: neither live activity nor a witnessed end (#294)
  if (session.imported) return 'imported'
  if (relayOffline && session.status === 'active') return 'offline'
  if (hasActivity && !isSelected) return 'new-activity'
  if (session.status !== 'active') return 'completed'
  return isSessionObserved({ id: session.id ?? '', status: 'active' }, hasActivity, isObservedId) ? 'active' : 'unobserved'
}

export const SESSION_STATUS_TEXT: Record<SessionStatusKind, string> = {
  'new-activity': 'new activity',
  active: 'active',
  completed: 'completed',
  unobserved: SESSION_NOT_OBSERVED_TEXT,
  indexed: SESSION_INDEXED_TEXT,
  imported: SESSION_IMPORTED_TEXT,
  offline: SESSION_OFFLINE_TEXT,
}

export interface TabItem {
  /** Selection id: ALL_SESSIONS_ID, a session id or a team pseudo selection ('team:<name>') */
  id: string
  kind: 'all' | 'team' | 'session'
  /** team tab: the team; session tab: the team the session belongs to (grouped under its team tab) */
  teamName?: string
}

/**
 * Tabs in order: 'All', then every team (its tab followed by its member sessions), then the sessions
 * that belong to no team. Teams come from team events and from sessions tagged with a team name.
 */
export function buildTabModel(
  sessions: ReadonlyArray<Pick<SessionInfo, 'id'> & { teamName?: string }>,
  teamNames: Iterable<string>,
  /** Team map key -> display name and lead session: lets two teams with the same name under different
   *  lead sessions (keys "alpha" and "alpha@L3") each get their own member sessions. */
  teamMeta?: ReadonlyMap<string, { name: string; leadSessionId?: string }>,
  /** Sessions tagged with a team that is not in `teamNames` are listed as plain sessions instead of
   *  creating a team tab (used to hide lead-only teams: every Claude Code session has one). */
  opts?: { hideUnlistedTeams?: boolean },
): TabItem[] {
  const teams: string[] = []
  const add = (name: string | undefined) => { if (name && !teams.includes(name)) teams.push(name) }
  for (const n of teamNames) add(n)
  // A session tagged with a team name belongs to the team key whose lead session it is, otherwise to the
  // first key carrying that name (the tag holds only the name).
  const keyOfSession = (s: { id: string; teamName?: string }): string | undefined => {
    if (!s.teamName) return undefined
    if (teamMeta) {
      let first: string | undefined
      for (const key of teams) {
        const meta = teamMeta.get(key)
        if (!meta || meta.name !== s.teamName) continue
        if (meta.leadSessionId === s.id) return key
        first ??= key
      }
      if (first !== undefined) return first
    }
    return opts?.hideUnlistedTeams ? undefined : s.teamName
  }
  for (const s of sessions) add(keyOfSession(s))
  const items: TabItem[] = [{ id: ALL_SESSIONS_ID, kind: 'all' }]
  for (const team of teams) {
    items.push({ id: teamSelectionId(team), kind: 'team', teamName: team })
    for (const s of sessions) if (keyOfSession(s) === team) items.push({ id: s.id, kind: 'session', teamName: team })
  }
  for (const s of sessions) if (keyOfSession(s) === undefined) items.push({ id: s.id, kind: 'session' })
  return items
}

/** "Team X: 3 members, 2 working" or, for a workflow, "Workflow X: 5 agents, 3 working" */
export function formatTeamSummary(teamName: string, members: number, working: number, kind?: GroupKind): string {
  return `${groupHeading(kind, teamName)}: ${pluralize(members, memberNoun(kind, 1))}, ${working} working`
}

/** Short visible tag + full name for the runtime of a session tab; null when the runtime is unknown. */
export function runtimeBadge(runtime: SessionInfo['runtime']): { short: string; label: string } | null {
  if (runtime === 'codex') return { short: 'CX', label: 'Codex' }
  if (runtime === 'copilot') return { short: 'GC', label: 'GitHub Copilot' }
  if (runtime === 'pi') return { short: 'PI', label: 'Pi' }
  if (runtime === 'gemini') return { short: 'GM', label: 'Gemini CLI' }
  if (runtime === 'opencode') return { short: 'OC', label: 'OpenCode' }
  if (runtime === 'claude') return { short: 'CC', label: 'Claude Code' }
  return null
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

/**
 * "5 agents: 2 active - 3 done". Idle and error agents are counted apart ("- 1 idle - 1 error"), and agents whose
 * status is no longer proven are too ("- 4 last known state"): "active" only counts agents proven to be working.
 */
export function formatAgentCounts(active: number, done: number, stale = 0, idle = 0, error = 0): string {
  const staleText = stale > 0 ? ` - ${stale} last known state` : ''
  const idleText = idle > 0 ? ` - ${idle} idle` : ''
  const errorText = error > 0 ? ` - ${error} error` : ''
  return `${pluralize(active + done + stale + idle + error, 'agent')}: ${active} active${staleText}${idleText}${errorText} - ${done} done`
}

/** Compact "30 agents: 0 active · 4 last known · 26 done", drawn in the Sessions panel header (#523); the full wording (`formatAgentCounts`) is read by screen readers. */
export function formatAgentCountsCompact(active: number, done: number, stale = 0, idle = 0, error = 0): string {
  const part = (n: number, label: string) => (n > 0 ? ` · ${n} ${label}` : '')
  return `${pluralize(active + done + stale + idle + error, 'agent')}: ${active} active${part(stale, 'last known')}${part(idle, 'idle')}${part(error, 'error')} · ${done} done`
}

/** Agents of the view by state, as `agentActivityCounts` splits them. */
export interface AgentStateCounts { active: number; done: number; stale: number; idle: number; error: number }

/**
 * Agent counts of the view (#523, moved from the top bar to the Sessions panel header, same text): `drawn` is the
 * compact text ("30 agents: 0 active · 4 last known · 26 done"), `spoken` the full wording read by screen readers.
 * In All (`allSessionCount` not null) it is the sessions and agents ("3 sessions · 30 agents"), without the states.
 */
export function viewCountsText(c: AgentStateCounts, allSessionCount: number | null): { drawn: string; spoken: string } {
  if (allSessionCount !== null) {
    const sessions = pluralize(allSessionCount, 'session')
    const agents = pluralize(c.active + c.done + c.stale + c.idle + c.error, 'agent')
    return { drawn: `${sessions} · ${agents}`, spoken: `${sessions}, ${agents}` }
  }
  return {
    drawn: formatAgentCountsCompact(c.active, c.done, c.stale, c.idle, c.error),
    spoken: formatAgentCounts(c.active, c.done, c.stale, c.idle, c.error),
  }
}

/** Splits agents into done, stale (status older than the freshness limit: only a last known state), idle, error and active. */
export function agentActivityCounts(
  agents: Iterable<{ state: string; lastEventAt?: number }>,
  now: number,
): { active: number; done: number; stale: number; idle: number; error: number } {
  let active = 0, done = 0, stale = 0, idle = 0, error = 0
  for (const a of agents) {
    if (a.state === 'complete') done++
    else if (deriveFreshness(a, now) === 'stale') stale++
    else if (a.state === 'idle') idle++
    else if (a.state === 'error') error++
    else active++
  }
  return { active, done, stale, idle, error }
}


/** Marker text for a history whose oldest events were dropped, or null when nothing was dropped. */
export function formatTruncatedHistory(droppedEvents: number): string | null {
  return droppedEvents > 0 ? `History truncated: ${pluralize(droppedEvents, 'older event')} dropped` : null
}

/** "... 12 older messages dropped" line at the top of a conversation, or null when nothing was dropped. */
export function formatDroppedMessages(dropped: number): string | null {
  return dropped > 0 ? `... ${pluralize(dropped, 'older message')} dropped` : null
}

/** Minimal agent shape needed to label it with its session. */
interface SessionLabelable { sessionId: string; sessionLabel?: string; runtime?: 'claude' | 'codex' | 'copilot' | 'pi' | 'gemini' | 'opencode' }

/**
 * Attach the human-readable session label (and the session runtime when the agent has none) to each
 * agent so the feed can render a session chip. Returns the same Map when nothing changes.
 */
export function labelAgentsWithSession<A extends SessionLabelable>(
  agents: Map<string, A>,
  sessions: ReadonlyArray<Pick<SessionInfo, 'id' | 'label' | 'runtime'>>,
): Map<string, A> {
  const byId = new Map(sessions.map(s => [s.id, s]))
  let out: Map<string, A> | null = null
  for (const [key, agent] of agents) {
    const session = byId.get(agent.sessionId)
    if (!session) continue
    const runtime = agent.runtime ?? session.runtime
    if (agent.sessionLabel === session.label && agent.runtime === runtime) continue
    if (!out) out = new Map(agents)
    out.set(key, { ...agent, sessionLabel: session.label, ...(runtime ? { runtime } : {}) })
  }
  return out ?? agents
}

/**
 * A read-only ref whose `current` is the source frame with its agents labelled by session (label, and
 * runtime when the agent has none), for the canvas, which draws straight from the simulation ref.
 * Memoised: the decorated agents map is rebuilt only when the source agents map or the session list
 * changes, and agents that did not change keep their decorated object (nothing is copied per frame).
 */
export function createLabelledSimulationRef<S extends { agents: ReadonlyMap<string, SessionLabelable> }>(
  source: { readonly current: S },
  getSessions: () => ReadonlyArray<Pick<SessionInfo, 'id' | 'label' | 'runtime'>>,
): { readonly current: S } {
  let lastSessions: ReadonlyArray<Pick<SessionInfo, 'id' | 'label' | 'runtime'>> | null = null
  let byId = new Map<string, Pick<SessionInfo, 'id' | 'label' | 'runtime'>>()
  let decorated = new WeakMap<object, SessionLabelable>()
  let lastAgents: ReadonlyMap<string, SessionLabelable> | null = null
  let lastLabelled: ReadonlyMap<string, SessionLabelable> | null = null
  let lastFrame: S | null = null
  let lastResult: S | null = null

  const decorate = (agent: SessionLabelable): SessionLabelable => {
    const cached = decorated.get(agent)
    if (cached) return cached
    const session = byId.get(agent.sessionId)
    let out = agent
    if (session) {
      const runtime = agent.runtime ?? session.runtime
      if (agent.sessionLabel !== session.label || agent.runtime !== runtime) {
        out = { ...agent, sessionLabel: session.label, ...(runtime ? { runtime } : {}) }
      }
    }
    decorated.set(agent, out)
    return out
  }

  return {
    get current(): S {
      const frame = source.current
      const sessions = getSessions()
      if (sessions !== lastSessions) {
        lastSessions = sessions
        byId = new Map(sessions.map(x => [x.id, x]))
        decorated = new WeakMap()
        lastAgents = null
        lastFrame = null
      }
      if (frame === lastFrame && lastResult) return lastResult
      if (frame.agents !== lastAgents || !lastLabelled) {
        const next = new Map<string, SessionLabelable>()
        for (const [key, agent] of frame.agents) next.set(key, decorate(agent))
        lastAgents = frame.agents
        lastLabelled = next
      }
      lastFrame = frame
      lastResult = { ...frame, agents: lastLabelled }
      return lastResult
    },
  }
}

export type ConnectionTone = 'ok' | 'pending' | 'error' | 'demo'

export interface ConnectionDisplay { label: string; tone: ConnectionTone; description: string }

/** Single place that decides the connection badge: DEMO never masquerades as LIVE. */
export function connectionDisplay(status: ConnectionStatus, isDemo: boolean, detail?: string | null): ConnectionDisplay {
  if (isDemo) return { label: 'DEMO', tone: 'demo', description: 'Showing demo data, not a live session' }
  switch (status) {
    case 'watching': return { label: 'LIVE', tone: 'ok', description: 'Live: watching for agent activity' }
    case 'connected': return { label: 'CONNECTED', tone: 'ok', description: 'Connected, waiting for agent activity' }
    case 'connecting': return { label: 'CONNECTING', tone: 'pending', description: 'Connecting to the relay' }
    default: return { label: 'OFFLINE', tone: 'error', description: detail ? `Relay offline: ${detail}` : 'Relay offline' }
  }
}

/**
 * Badge of the playback bar. Follows the real connection with the top bar's wording: LIVE (pulsing) only while the relay is
 * watching; otherwise the text says OFFLINE or CONNECTING and nothing pulses.
 */
export function liveBadge(status: ConnectionStatus, isDemo: boolean): { label: string; live: boolean; tone: ConnectionTone } {
  if (isDemo) return { label: 'DEMO', live: false, tone: 'demo' }
  const d = connectionDisplay(status, false)
  // Same word as the top bar; it pulses only while activity is actually watched (a bare connection proves less)
  return { label: d.label, live: status === 'watching', tone: d.tone }
}

/** Text for the sr-only polite live region. Only state changes alter it. */
export function buildAnnouncement(opts: {
  connection: ConnectionDisplay
  sessionLabel: string | null
  isReviewing: boolean
  isEmpty: boolean
  /** Listed sessions with no received event (issue #52): their activity is unknown */
  unobservedSessions?: number
  /** 'Full screen on' / 'Full screen off' after a change (#196) */
  fullscreenNote?: string | null
  /** 'Presentation mode on' / 'Presentation mode off' after a change (#245) */
  presentationNote?: string | null
}): string {
  const parts = [`Connection: ${opts.connection.label.toLowerCase()}`]
  if (opts.sessionLabel) parts.push(`Session: ${opts.sessionLabel}`)
  parts.push(opts.isReviewing ? 'Review mode' : 'Live mode')
  if (opts.isEmpty) parts.push('Waiting for an agent session')
  if (opts.unobservedSessions && opts.unobservedSessions > 0) {
    parts.push(`${pluralize(opts.unobservedSessions, 'session')} listed, ${SESSION_NOT_OBSERVED_TEXT.replace('listed - ', '')}`)
  }
  if (opts.fullscreenNote) parts.push(opts.fullscreenNote)
  if (opts.presentationNote) parts.push(opts.presentationNote)
  return parts.join('. ')
}

export function formatMissedEvents(n: number): string | null {
  return n > 0 ? `${pluralize(n, 'event')} missed while reviewing` : null
}

// ─── Empty state ─────────────────────────────────────────────────────────────

/** `unknown`: cannot be proven right now (no relay to ask); shown as unknown, never as failed or done */
export interface ChecklistItem { id: string; label: string; ok: boolean; detail?: string; unknown?: boolean }

const UNKNOWN_DETAIL = 'unknown until the relay answers'

export function emptyStateChecklist(opts: {
  status: ConnectionStatus
  relayPort?: string
  sessionCount: number
  /** Claude Code hooks state: undefined when unknown (old relay, Codex/Copilot only): no line, never a default tick */
  hooksConfigured?: boolean
  isVSCode?: boolean
  /** What the relay really scans (#291); absent = not known (extension, older relay): no claim */
  scope?: 'workspace' | 'all'
}): ChecklistItem[] {
  const relayOk = opts.status === 'connected' || opts.status === 'watching'
  // Without a relay answer the watched scope and the sessions cannot be known (#371)
  const relayUnknown = !relayOk
  const items: ChecklistItem[] = [
    {
      id: 'relay',
      label: 'Relay connected',
      ok: relayOk,
      detail: relayOk ? undefined : opts.status === 'connecting' ? 'connecting...' : (opts.relayPort ? `unreachable on :${opts.relayPort}` : 'unreachable') + (opts.isVSCode ? '' : '; start it with "pnpm run dev:relay"'),
    },
    opts.scope === 'all'
      ? { id: 'workspace', label: 'All workspaces watched', ok: relayOk, ...(relayUnknown && { unknown: true, detail: UNKNOWN_DETAIL }) }
      : {
          id: 'workspace', label: 'Workspace watched', ok: opts.status === 'watching',
          ...(relayUnknown && { unknown: true }),
          detail: relayUnknown ? UNKNOWN_DETAIL : opts.status === 'watching' ? undefined
            : opts.scope === 'workspace' ? 'this workspace only: choose All workspaces in the scope selector to look at the others'
            : 'only the current workspace is watched',
        },
    { id: 'runtime', label: 'Claude Code, Codex, Copilot, Pi, Gemini CLI or OpenCode session detected', ok: opts.sessionCount > 0, ...(relayUnknown && opts.sessionCount === 0 && { unknown: true }), detail: opts.sessionCount > 0 ? undefined : relayUnknown ? UNKNOWN_DETAIL : 'start a session to see activity' },
  ]
  if (opts.hooksConfigured !== undefined) {
    items.push({
      id: 'hooks',
      label: 'Claude Code hooks configured',
      ok: opts.hooksConfigured,
      detail: opts.hooksConfigured ? undefined : opts.isVSCode ? 'run "Agent Lens: Configure Claude Code Hooks"' : 'run "pnpm run setup"',
    })
  }
  return items
}

// ─── Focus return ────────────────────────────────────────────────────────────

/** What a ControlBar blur means for its "had keyboard focus" flag. */
export type BlurFlagAction = 'keep' | 'clear' | 'check'

/**
 * - focus moved to another control inside the bar: keep;
 * - focus moved to a control outside the bar: clear;
 * - focus went nowhere (a click on empty space, or the focused control was unmounted by a mode swap):
 *   undecided until the next frame, when a blurred control that is still in the DOM means the
 *   user really left ('check').
 */
export function blurFlagAction(relatedInside: boolean, relatedIsNull: boolean): BlurFlagAction {
  if (relatedInside) return 'keep'
  return relatedIsNull ? 'check' : 'clear'
}

/** Where to put focus when a toast action/dismiss removed the focused control. */
export function toastSettleTarget(prevConnected: boolean): 'previous' | 'none' {
  return prevConnected ? 'previous' : 'none'
}

/** Element to restore focus to when a panel closes: the opener, else the fallback (e.g. its top-bar button). */
export function pickRestoreTarget<T extends { isConnected: boolean }>(trigger: T | null, fallback: T | null): T | null {
  if (trigger && trigger.isConnected) return trigger
  return fallback && fallback.isConnected ? fallback : null
}

interface ContainsLike { contains(other: unknown): boolean }

/** Restore focus to the trigger only when focus is still inside the closed panel or was dropped on <body>. */
export function shouldRestoreFocus(active: unknown, panel: ContainsLike | null, body: unknown): boolean {
  if (active == null || active === body) return true
  return !!panel && panel.contains(active)
}

// ─── Toasts ──────────────────────────────────────────────────────────────────

/** Key that runs the action (Undo) of the newest toast. Subject to the single-key shortcut preference. */
export const UNDO_SHORTCUT_KEY = 'u'

/** Time left on a toast timer after it ran from `startedAt` until `now` (never negative). */
export function toastRemaining(remainingMs: number, startedAt: number, now: number): number {
  return Math.max(0, remainingMs - Math.max(0, now - startedAt))
}

// ─── Escape stack ────────────────────────────────────────────────────────────

/** Ask handlers (newest registered first) to close something; stops at the first that does. */
export function runEscapeHandlers(handlers: ReadonlyArray<() => boolean>): boolean {
  for (let i = handlers.length - 1; i >= 0; i--) {
    if (handlers[i]()) return true
  }
  return false
}

// ─── Context menu ────────────────────────────────────────────────────────────

interface RectLike { left: number; top: number; width: number; height: number }

/**
 * Position for a context menu. Keyboard-triggered contextmenu events report clientX/Y = 0,0:
 * fall back to the centre of the element that has focus instead of the page corner.
 */
export function contextMenuPosition(clientX: number, clientY: number, rect: RectLike | null): { x: number; y: number } {
  if (clientX === 0 && clientY === 0 && rect) {
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  }
  return { x: clientX, y: clientY }
}

// ─── Canvas wiring (#36) ─────────────────────────────────────────────────────

export interface CanvasSessionMeta {
  label: string
  runtime?: 'claude' | 'codex' | 'copilot' | 'pi' | 'gemini' | 'opencode'
  workspace?: string
  projectId?: string
  projectName?: string
  status: 'active' | 'completed'
}

/** Per-session facts for the cluster halos (title, runtime, workspace, status), keyed by session id. */
export function buildSessionMeta(
  sessions: ReadonlyArray<Pick<SessionInfo, 'id' | 'label' | 'runtime' | 'workspace' | 'status' | 'projectId' | 'projectName'>>,
): Map<string, CanvasSessionMeta> {
  const out = new Map<string, CanvasSessionMeta>()
  for (const s of sessions) {
    out.set(s.id, {
      label: s.label,
      status: s.status,
      ...(s.runtime ? { runtime: s.runtime } : {}),
      ...(s.workspace ? { workspace: s.workspace } : {}),
      ...(s.projectId && s.projectName ? { projectId: s.projectId, projectName: s.projectName } : {}),
    })
  }
  return out
}

/** sessionId -> repository for the fleet layout; sessions outside git (no projectId) are left out, never grouped. */
export function buildSessionProjects(
  sessions: ReadonlyArray<Pick<SessionInfo, 'id' | 'projectId' | 'projectName'>>,
): Map<string, { projectId: string; projectName: string }> {
  const out = new Map<string, { projectId: string; projectName: string }>()
  for (const s of sessions) {
    if (s.projectId && s.projectName) out.set(s.id, { projectId: s.projectId, projectName: s.projectName })
  }
  return out
}

/** True when both maps give the same project to the same sessions (sessionProjects compared by content, #105). */
export function sameSessionProjects(
  a: ReadonlyMap<string, { projectId: string; projectName: string }>,
  b: ReadonlyMap<string, { projectId: string; projectName: string }>,
): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [id, p] of a) {
    const q = b.get(id)
    if (!q || q.projectId !== p.projectId || q.projectName !== p.projectName) return false
  }
  return true
}

/**
 * Selection to apply when a halo label is clicked, or null to leave the current tab alone.
 * A team cluster selects the team pseudo-tab; a session cluster selects its session, except that 'All'
 * stays 'All' while several sessions are shown (the canvas already zooms to the cluster).
 */
export function clusterSelectionTarget(
  cluster: { kind: 'session' | 'team'; sessionIds: readonly string[]; teamName?: string },
  selectedId: string | null,
  shownSessionCount: number,
): string | null {
  let target: string | null = null
  if (cluster.kind === 'team') {
    target = cluster.teamName ? teamSelectionId(cluster.teamName) : null
  } else if (cluster.sessionIds.length === 1) {
    if (selectedId === ALL_SESSIONS_ID && shownSessionCount > 1) return null
    target = cluster.sessionIds[0]
  }
  return target !== null && target !== selectedId ? target : null
}

/** Value of --topbar-h: measured bar height (wrapped rows included) + top offset (12px) + breathing room (8px). */
export function topbarOffsetPx(measuredHeight: number): number {
  const h = Number.isFinite(measuredHeight) && measuredHeight > 0 ? measuredHeight : 0
  return Math.ceil(h) + 20
}

/**
 * Keep `--topbar-h` in sync with the element height (ResizeObserver, falls back to a single measure).
 * Returns the cleanup. `root` and `ResizeObserverCtor` are injectable for tests.
 */
export function observeTopbarHeight(
  el: { getBoundingClientRect(): { height: number } },
  root: { style: { setProperty(name: string, value: string): void } },
  ResizeObserverCtor: (new (cb: () => void) => { observe(t: never): void; disconnect(): void }) | undefined,
): () => void {
  const publish = () => root.style.setProperty('--topbar-h', `${topbarOffsetPx(el.getBoundingClientRect().height)}px`)
  publish()
  if (!ResizeObserverCtor) return () => {}
  const ro = new ResizeObserverCtor(publish)
  ro.observe(el as never)
  return () => ro.disconnect()
}
