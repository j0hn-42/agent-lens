'use client'

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useEffect, useSyncExternalStore } from 'react'
import { Z } from '@/lib/agent-types'
import type { TeamSummary } from '@/lib/agent-types'
import type { GroupSummary } from '@/hooks/simulation/team-info'
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
import { rollupBranch, rollupRows, formatRollup, ROLLUP_INCOMPLETE_HELP, type RollupTotal } from '@/lib/cost-rollup'
import { observedSessions, isSessionObserved, SESSION_NOT_OBSERVED_HELP, SESSION_INDEXED_HELP } from '@/lib/session-model'
import { useFreshnessValue, getFreshnessClock, type FreshnessClock } from '@/hooks/use-freshness-clock'
import { freshnessKey } from '@/hooks/simulation/freshness'
import { agentRowView, agentTreeSignature, focusKeyOf, restoreFocusByKey, rowRenderProbe } from '@/lib/row-sync'
import {
  agentNamesBySession, effectiveFilter, filterSessionList, isFilterActive, projectOptions, runtimeOptions,
  type RuntimeFilter, type SessionFilter,
} from '@/lib/session-filter'
import { summarizeAttention, sessionAttentionText, type AttentionSummary } from '@/lib/attention'
import { emptyMatch } from '@/lib/ui-glossary'
import { FreshnessAnnouncer } from './freshness-announcer'
import { INSPECTOR_KEEP_ATTR, PanelHeader, SlidingPanel } from './shared-ui'
import { CollapsibleSection } from './collapsible-section'

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
  teamSummaries?: ReadonlyMap<string, GroupSummary>
  teamMemberCounts?: ReadonlyMap<string, number>
  /** Sessions the 'All' view counts (defaults to every session) */
  allSessionCount?: number
  /** Clock override for tests */
  now?: number
  /** Sessions heard from in this run (defaults to the app-wide tracker fed by the simulation) */
  observedSessionIds?: ReadonlySet<string>
  /** Attention of every session (agents of the other sessions included); defaults to the agents of this list */
  attention?: AttentionSummary
  /** Freshness clock override for tests */
  freshnessClock?: FreshnessClock
  /** Project / runtime filter (persisted by the parent); when absent the panel keeps its own */
  filterProject?: string | null
  filterRuntime?: RuntimeFilter | null
  onFilterChange?: (change: { projectId?: string | null; runtime?: RuntimeFilter | null }) => void
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

/** "Σ $0.12 · 4.2k (incomplete)": the (incomplete) badge is spelled out for screen readers. */
function RollupLabel({ total, label }: { total: RollupTotal; label: string }) {
  const text = formatRollup(total)
  return (
    <span
      className="shrink-0 tabular-nums"
      style={{ color: total.complete && total.known > 0 ? COLORS.textMuted : COLORS.waiting_permission }}
      title={total.complete ? undefined : ROLLUP_INCOMPLETE_HELP}
    >
      <span className="sr-only">{label}, </span>
      <span aria-hidden="true">Σ </span>
      {text}
      {!total.complete && <span className="sr-only">. {ROLLUP_INCOMPLETE_HELP}</span>}
    </span>
  )
}

interface AgentItemProps {
  node: AgentNode<SessionListAgent>
  depth: number
  selectedAgentId: string | null
  onSelectAgent: (id: string) => void
  freshnessNow: number
  /** What this row and its subtree show (agentTreeSignature): equal signature = nothing to rebuild */
  sig: string
}

