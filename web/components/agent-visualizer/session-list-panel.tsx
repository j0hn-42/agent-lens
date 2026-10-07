'use client'

import { useMemo, useRef, useState, useEffect, useSyncExternalStore } from 'react'
import { Z } from '@/lib/agent-types'
import type { TeamSummary } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { formatModelName, pluralize } from '@/lib/utils'
import { formatTokenUsage, usageFromAgent } from '@/lib/usage'
import { getStateLabel } from '@/lib/state-labels'
import { ALL_SESSIONS_ID, type SessionInfo } from '@/lib/bridge-types'
import { FOCUS_RING, SESSION_STATUS_TEXT, formatTeamSummary, runtimeBadge, sessionStatusKind, type SessionStatusKind } from '@/lib/chrome-utils'
import {
  buildAgentForests, buildSessionRows, filterActiveSessions, filterActiveTeams, formatRelativeTime,
  type AgentLike, type AgentNode,
} from '@/lib/session-tree'
import { observedSessions, isSessionObserved, SESSION_NOT_OBSERVED_HELP } from '@/lib/session-model'
import { useFreshnessValue, getFreshnessClock, type FreshnessClock } from '@/hooks/use-freshness-clock'
import { deriveFreshness, freshnessKey, lastKnownStateText, type Freshness } from '@/hooks/simulation/freshness'
import { FreshnessAnnouncer } from './freshness-announcer'
import { PanelHeader, SlidingPanel } from './shared-ui'

export type SessionListAgent = AgentLike

interface SessionListPanelProps {
  visible: boolean
  onClose: () => void
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: ReadonlySet<string>
  /** Model ID per session id (sessions that reported one) */
  sessionModels?: ReadonlyMap<string, string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
  /** Agents of the current view (the selected session, team or all sessions) */
  agents: ReadonlyMap<string, SessionListAgent>
  selectedAgentId: string | null
  onSelectAgent: (agentId: string) => void
  teams?: ReadonlyMap<string, TeamSummary>
  teamWorking?: ReadonlyMap<string, number>
  teamMemberCounts?: ReadonlyMap<string, number>
  /** Sessions the 'All' view counts (defaults to every session) */
  allSessionCount?: number
  /** Clock override for tests */
  now?: number
  /** Sessions heard from in this run (defaults to the app-wide tracker fed by the simulation) */
  observedSessionIds?: ReadonlySet<string>
  /** Freshness clock override for tests */
  freshnessClock?: FreshnessClock
}

const STATE_COLOR: Record<string, string> = {
  thinking: COLORS.thinking,
  tool_calling: COLORS.tool_calling,
  waiting_permission: COLORS.waiting_permission,
  error: COLORS.error,
  complete: COLORS.complete,
}

/** Marker whose shape (disc / ring / check / cross) differs per status, so colour is never the only cue. */
function StateMarker({ state }: { state: string }) {
  const color = STATE_COLOR[state] ?? COLORS.idle
  if (state === 'complete') return <span aria-hidden="true" className="w-3 shrink-0 text-[11px] leading-none" style={{ color }}>✓</span>
  if (state === 'error') return <span aria-hidden="true" className="w-3 shrink-0 text-[11px] leading-none" style={{ color }}>✕</span>
  const hollow = state === 'idle' || state === 'paused'
  return (
    <span
      aria-hidden="true"
      className={`inline-block w-2 h-2 mx-0.5 rounded-full shrink-0 ${state === 'waiting_permission' ? 'motion-safe:animate-pulse' : ''}`}
      style={{ background: hollow ? 'transparent' : color, border: `2px solid ${color}` }}
    />
  )
}

function SessionMarker({ kind }: { kind: SessionStatusKind }) {
  if (kind === 'completed') return <span aria-hidden="true" className="w-3 shrink-0 text-[11px] leading-none" style={{ color: COLORS.idle }}>✓</span>
  const isNew = kind === 'new-activity'
  return (
    <span
      aria-hidden="true"
      className={`inline-block w-2 h-2 mx-0.5 rounded-full shrink-0 ${isNew ? 'motion-safe:animate-pulse' : ''}`}
      style={{ background: isNew ? 'transparent' : COLORS.complete, border: `2px solid ${COLORS.complete}` }}
    />
  )
}