/** Row rebuilt only when its signature changes, so frequent agent events leave the other rows (and their focus) alone. */
const AgentItem = memo(function AgentItem({ node, depth, selectedAgentId, onSelectAgent, freshnessNow }: AgentItemProps) {
  const a = node.agent
  rowRenderProbe.onRender?.(a.id)
  const selected = a.id === selectedAgentId
  const { detail, stale, role } = agentRowView(a, freshnessNow)
  // The orchestrator plus its sub-agents, each counted once (issue #58)
  const branch = useMemo(() => (node.children.length > 0 ? rollupBranch(node) : null), [node])
  return (
    <li>
      <button
        type="button"
        data-row-main
        data-row-key={`agent:${a.id}`}
        tabIndex={-1}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelectAgent(a.id)}
        className={`flex w-full min-h-6 flex-wrap items-center gap-x-1.5 gap-y-0 rounded py-0.5 pr-2 text-left text-[11px] hover:bg-white/5 ${selected ? 'font-semibold' : ''} ${FOCUS_RING}`}
        style={{ paddingLeft: 8 + depth * 14, color: selected ? COLORS.holoBright : COLORS.textMuted, background: selected ? COLORS.tabSelectedBg : undefined }}
      >
        <span aria-hidden="true" className="shrink-0" style={{ color: COLORS.textDim }}>{depth > 0 ? '└' : ''}</span>
        <StateMarker state={stale ? 'idle' : a.state} />
        <span className="sr-only">{role}, </span>
        <span className="truncate min-w-[7ch] basis-[7ch] flex-1">{a.name}</span>
        <span className="shrink-0" style={{ color: stale ? COLORS.textMuted : STATE_COLOR[a.state] ?? COLORS.textMuted }}>{detail}</span>
        <span className="shrink-0 tabular-nums" style={{ color: COLORS.textDim }}>{formatTokenUsage(usageFromAgent(a))}</span>
        {branch && <RollupLabel total={branch} label="branch total" />}
      </button>
      {node.children.length > 0 && (
        <ul className="list-none p-0 m-0" aria-label={`Sub-agents of ${a.name}`}>
          {node.children.map(c => (
            <AgentItem
              key={c.agent.id} node={c} depth={depth + 1} selectedAgentId={selectedAgentId} onSelectAgent={onSelectAgent}
              freshnessNow={freshnessNow} sig={agentTreeSignature(c, freshnessNow, selectedAgentId)}
            />
          ))}
        </ul>
      )}
    </li>
  )
}, (prev, next) => prev.sig === next.sig && prev.depth === next.depth && prev.onSelectAgent === next.onSelectAgent)