function AgentItem({ node, depth, selectedAgentId, onSelectAgent, freshnessNow }: {
  node: AgentNode<SessionListAgent>
  depth: number
  selectedAgentId: string | null
  onSelectAgent: (id: string) => void
  freshnessNow: number
}) {
  const a = node.agent
  const selected = a.id === selectedAgentId
  const stateText = getStateLabel(a.state)
  const freshness: Freshness = deriveFreshness(a, freshnessNow)
  const stale = freshness === 'stale'
  // A stale status is only the last known one: said in words, and the marker is greyed
  const detail = stale
    ? lastKnownStateText(a.state)
    : freshness === 'closed' && a.state !== 'complete'
      ? `closed, ${lastKnownStateText(a.state)}`
      : a.currentTool && a.state === 'tool_calling' ? a.currentTool : stateText
  const role = a.kind === 'subagent' ? 'sub-agent' : a.kind === 'teammate' ? 'teammate' : 'agent'
  return (
    <li>
      <button
        type="button"
        data-row-main
        tabIndex={-1}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelectAgent(a.id)}
        className={`flex w-full min-h-6 items-center gap-1.5 rounded py-0.5 pr-2 text-left text-[11px] hover:bg-white/5 ${selected ? 'font-semibold' : ''} ${FOCUS_RING}`}
        style={{ paddingLeft: 8 + depth * 14, color: selected ? COLORS.holoBright : COLORS.textMuted, background: selected ? COLORS.tabSelectedBg : undefined }}
      >
        <span aria-hidden="true" className="shrink-0" style={{ color: COLORS.textDim }}>{depth > 0 ? '└' : ''}</span>
        <StateMarker state={stale ? 'idle' : a.state} />
        <span className="sr-only">{role}, </span>
        <span className="truncate min-w-0 flex-1">{a.name}</span>
        <span className="shrink-0" style={{ color: stale ? COLORS.textMuted : STATE_COLOR[a.state] ?? COLORS.textMuted }}>{detail}</span>
        <span className="shrink-0 tabular-nums" style={{ color: COLORS.textDim }}>{formatTokenUsage(usageFromAgent(a))}</span>
      </button>
      {node.children.length > 0 && (
        <ul className="list-none p-0 m-0" aria-label={`Sub-agents of ${a.name}`}>
          {node.children.map(c => (
            <AgentItem key={c.agent.id} node={c} depth={depth + 1} selectedAgentId={selectedAgentId} onSelectAgent={onSelectAgent} freshnessNow={freshnessNow} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function SessionListPanel({
  visible, onClose, sessions, selectedSessionId, sessionsWithActivity, sessionModels,
  onSelectSession, onCloseSession, agents, selectedAgentId, onSelectAgent,
  teams, teamWorking, teamMemberCounts, allSessionCount, now, observedSessionIds, freshnessClock,
}: SessionListPanelProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [clock, setClock] = useState(() => now ?? Date.now())
  useEffect(() => {
    if (!visible || now !== undefined) return
    setClock(Date.now())
    const t = setInterval(() => setClock(Date.now()), 15000)
    return () => clearInterval(t)
  }, [visible, now])
  const currentTime = now ?? clock

  // Freshness: one shared clock; this panel re-renders only when an agent crosses a threshold
  const freshClock = freshnessClock ?? getFreshnessClock()
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  useFreshnessValue(t => freshnessKey(agentsRef.current.values(), t), freshClock)
  const freshnessNow = freshClock.getNow()

  // Sessions listed on disk but never heard from (issue #52)
  const observedVersion = useSyncExternalStore(observedSessions.subscribe, observedSessions.getVersion, observedSessions.getVersion)
  const isObservedId = (id: string) => (observedSessionIds ? observedSessionIds.has(id) : observedSessions.has(id))
  const isObserved = (s: SessionInfo) => isSessionObserved(s, sessionsWithActivity.has(s.id), isObservedId)

  const forests = useMemo(() => (visible ? buildAgentForests(agents.values()) : new Map<string, AgentNode[]>()), [agents, visible])
  const [activeOnly, setActiveOnly] = useState(false)
  const rows = useMemo(() => {
    // 'Active only' keeps the sessions proven active (and the selected one): a listed-but-unobserved
    // session is not counted as active, so it is hidden too
    const shown = activeOnly ? filterActiveSessions(sessions, selectedSessionId, isObserved) : sessions
    // A team row only makes sense with teammates: every Claude Code session owns a team holding just its lead,
    // and listing it would add a "Team session-xxxx: 0 members" row per session
    const listed = teams
      ? new Map([...teams].filter(([key, team]) => Math.max(teamMemberCounts?.get(key) ?? 0, team.members.length) > 0))
      : undefined
    const teamNames = listed ? [...listed.keys()] : []
    return buildSessionRows(
      shown, activeOnly ? filterActiveTeams(teamNames, shown, teamWorking) : teamNames, forests, listed,
      { hideUnlistedTeams: true }, isObserved,
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps -- isObserved reads the tracker version / props listed here
  }, [sessions, teams, teamWorking, teamMemberCounts, forests, activeOnly, selectedSessionId, observedSessionIds, sessionsWithActivity, observedVersion])
  const shownSessionCount = rows.filter(r => r.kind === 'session').length
  const activeCount = sessions.filter(s => s.status === 'active' && isObserved(s)).length

  const toggleCollapsed = (id: string, collapse: boolean) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (collapse) next.add(id)
      else next.delete(id)
      return next
    })
  }

  // Arrow keys move between rows (roving over the visible row buttons); Left/Right fold a session.
  const handleKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement
    if (!target.matches('[data-row-main]')) return
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-row-main]') ?? [])
    const at = items.indexOf(target)
    if (at < 0) return
    let next: number | null = null
    if (e.key === 'ArrowDown') next = Math.min(at + 1, items.length - 1)
    else if (e.key === 'ArrowUp') next = Math.max(at - 1, 0)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const id = target.dataset.sessionId
      if (id) {
        e.preventDefault()
        toggleCollapsed(id, e.key === 'ArrowLeft')
      }
      return
    } else if (e.key === 'Delete') {
      const id = target.dataset.closableId
      if (id) {
        e.preventDefault()
        // Land on the neighbouring row once the closed session is gone
        items[at + 1 < items.length ? at + 1 : Math.max(at - 1, 0)]?.focus()
        onCloseSession(id)
      }
      return
    }
    if (next === null) return
    e.preventDefault()
    items[next]?.focus()
  }

  // Native listener on the container (one handler for every row) rather than a prop on a non-interactive element
  const keyHandlerRef = useRef(handleKeyDown)
  keyHandlerRef.current = handleKeyDown
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => keyHandlerRef.current(e)
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [])

  const firstTabStop = rows.length > 0 ? rows[0].id : undefined
  const stopId = rows.some(r => r.id === selectedSessionId) ? selectedSessionId : firstTabStop

  return (
    <>
    <FreshnessAnnouncer agents={agents} clock={freshnessClock} />
    <SlidingPanel
      visible={visible}
      position={{ top: 48, left: 12 }}
      axis="X"
      offset={-8}
      zIndex={Z.sidePanel}
      width={380}
      labelledBy="session-list-title"
    >
      <div className="glass-card relative font-mono" style={{ background: COLORS.void }}>
        <PanelHeader
          onClose={onClose}
          titleId="session-list-title"
          actions={(
            <button
              type="button"
              aria-pressed={activeOnly}
              onClick={() => setActiveOnly(v => !v)}
              title="Hide sessions that are finished"
              className={`min-h-6 px-2 rounded text-[11px] ${activeOnly ? 'font-bold underline underline-offset-4 decoration-2' : ''} ${FOCUS_RING}`}
              style={{
                background: activeOnly ? COLORS.toggleActive : COLORS.toggleInactive,
                border: `1px solid ${COLORS.controlBorder}`,
                color: activeOnly ? COLORS.holoBright : COLORS.textMuted,
              }}
            >
              Active only
            </button>
          )}
        >
          <span className="text-[11px] tracking-wider" style={{ color: COLORS.textPrimary }}>
            SESSIONS
          </span>
          <span className="text-[11px]" style={{ color: COLORS.textMuted }}>
            {activeCount} active / {sessions.length}
          </span>
        </PanelHeader>

        <div
          ref={listRef}
          className="overflow-y-auto"
          style={{ maxHeight: 'calc(100vh - var(--topbar-h, 60px) - 40px)' }}
        >
          {shownSessionCount === 0 && (
            <div className="text-[11px] py-2 text-center" style={{ color: COLORS.textMuted }}>
              {activeOnly && sessions.length > 0 ? 'No active session' : 'No session yet'}
            </div>
          )}
          <ul className="list-none p-0 m-0 space-y-0.5" aria-label="Sessions and agents">
            {rows.map(row => {
              const selected = row.id === selectedSessionId
              const rowBase = `flex w-full min-h-6 items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] hover:bg-white/5 ${selected ? 'font-semibold' : ''} ${FOCUS_RING}`
              const rowStyle = { color: selected ? COLORS.holoBright : COLORS.textMuted, background: selected ? COLORS.tabSelectedBg : undefined }

              if (row.kind === 'all') {
                return (
                  <li key={row.id}>
                    <button
                      type="button" data-row-main tabIndex={stopId === row.id ? 0 : -1}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => onSelectSession(ALL_SESSIONS_ID)}
                      className={rowBase} style={rowStyle}
                    >
                      <span className="flex-1">All sessions</span>
                      <span style={{ color: COLORS.textDim }}>{pluralize(allSessionCount ?? sessions.length, 'session')}</span>
                    </button>
                    {row.roots.length > 0 && (
                      <ul className="list-none p-0 m-0 pl-6" aria-label="Agents without a listed session">
                        {row.roots.map(n => (
                          <AgentItem key={n.agent.id} node={n} depth={0} selectedAgentId={selectedAgentId} onSelectAgent={onSelectAgent} freshnessNow={freshnessNow} />
                        ))}
                      </ul>
                    )}
                  </li>
                )
              }

              if (row.kind === 'team') {
                const key = row.teamName!
                const name = teams?.get(key)?.name ?? key
                const members = Math.max(teamMemberCounts?.get(key) ?? 0, teams?.get(key)?.members.length ?? 0)
                const summary = formatTeamSummary(name, members, teamWorking?.get(key) ?? 0)
                return (
                  <li key={row.id}>
                    <button
                      type="button" data-row-main tabIndex={stopId === row.id ? 0 : -1}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => onSelectSession(row.id)}
                      title={summary} className={`${rowBase} mt-1`} style={rowStyle}
                    >
                      <span className="truncate">{summary}</span>
                      <span className="sr-only">, whole team in one view</span>
                    </button>
                  </li>
                )
              }

              const session = row.session!
              const kind = sessionStatusKind(session, sessionsWithActivity.has(session.id), selected, isObservedId)
              const unobserved = kind === 'unobserved'
              const badge = runtimeBadge(session.runtime)
              const modelId = sessionModels?.get(session.id)
              const model = modelId ? formatModelName(modelId) : null
              const isCollapsed = collapsed.has(session.id)
              const hasAgents = row.roots.length > 0
              const showAgents = hasAgents && !isCollapsed
              return (
                <li key={row.id} className={row.teamName ? 'pl-3' : undefined}>
                  <div className="group flex items-center">
                    <button
                      type="button"
                      aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} agents of ${session.label}`}
                      aria-expanded={hasAgents ? !isCollapsed : undefined}
                      disabled={!hasAgents}
                      onClick={() => toggleCollapsed(session.id, !isCollapsed)}
                      className={`inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded text-[11px] ${FOCUS_RING}`}
                      style={{ color: hasAgents ? COLORS.textMuted : 'transparent' }}
                    >
                      <span aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
                    </button>
                    <button
                      type="button" data-row-main data-session-id={hasAgents ? session.id : undefined}
                      data-closable-id={session.id}
                      tabIndex={stopId === row.id ? 0 : -1}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => onSelectSession(session.id)}
                      className={`${rowBase} min-w-0 flex-1`} style={rowStyle}
                    >
                      {unobserved
                        ? <span aria-hidden="true" className="inline-block w-3 shrink-0" />
                        : <SessionMarker kind={kind} />}
                      <span className="sr-only">
                        {unobserved ? `${SESSION_STATUS_TEXT[kind]}. ${SESSION_NOT_OBSERVED_HELP}` : SESSION_STATUS_TEXT[kind]}
                        ,{' '}
                      </span>
                      {badge && <span className="sr-only">{badge.label} session, </span>}
                      <span className="truncate min-w-0 flex-1 text-xs font-semibold" style={{ color: selected ? COLORS.holoBright : COLORS.textPrimary }} title={session.label}>{session.label}</span>
                      {unobserved && (
                        <span aria-hidden="true" className="shrink-0 text-[11px]" style={{ color: COLORS.textMuted }} title={SESSION_NOT_OBSERVED_HELP}>
                          {SESSION_STATUS_TEXT[kind]}
                        </span>
                      )}
                      {model && <span className="shrink-0 rounded px-1.5 text-[11px] leading-4" style={{ border: `1px solid ${COLORS.tabInactiveBorder}`, color: COLORS.textMuted }}>{model}</span>}
                      <span className="shrink-0 tabular-nums" style={{ color: COLORS.textDim }}>{formatRelativeTime(session.lastActivityTime, currentTime)}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Close session ${session.label}`}
                      title="Close session"
                      onClick={() => onCloseSession(session.id)}
                      className={`min-h-6 min-w-6 rounded text-[11px] leading-none opacity-70 group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100 transition-opacity ${FOCUS_RING}`}
                      style={{ color: COLORS.tabClose }}
                    >
                      <span aria-hidden="true">✕</span>
                    </button>
                  </div>
                  {showAgents && (
                    <ul className="list-none p-0 m-0 pl-6" aria-label={`Agents of ${session.label}`}>
                      {row.roots.map(n => (
                        <AgentItem
                          key={n.agent.id} node={n} depth={0}
                          selectedAgentId={selectedAgentId} onSelectAgent={onSelectAgent} freshnessNow={freshnessNow}
                        />
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="mt-2 mb-0 text-[11px]" style={{ color: COLORS.textDim }}>
            Agents are listed for the sessions of the current view. Select a session to see its agents.
          </p>
        </div>
      </div>
    </SlidingPanel>
    </>
  )
}