export function SessionListPanel({
  visible, onClose, sessions, selectedSessionId, sessionsWithActivity, sessionModels,
  onSelectSession, onCloseSession, agents, selectedAgentId, onSelectAgent,
  teams, teamWorking, teamSummaries, teamMemberCounts, allSessionCount, now, observedSessionIds, freshnessClock, attention: sharedAttention,
  filterProject, filterRuntime, onFilterChange,
}: SessionListPanelProps) {
  const listRef = useRef<HTMLDivElement>(null)
  // A new callback identity on every parent render would defeat the row signatures
  const onSelectAgentRef = useRef(onSelectAgent)
  onSelectAgentRef.current = onSelectAgent
  const stableSelectAgent = useCallback((id: string) => onSelectAgentRef.current(id), [])
  const [announcement, setAnnouncement] = useState('')
  // Focus is read before React commits (the focused node may be replaced) and put back right after
  const focusKeyRef = useRef<string | null>(null)
  focusKeyRef.current = typeof document === 'undefined' ? null : focusKeyOf(document.activeElement as HTMLElement | null)
  useLayoutEffect(() => {
    if (listRef.current) restoreFocusByKey(listRef.current, focusKeyRef.current, document.activeElement, document.body)
  })
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

  // Search and project / runtime filter (#125)
  const [query, setQuery] = useState('')
  const [ownProject, setOwnProject] = useState<string | null>(null)
  const [ownRuntime, setOwnRuntime] = useState<RuntimeFilter | null>(null)
  const filter: SessionFilter = useMemo(
    () => effectiveFilter({ query, projectId: filterProject !== undefined ? filterProject : ownProject, runtime: filterRuntime !== undefined ? filterRuntime : ownRuntime }, sessions),
    [query, filterProject, ownProject, filterRuntime, ownRuntime, sessions],
  )
  const filtering = isFilterActive(filter)
  const projects = useMemo(() => projectOptions(sessions), [sessions])
  const runtimes = useMemo(() => runtimeOptions(sessions), [sessions])
  const namesBySession = useMemo(() => (filter.query.trim() ? agentNamesBySession(agents.values()) : new Map<string, string[]>()), [agents, filter.query])
  const matching = useMemo(() => new Set(filterSessionList(sessions, filter, id => namesBySession.get(id) ?? [])), [sessions, filter, namesBySession])
  const changeFilter = (change: { projectId?: string | null; runtime?: RuntimeFilter | null }) => {
    if (change.projectId !== undefined) { setOwnProject(change.projectId); onFilterChange?.({ projectId: change.projectId }) }
    if (change.runtime !== undefined) { setOwnRuntime(change.runtime); onFilterChange?.({ runtime: change.runtime }) }
  }
  const announceMatches = (next: SessionFilter) => {
    const names = agentNamesBySession(agents.values())
    const n = filterSessionList(sessions, next, id => names.get(id) ?? []).length
    setAnnouncement(n === 0 ? emptyMatch('sessions') : `${pluralize(n, 'session')} shown`)
  }

  // Agents waiting for a permission or in error, per session (#126)
  const ownAttention = useMemo(() => summarizeAttention(agents.values(), freshnessNow), [agents, freshnessNow])
  const attention = sharedAttention ?? ownAttention

  const rows = useMemo(() => {
    // 'Active only' keeps the sessions proven active (and the selected one): a listed-but-unobserved
    // session is not counted as active, so it is hidden too
    const active = activeOnly ? filterActiveSessions(sessions, selectedSessionId, isObserved) : sessions
    const shown = filtering ? active.filter(s => matching.has(s)) : active
    // A team row only makes sense with teammates: every Claude Code session owns a team holding just its lead,
    // and listing it would add a "Team session-xxxx: 0 members" row per session
    const listed = teams
      ? new Map([...teams].filter(([key, team]) => Math.max(teamMemberCounts?.get(key) ?? 0, team.members.length) > 0))
      : undefined
    const teamNames = listed ? [...listed.keys()] : []
    // A team is listed with a filter only through a session that matches
    const teamsKept = filtering ? teamNames.filter(n => shown.some(s => s.teamName === n)) : teamNames
    return buildSessionRows(
      shown, activeOnly ? filterActiveTeams(teamsKept, shown, teamWorking, teamSummaries) : teamsKept, forests, listed,
      { hideUnlistedTeams: true }, isObserved,
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps -- isObserved reads the tracker version / props listed here
  }, [sessions, teams, teamWorking, teamSummaries, teamMemberCounts, forests, activeOnly, filtering, matching, selectedSessionId, observedSessionIds, sessionsWithActivity, observedVersion])
  const hasProjectHeadings = rows.some(r => r.kind === 'project')
  const shownSessionCount = rows.filter(r => r.kind === 'session').length
  // Session and team (family) totals; the team total counts an agent shared by two sessions once
  const rollups = useMemo(() => rollupRows(rows, { sessions, forests }), [rows, sessions, forests])
  const activeCount = sessions.filter(s => s.status === 'active' && isObserved(s)).length

  const toggleCollapsed = (id: string, collapse: boolean) => {
    const label = sessions.find(s => s.id === id)?.label ?? id
    setAnnouncement(`Agents of ${label} ${collapse ? 'collapsed' : 'expanded'}`)
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
    // Rows inside a folded (inert) section are not reachable
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-row-main]') ?? []).filter(el => !el.closest('[inert]'))
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
      position={{ top: 'calc(var(--topbar-h, 60px) + 8px)', left: 12 }}
      axis="X"
      offset={-8}
      zIndex={Z.sidePanel}
      width={380}
      labelledBy="session-list-title"
      attrs={{ [INSPECTOR_KEEP_ATTR]: '' }}
    >
      <div className="glass-card relative font-mono" style={{ background: COLORS.void }}>
        <PanelHeader
          onClose={onClose}
          titleId="session-list-title"
          actions={(
            <button
              type="button"
              aria-pressed={activeOnly}
              onClick={() => { setAnnouncement(`${activeOnly ? 'All sessions' : 'Active sessions only'}: ${(activeOnly ? sessions : filterActiveSessions(sessions, selectedSessionId, isObserved)).length} shown`); setActiveOnly(v => !v) }}
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

        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-panel-announcer>{announcement}</div>
        <div role="search" aria-label="Search and filter sessions" className="flex flex-wrap items-center gap-1.5 px-2 pb-1.5 text-[11px]">
          <input
            type="search"
            aria-label="Search sessions"
            placeholder="Search name, project, agent"
            value={query}
            onChange={e => { setQuery(e.target.value); announceMatches({ ...filter, query: e.target.value }) }}
            className={`min-h-6 min-w-0 flex-1 rounded px-2 text-[11px] ${FOCUS_RING}`}
            style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
          />
          {(projects.length > 1 || filter.projectId !== null) && (
            <select
              aria-label="Filter by project"
              value={filter.projectId ?? ''}
              onChange={e => { const projectId = e.target.value || null; changeFilter({ projectId }); announceMatches({ ...filter, projectId }) }}
              className={`min-h-6 max-w-[40%] rounded px-1 text-[11px] ${FOCUS_RING}`}
              style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textMuted }}
            >
              <option value="">All projects</option>
              {projects.map(p => <option key={p.projectId} value={p.projectId}>{p.projectName}</option>)}
            </select>
          )}
          {(runtimes.length > 1 || filter.runtime !== null) && (
            <select
              aria-label="Filter by runtime"
              value={filter.runtime ?? ''}
              onChange={e => { const runtime = (e.target.value || null) as RuntimeFilter | null; changeFilter({ runtime }); announceMatches({ ...filter, runtime }) }}
              className={`min-h-6 rounded px-1 text-[11px] ${FOCUS_RING}`}
              style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textMuted }}
            >
              <option value="">All runtimes</option>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          )}
          {filtering && (
            <button
              type="button"
              onClick={() => { setQuery(''); changeFilter({ projectId: null, runtime: null }); setAnnouncement(`Filter cleared: ${pluralize(sessions.length, 'session')} shown`) }}
              className={`min-h-6 px-2 rounded text-[11px] ${FOCUS_RING}`}
              style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textMuted }}
            >
              Clear filter
            </button>
          )}
          {filtering && (
            <p className="m-0 w-full" style={{ color: COLORS.textDim }}>
              Filter applies to this list only; the canvas still shows every session of the view.
            </p>
          )}
        </div>
        <div
          ref={listRef}
          className="overflow-y-auto"
          style={{ maxHeight: 'calc(100vh - var(--topbar-h, 60px) - 40px)' }}
        >
          {shownSessionCount === 0 && (
            <div className="text-[11px] py-2 text-center" style={{ color: COLORS.textMuted }}>
              {filtering && sessions.length > 0 ? emptyMatch('sessions') : activeOnly && sessions.length > 0 ? 'No active session' : 'No session yet'}
            </div>
          )}
          <ul className="list-none p-0 m-0 space-y-0.5" aria-label="Sessions and agents">
            {rows.map(row => {
              const selected = row.id === selectedSessionId
              const rowBase = `flex w-full min-h-6 flex-wrap items-center gap-x-1.5 gap-y-0 rounded px-2 py-1 text-left text-[11px] hover:bg-white/5 ${selected ? 'font-semibold' : ''} ${FOCUS_RING}`
              const rowStyle = { color: selected ? COLORS.holoBright : COLORS.textMuted, background: selected ? COLORS.tabSelectedBg : undefined }

              if (row.kind === 'project') {
                return (
                  <li key={row.id} className="mt-1.5 px-2 pt-1 text-[11px] tracking-wider uppercase truncate" style={{ color: COLORS.textDim }} title={row.projectName}>
                    <span className="sr-only">Project </span>{row.projectName}
                  </li>
                )
              }

              if (row.kind === 'all') {
                return (
                  <li key={row.id}>
                    <button
                      type="button" data-row-main data-row-key={`session:${row.id}`} tabIndex={stopId === row.id ? 0 : -1}
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
                          <AgentItem key={n.agent.id} node={n} depth={0} selectedAgentId={selectedAgentId} onSelectAgent={stableSelectAgent} freshnessNow={freshnessNow} sig={agentTreeSignature(n, freshnessNow, selectedAgentId)} />
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
                const summary = formatTeamSummary(name, members, teamWorking?.get(key) ?? 0, teams?.get(key)?.kind)
                return (
                  <li key={row.id}>
                    <button
                      type="button" data-row-main data-row-key={`session:${row.id}`} tabIndex={stopId === row.id ? 0 : -1}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => onSelectSession(row.id)}
                      title={summary} className={`${rowBase} mt-1`} style={rowStyle}
                    >
                      <span className="truncate">{summary}</span>
                      <span className="sr-only">, whole team in one view</span>
                      {rollups.get(row.id) && <RollupLabel total={rollups.get(row.id)!} label="family total" />}
                    </button>
                  </li>
                )
              }

              const session = row.session!
              const kind = sessionStatusKind(session, sessionsWithActivity.has(session.id), selected, isObservedId)
              const unobserved = kind === 'unobserved' || kind === 'indexed'
              const statusHelp = kind === 'indexed' ? SESSION_INDEXED_HELP : SESSION_NOT_OBSERVED_HELP
              const badge = runtimeBadge(session.runtime)
              const modelId = sessionModels?.get(session.id)
              const model = modelId ? formatModelName(modelId) : null
              const isCollapsed = collapsed.has(session.id)
              const hasAgents = row.roots.length > 0
              return (
                <li key={row.id} className={row.teamName || hasProjectHeadings ? 'pl-3' : undefined}>
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
                      type="button" data-row-main data-row-key={`session:${row.id}`} data-session-id={hasAgents ? session.id : undefined}
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
                        {unobserved ? `${SESSION_STATUS_TEXT[kind]}. ${statusHelp}` : SESSION_STATUS_TEXT[kind]}
                        ,{' '}
                      </span>
                      {badge && <span className="sr-only">{badge.label} session, </span>}
                      <span className="truncate min-w-[7ch] basis-[7ch] flex-1 text-xs font-semibold" style={{ color: selected ? COLORS.holoBright : COLORS.textPrimary }} title={session.label}>{session.label}</span>
                      {unobserved && (
                        <span aria-hidden="true" className="shrink-0 text-[11px]" style={{ color: COLORS.textMuted }} title={statusHelp}>
                          {SESSION_STATUS_TEXT[kind]}
                        </span>
                      )}
                      {sessionAttentionText(attention.bySession.get(session.id)) && (
                        <span className="shrink-0 font-semibold" data-testid="session-attention" style={{ color: attention.bySession.get(session.id)!.waiting > 0 ? COLORS.waiting_permission : COLORS.error }}>
                          <span aria-hidden="true">! </span>{sessionAttentionText(attention.bySession.get(session.id))}
                        </span>
                      )}
                      {model && <span className="shrink-0 rounded px-1.5 text-[11px] leading-4" style={{ border: `1px solid ${COLORS.tabInactiveBorder}`, color: COLORS.textMuted }}>{model}</span>}
                      {hasAgents && rollups.get(row.id) && <RollupLabel total={rollups.get(row.id)!} label="session total" />}
                      <span className="shrink-0 tabular-nums" style={{ color: COLORS.textDim }}>{session.lastActivityUnknown ? 'activity unknown' : formatRelativeTime(session.lastActivityTime, currentTime)}</span>
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
                  {hasAgents && (
                    <CollapsibleSection open={!isCollapsed}>
                    <ul className="list-none p-0 m-0 pl-6" aria-label={`Agents of ${session.label}`}>
                      {row.roots.map(n => (
                        <AgentItem
                          key={n.agent.id} node={n} depth={0}
                          selectedAgentId={selectedAgentId} onSelectAgent={stableSelectAgent} freshnessNow={freshnessNow}
                          sig={agentTreeSignature(n, freshnessNow, selectedAgentId)}
                        />
                      ))}
                    </ul>
                    </CollapsibleSection>
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
