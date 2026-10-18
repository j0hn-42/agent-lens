'use client'

import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, useEffect, useSyncExternalStore } from 'react'
import { Z } from '@/lib/agent-types'
import type { TeamSummary } from '@/lib/agent-types'
import type { GroupSummary } from '@/hooks/simulation/team-info'
import { COLORS, themed } from '@/lib/colors'
import { useThemeVersion } from '@/lib/theme'
import { usageFromAgent } from '@/lib/usage'
import { deriveFreshness } from '@/hooks/simulation/freshness'
import { modelCell, tokensCell, rollupTokensCell, sessionTimeCell, costCell, branchCell, runtimeCell, activityCell } from '@/lib/session-columns'
import { stateMarkerShape, stateMarkerBox } from '@/lib/session-state-marker'
import { ALL_SESSIONS_ID, type SessionInfo } from '@/lib/bridge-types'
import { runtimeBadge, sessionStatusKind, viewCountsText, type AgentStateCounts, type SessionStatusKind } from '@/lib/chrome-utils'
import { FOCUS_RING } from '@/lib/focus-ring'
import {
  buildAgentForests, buildSessionRows, filterActiveSessions, filterActiveTeams,
  type AgentLike, type AgentNode,
} from '@/lib/session-tree'
import { rollupBranch, rollupRows, formatRollup, ROLLUP_INCOMPLETE_HELP, type RollupTotal } from '@/lib/cost-rollup'
import { observedSessions, isSessionObserved } from '@/lib/session-model'
import { useLocale, useT } from '@/lib/locale'
import * as C from '@/lib/card-text'
import { useFreshnessValue, getFreshnessClock, type FreshnessClock } from '@/hooks/use-freshness-clock'
import { freshnessKey } from '@/hooks/simulation/freshness'
import { agentRowView, agentTreeSignature, focusKeyOf, restoreFocusByKey, rowRenderProbe } from '@/lib/row-sync'
import {
  agentNamesBySession, branchOptions, effectiveFilter, filterSessionList, isFilterActive, projectOptions, runtimeOptions,
  type RuntimeFilter, type SessionFilter,
} from '@/lib/session-filter'
import { summarizeAttention, type AttentionSummary } from '@/lib/attention'
import type { HealthVerdict } from '@/lib/loop-detection'
import { ALIAS_MAX_LENGTH, sanitizeAlias } from '@/lib/session-aliases'
import { folderPrefixedLabel } from '@/lib/session-tabs'
import { FreshnessAnnouncer } from './freshness-announcer'
import { INSPECTOR_KEEP_ATTR, DockResizer, PanelHeader, SlidingPanel, useDockSnapshot } from './shared-ui'
import { clampLeftPanelWidth, leftPanelWidthBounds } from '@/lib/panel-layout'
import { CollapsibleSection } from './collapsible-section'
import { groupByPhase } from '@/lib/phase-groups'
import { BlankCell, COLUMN_CLASSES, ColumnHeader, ColumnValue, LiveTimeValue, ROW_GRID } from './session-columns'

export type SessionListAgent = AgentLike

/** Default width (px) of the panel: room for the Name / Model / Tokens / Time columns (was 380). */
export const SESSIONS_PANEL_WIDTH = 480
const SESSIONS_WIDTH_KEY = 'agent-lens.sessionsPanelWidth'

function readStoredWidth(): number {
  try {
    const n = Number(window.localStorage.getItem(SESSIONS_WIDTH_KEY))
    return Number.isFinite(n) && n > 0 ? n : SESSIONS_PANEL_WIDTH
  } catch { return SESSIONS_PANEL_WIDTH }
}

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
  /** Give a session a name of your own (#246); an empty name restores the original label. Absent = no rename control. */
  onRenameSession?: (id: string, name: string) => void
  /** Save a session as a standalone HTML replay (#237). Absent (demo) = no export control. */
  onExportSession?: (id: string) => void
  /** True when the session has events in memory to export; the button is drawn only then */
  canExportSession?: (id: string) => boolean
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
  /** Agents of the view by state (#523: drawn in the header, moved from the top bar); absent = not drawn */
  agentCounts?: AgentStateCounts
  /** Clock override for tests */
  now?: number
  /** The relay is offline: no active session is proven to run, and durations stop at the last activity (#367) */
  relayOffline?: boolean
  /** Sessions heard from in this run (defaults to the app-wide tracker fed by the simulation) */
  observedSessionIds?: ReadonlySet<string>
  /** Attention of every session (agents of the other sessions included); defaults to the agents of this list */
  attention?: AttentionSummary
  /** Loop verdict per session id (#230): only sessions whose events are in the view have one */
  health?: ReadonlyMap<string, HealthVerdict>
  /** Freshness clock override for tests */
  freshnessClock?: FreshnessClock
  /** Project / runtime filter (persisted by the parent); when absent the panel keeps its own */
  filterProject?: string | null
  filterRuntime?: RuntimeFilter | null
  filterBranch?: string | null
  onFilterChange?: (change: { projectId?: string | null; runtime?: RuntimeFilter | null; branch?: string | null }) => void
  /** Why an empty list may be incomplete (#291): shown with the empty state when the scope is a single workspace */
  scopeHint?: string | null
  /** 'Active only' filter (persisted by the parent, #372); when absent the panel keeps its own, on by default */
  activeOnly?: boolean
  onActiveOnlyChange?: (activeOnly: boolean) => void
}

const STATE_COLOR: Record<string, string> = themed(() => ({
  thinking: COLORS.thinking,
  tool_calling: COLORS.tool_calling,
  waiting_permission: COLORS.waiting_permission,
  error: COLORS.error,
  complete: COLORS.complete,
}))

/** Marker with one shape per state (lib/session-state-marker, #381), so neither colour nor the pulse is ever the only cue. */
function StateMarker({ state }: { state: string }) {
  const color = STATE_COLOR[state] ?? (state === 'paused' ? COLORS.paused : COLORS.idle)
  const shape = stateMarkerShape(state)
  if (shape === 'check' || shape === 'cross') {
    return <span aria-hidden="true" data-state-marker={shape} className="w-3 shrink-0 text-[11px] leading-none" style={{ color }}>{shape === 'check' ? '✓' : '✕'}</span>
  }
  const box = stateMarkerBox(shape, color)
  return (
    <span
      aria-hidden="true"
      data-state-marker={shape}
      className={`inline-block shrink-0 ${box.className} ${state === 'waiting_permission' ? 'motion-safe:animate-pulse' : ''}`}
      style={box.style}
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
      style={{ color: total.complete && total.known > 0 ? COLORS.textMuted : COLORS.warn }}
      title={total.complete ? undefined : ROLLUP_INCOMPLETE_HELP}
      lang="en" data-i18n-exempt=""
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
  useThemeVersion() // memoized row: repaint on a theme switch
  const t = useT() // memoized row: re-render on a language switch
  const a = node.agent
  rowRenderProbe.onRender?.(a.id)
  const selected = a.id === selectedAgentId
  const { detail, stale, role } = agentRowView(a, freshnessNow)
  // The orchestrator plus its sub-agents, each counted once (issue #58)
  const branch = useMemo(() => (node.children.length > 0 ? rollupBranch(node) : null), [node])
  // This agent alone (its sub-agents are in the branch total)
  const own = useMemo(() => rollupBranch({ agent: node.agent, children: [] }), [node.agent])
  return (
    <li>
      <button
        type="button"
        data-row-main
        data-row-key={`agent:${a.id}`}
        lang="en" data-i18n-exempt=""
        tabIndex={-1}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelectAgent(a.id)}
        className={`${ROW_GRID} w-full min-h-6 rounded py-0.5 pr-2 text-left text-[11px] hover:bg-[var(--lens-hover-05)] ${selected ? 'font-semibold' : ''} ${FOCUS_RING}`}
        style={{ paddingLeft: 8 + depth * 14, color: selected ? COLORS.holoBright : COLORS.textMuted, background: selected ? COLORS.tabSelectedBg : undefined }}
      >
        <span className={`flex min-w-0 items-center gap-x-1.5 ${COLUMN_CLASSES.name}`}>
          <span aria-hidden="true" className="shrink-0" style={{ color: COLORS.textDim }}>{depth > 0 ? '└' : ''}</span>
          <StateMarker state={stale ? 'idle' : a.state} />
          <span className="sr-only">{role}, </span>
          <span className="truncate min-w-[6ch] flex-1" title={a.name}>{a.name}</span>
          <span className="max-w-[45%] shrink-0 truncate" title={detail} style={{ color: stale ? COLORS.textMuted : STATE_COLOR[a.state] ?? COLORS.textMuted }}>{detail}</span>
        </span>
        <ColumnValue column="model" cell={modelCell(a.model)} title={a.model} />
        <BlankCell column="runtime" />
        <BlankCell column="branch" />
        <ColumnValue column="tokens" cell={tokensCell(usageFromAgent(a))} />
        <ColumnValue column="cost" cell={costCell(own)} />
        <LiveTimeValue agent={a} freshness={deriveFreshness(a, freshnessNow)} />
        <BlankCell column="activity" />
        {branch && (
          <span className={COLUMN_CLASSES.secondLine} style={{ paddingLeft: 20 }}>
            <RollupLabel total={branch} label="branch total" />
          </span>
        )}
      </button>
      {node.children.length > 0 && (
        <ul className="list-none p-0 m-0" aria-label={t('sessions.subAgentsOf', { name: a.name })}>
          <AgentNodes
            nodes={node.children} depth={depth + 1} selectedAgentId={selectedAgentId} onSelectAgent={onSelectAgent}
            freshnessNow={freshnessNow}
          />
        </ul>
      )}
    </li>
  )
}, (prev, next) => prev.sig === next.sig && prev.depth === next.depth && prev.onSelectAgent === next.onSelectAgent)

interface AgentNodesProps {
  nodes: ReadonlyArray<AgentNode<SessionListAgent>>
  depth: number
  selectedAgentId: string | null
  onSelectAgent: (id: string) => void
  freshnessNow: number
}

/**
 * Sibling rows. The agents of a workflow that announced phases are grouped under one named group per
 * phase, in order of first appearance (#146); everything else is listed exactly as before.
 */
function AgentNodes({ nodes, depth, selectedAgentId, onSelectAgent, freshnessNow }: AgentNodesProps) {
  const t = useT()
  const row = (n: AgentNode<SessionListAgent>, d: number) => (
    <AgentItem
      key={n.agent.id} node={n} depth={d} selectedAgentId={selectedAgentId} onSelectAgent={onSelectAgent}
      freshnessNow={freshnessNow} sig={agentTreeSignature(n, freshnessNow, selectedAgentId)}
    />
  )
  return (
    <>
      {groupByPhase(nodes.map(n => ({ node: n, teamKind: n.agent.teamKind, phase: n.agent.phase }))).map(seg => {
        if (seg.kind === 'plain') return seg.items.map(i => row(i.node, depth))
        // "Phase 2": the word is the same in both languages and the phase name is the workflow's own
        const label = seg.kind === 'phase' ? `Phase ${seg.phase}` : seg.kind === 'none' ? t('sessions.phase.none') : ''
        return (
          <li key={`${seg.kind}:${label}`}>
            <div role="group" aria-label={label}>
              <p className="m-0 text-[11px] font-semibold" style={{ paddingLeft: 8 + depth * 14, color: COLORS.textMuted }}>
                {label} <span className="font-normal" style={{ color: COLORS.textDim }}>({seg.items.length})</span>
              </p>
              <ul className="list-none p-0 m-0">{seg.items.map(i => row(i.node, depth))}</ul>
            </div>
          </li>
        )
      })}
    </>
  )
}

export function SessionListPanel({
  visible, onClose, sessions, selectedSessionId, sessionsWithActivity, sessionModels,
  onSelectSession, onCloseSession, onRenameSession, onExportSession, canExportSession, agents, selectedAgentId, onSelectAgent,
  teams, teamWorking, teamSummaries, teamMemberCounts, allSessionCount, agentCounts, now, relayOffline = false, observedSessionIds, freshnessClock, attention: sharedAttention, health,
  filterProject, filterRuntime, filterBranch, onFilterChange, scopeHint, activeOnly: storedActiveOnly, onActiveOnlyChange,
}: SessionListPanelProps) {
  const { locale } = useLocale()
  const t = useT()
  const listRef = useRef<HTMLDivElement>(null)
  const searchHintId = useId()
  // User-resizable width (persisted); the viewport clamp keeps it responsive (narrow viewports get a full-width sheet)
  const [wantedWidth, setWantedWidth] = useState(SESSIONS_PANEL_WIDTH)
  useEffect(() => { setWantedWidth(readStoredWidth()) }, [])
  const { env, open: openPanels, layout } = useDockSnapshot()
  // Room beside the panel: the right dock and the agent card keep their place, so it can grow, never overlap
  const bounds = leftPanelWidthBounds(env.viewport.w, openPanels, layout.rightWidth)
  const panelWidth = clampLeftPanelWidth(wantedWidth, SESSIONS_PANEL_WIDTH, bounds)
  const resizePanel = (w: number) => {
    setWantedWidth(w)
    try { window.localStorage.setItem(SESSIONS_WIDTH_KEY, String(w)) } catch { /* not persisted */ }
  }
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
  const [ownActiveOnly, setOwnActiveOnly] = useState(true)
  const activeOnly = storedActiveOnly !== undefined ? storedActiveOnly : ownActiveOnly
  const setActiveOnly = (next: boolean) => { setOwnActiveOnly(next); onActiveOnlyChange?.(next) }

  // Search and project / runtime filter (#125)
  const [query, setQuery] = useState('')
  const [ownProject, setOwnProject] = useState<string | null>(null)
  const [ownRuntime, setOwnRuntime] = useState<RuntimeFilter | null>(null)
  const [ownBranch, setOwnBranch] = useState<string | null>(null)
  const filter: SessionFilter = useMemo(
    () => effectiveFilter({ query, projectId: filterProject !== undefined ? filterProject : ownProject, runtime: filterRuntime !== undefined ? filterRuntime : ownRuntime, branch: filterBranch !== undefined ? filterBranch : ownBranch }, sessions),
    [query, filterProject, ownProject, filterRuntime, ownRuntime, filterBranch, ownBranch, sessions],
  )
  const filtering = isFilterActive(filter)
  const projects = useMemo(() => projectOptions(sessions), [sessions])
  const runtimes = useMemo(() => runtimeOptions(sessions), [sessions])
  const branches = useMemo(() => branchOptions(sessions), [sessions])
  const namesBySession = useMemo(() => (filter.query.trim() ? agentNamesBySession(agents.values()) : new Map<string, string[]>()), [agents, filter.query])
  const matching = useMemo(() => new Set(filterSessionList(sessions, filter, id => namesBySession.get(id) ?? [])), [sessions, filter, namesBySession])
  const changeFilter = (change: { projectId?: string | null; runtime?: RuntimeFilter | null; branch?: string | null }) => {
    if (change.projectId !== undefined) { setOwnProject(change.projectId); onFilterChange?.({ projectId: change.projectId }) }
    if (change.runtime !== undefined) { setOwnRuntime(change.runtime); onFilterChange?.({ runtime: change.runtime }) }
    if (change.branch !== undefined) { setOwnBranch(change.branch); onFilterChange?.({ branch: change.branch }) }
  }
  const announceMatches = (next: SessionFilter) => {
    const names = agentNamesBySession(agents.values())
    const n = filterSessionList(sessions, next, id => names.get(id) ?? []).length
    setAnnouncement(n === 0 ? t('sessions.empty.match') : C.sessionsShownText(locale, n))
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

  // Inline rename (#246): one row at a time; Enter saves, Escape or leaving the field cancels
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const startRename = (id: string) => {
    if (!onRenameSession) return
    setDraft(sessions.find(s => s.id === id)?.label ?? '')
    setRenaming(id)
  }
  // The session left the list while its name was being edited: drop the edit, it must not come back with the id
  const renamingGone = renaming !== null && !sessions.some(s => s.id === renaming)
  useEffect(() => { if (renamingGone) setRenaming(null) }, [renamingGone])
  const endRename = (save: boolean, refocusRow = true) => {
    const id = renaming
    if (id === null) return
    setRenaming(null)
    if (save && onRenameSession) {
      onRenameSession(id, draft)
      setAnnouncement(sanitizeAlias(draft) === null ? t('sessions.announce.restored') : t('sessions.announce.renamed', { name: sanitizeAlias(draft)! }))
    }
    // Back on the row, whatever way the field was left
    if (refocusRow) requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-row-key="session:${id}"]`)?.focus())
  }

  const toggleCollapsed = (id: string, collapse: boolean) => {
    const label = sessions.find(s => s.id === id)?.label ?? id
    setAnnouncement(t(collapse ? 'sessions.announce.collapsed' : 'sessions.announce.expanded', { label }))
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
    } else if (e.key === 'F2') {
      const id = target.dataset.closableId
      if (id && onRenameSession) {
        e.preventDefault()
        startRename(id)
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

  const viewCounts = agentCounts
    ? viewCountsText(agentCounts, selectedSessionId === ALL_SESSIONS_ID ? (allSessionCount ?? sessions.length) : null)
    : null
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
      width={panelWidth}
      labelledBy="session-list-title"
      attrs={{ id: 'sessions-panel', [INSPECTOR_KEEP_ATTR]: '', lang: locale }}
    >
      <DockResizer edge="right" bounds={bounds} width={panelWidth} onWidthChange={resizePanel} label={t('sessions.resize', { name: t('sessions.title') })} valueText={px => t('sessions.resize.value', { px })} controls="sessions-panel" />
      <div className="glass-card relative font-mono" style={{ background: COLORS.void }}>
        <PanelHeader
          onClose={onClose}
          closeLabel={t('common.close')}
          titleId="session-list-title"
          actions={(
            <button
              type="button"
              aria-pressed={activeOnly}
              onClick={() => { setAnnouncement(t(activeOnly ? 'sessions.announce.all' : 'sessions.announce.activeOnly', { n: (activeOnly ? sessions : filterActiveSessions(sessions, selectedSessionId, isObserved)).length })); setActiveOnly(!activeOnly) }}
              title={t('sessions.activeOnlyHelp')}
              className={`min-h-6 px-2 rounded text-[11px] ${activeOnly ? 'font-bold underline underline-offset-4 decoration-2' : ''} ${FOCUS_RING}`}
              style={{
                background: activeOnly ? COLORS.toggleActive : COLORS.toggleInactive,
                border: `1px solid ${COLORS.controlBorder}`,
                color: activeOnly ? COLORS.holoBright : COLORS.textMuted,
              }}
            >
              {t('sessions.activeOnly')}
            </button>
          )}
        >
          <span className="text-[11px] uppercase tracking-wider" style={{ color: COLORS.textPrimary }}>
            {t('sessions.title')}
          </span>
          <span className="text-[11px]" style={{ color: COLORS.textMuted }}>
            {t('sessions.count', { active: activeCount, total: sessions.length })}
          </span>
        </PanelHeader>
        {viewCounts && (
          // #523: the agent counts of the view, moved from the top bar with the same text. English text (the qualifiers
          // "last known", "done" are those of the canvas and the docs); the full wording is read, the compact one drawn
          <p data-testid="sessions-agent-counts" lang="en" data-i18n-exempt="" className="m-0 px-2 pb-1.5 text-[11px] tabular-nums" style={{ color: COLORS.textMuted }}>
            <span aria-hidden="true">{viewCounts.drawn}</span>
            <span className="sr-only">{viewCounts.spoken}</span>
          </p>
        )}

        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-panel-announcer>{announcement}</div>
        <div role="search" aria-label={t('sessions.search.group')} className="flex flex-wrap items-center gap-1.5 px-2 pb-1.5 text-[11px]">
          <input
            type="search"
            aria-label={t('sessions.search')}
            placeholder={t('sessions.search')}
            aria-describedby={searchHintId}
            value={query}
            onChange={e => { setQuery(e.target.value); announceMatches({ ...filter, query: e.target.value }) }}
            className={`min-h-6 min-w-0 flex-1 rounded px-2 text-[11px] ${FOCUS_RING}`}
            style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
          />
          {(projects.length > 1 || filter.projectId !== null) && (
            <select
              aria-label={t('sessions.filter.project')}
              value={filter.projectId ?? ''}
              onChange={e => { const projectId = e.target.value || null; changeFilter({ projectId }); announceMatches({ ...filter, projectId }) }}
              className={`min-h-6 max-w-[40%] rounded px-1 text-[11px] ${FOCUS_RING}`}
              style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textMuted }}
            >
              <option value="">{t('sessions.filter.allProjects')}</option>
              {projects.map(p => <option key={p.projectId} value={p.projectId}>{p.projectName}</option>)}
            </select>
          )}
          {(runtimes.length > 1 || filter.runtime !== null) && (
            <select
              aria-label={t('sessions.filter.runtime')}
              value={filter.runtime ?? ''}
              onChange={e => { const runtime = (e.target.value || null) as RuntimeFilter | null; changeFilter({ runtime }); announceMatches({ ...filter, runtime }) }}
              className={`min-h-6 rounded px-1 text-[11px] ${FOCUS_RING}`}
              style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textMuted }}
            >
              <option value="">{t('sessions.filter.allRuntimes')}</option>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
              <option value="copilot">GitHub Copilot</option>
              <option value="pi">Pi</option>
              <option value="gemini">Gemini CLI</option>
              <option value="opencode">OpenCode</option>
            </select>
          )}
          {(branches.length > 0 || filter.branch !== null) && (
            <select
              aria-label={t('sessions.filter.branch')}
              value={filter.branch ?? ''}
              onChange={e => { const branch = e.target.value || null; changeFilter({ branch }); announceMatches({ ...filter, branch }) }}
              className={`min-h-6 max-w-[40%] rounded px-1 text-[11px] ${FOCUS_RING}`}
              style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textMuted }}
            >
              <option value="">{t('sessions.filter.allBranches')}</option>
              {branches.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          )}
          {filtering && (
            <button
              type="button"
              onClick={() => { setQuery(''); changeFilter({ projectId: null, runtime: null, branch: null }); setAnnouncement(C.filterClearedText(locale, sessions.length)) }}
              className={`min-h-6 px-2 rounded text-[11px] ${FOCUS_RING}`}
              style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textMuted }}
            >
              {t('sessions.filter.clear')}
            </button>
          )}
          {/* Visible text, not a title: a title shows only on mouse hover */}
          <p id={searchHintId} className="m-0 w-full text-[10px]" style={{ color: COLORS.textMuted }}>{t('sessions.search.hint')}</p>
          {filtering && (
            <p className="m-0 w-full" style={{ color: COLORS.textDim }}>
              {t('sessions.filter.scope')}
            </p>
          )}
        </div>
        <div
          ref={listRef}
          className="@container overflow-y-auto"
          style={{ maxHeight: 'calc(100vh - var(--topbar-h, 60px) - 40px)' }}
        >
          {rows.length > 0 && <ColumnHeader />}
          {shownSessionCount === 0 && (
            <div className="text-[11px] py-2 text-center" style={{ color: COLORS.textMuted }}>
              {filtering && sessions.length > 0 ? t('sessions.empty.match') : activeOnly && sessions.length > 0 ? t('sessions.empty.active') : t('sessions.empty.none')}
              {scopeHint && !filtering && <span className="block mt-1">{scopeHint}</span>}
            </div>
          )}
          <ul className="list-none p-0 m-0 space-y-0.5" aria-label={t('sessions.title')} data-sensitive="">
            {rows.map(row => {
              const selected = row.id === selectedSessionId
              const rowLook = `w-full min-h-6 rounded px-2 py-1 text-left text-[11px] hover:bg-[var(--lens-hover-05)] ${selected ? 'font-semibold' : ''} ${FOCUS_RING}`
              const rowBase = `flex flex-wrap items-center gap-x-1.5 gap-y-0 ${rowLook}`
              const rowStyle = { color: selected ? COLORS.holoBright : COLORS.textMuted, background: selected ? COLORS.tabSelectedBg : undefined }

              if (row.kind === 'project') {
                // The heading of the sessions outside any repository is ours (session-tree), a project name is data
                const heading = row.id === 'project:none' ? t('sessions.project.none') : row.projectName
                return (
                  <li key={row.id} className="mt-1.5 px-2 pt-1 text-[11px] tracking-wider uppercase truncate" style={{ color: COLORS.textDim }} title={heading}>
                    <span className="sr-only">{t('sessions.project')}{' '}</span>{heading}
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
                      <span className="flex-1">{t('sessions.allSessions')}</span>
                      <span style={{ color: COLORS.textDim }}>{C.sharedNounCount(allSessionCount ?? sessions.length, 'session')}</span>
                    </button>
                    {row.roots.length > 0 && (
                      <ul className="list-none p-0 m-0 pl-6 pr-6" aria-label={t('sessions.noListedSession')}>
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
                const summary = C.teamSummaryText(locale, name, members, teamWorking?.get(key) ?? 0, teams?.get(key)?.kind)
                return (
                  <li key={row.id}>
                    <button
                      type="button" data-row-main data-row-key={`session:${row.id}`} tabIndex={stopId === row.id ? 0 : -1}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => onSelectSession(row.id)}
                      title={summary} className={`${rowBase} mt-1`} style={rowStyle}
                    >
                      <span className="truncate">{summary}</span>
                      <span className="sr-only">{t('sessions.team.wholeView')}</span>
                      {rollups.get(row.id) && <RollupLabel total={rollups.get(row.id)!} label="family total" />}
                    </button>
                  </li>
                )
              }

              const session = row.session!
              const kind = sessionStatusKind(session, sessionsWithActivity.has(session.id), selected, isObservedId, relayOffline)
              const unobserved = kind === 'unobserved' || kind === 'indexed' || kind === 'imported' || kind === 'offline'
              const statusHelp = C.sessionStatusHelp(locale, kind === 'indexed' || kind === 'imported' || kind === 'offline' ? kind : 'unobserved')
              const statusText = C.sessionStatusText(locale, kind)
              const attentionOf = (id: string) => C.sessionAttentionLabel(locale, attention.bySession.get(id))
              const loopOf = (id: string) => C.sessionLoopText(locale, health?.get(id))
              const badge = runtimeBadge(session.runtime)
              const modelId = sessionModels?.get(session.id)
              const isCollapsed = collapsed.has(session.id)
              // Under a project heading the folder is already named; a team member has no heading (#246)
              const tabName = row.teamName ? folderPrefixedLabel(session, sessions) : session.label
              const hasAgents = row.roots.length > 0
              return (
                <li key={row.id} className={row.teamName || hasProjectHeadings ? 'pl-3' : undefined}>
                  <div className="group flex items-center">
                    <button
                      type="button"
                      aria-label={t(isCollapsed ? 'sessions.expand' : 'sessions.collapse', { label: session.label })}
                      aria-expanded={hasAgents ? !isCollapsed : undefined}
                      disabled={!hasAgents}
                      onClick={() => toggleCollapsed(session.id, !isCollapsed)}
                      className={`inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded text-xs ${hasAgents ? 'hover:bg-[var(--lens-hover-05)]' : ''} ${FOCUS_RING}`}
                      style={{
                        color: hasAgents ? COLORS.textPrimary : COLORS.textDim,
                        border: hasAgents ? `1px solid ${COLORS.controlBorder}` : '1px solid transparent',
                      }}
                    >
                      <span aria-hidden="true">{hasAgents ? (isCollapsed ? '▸' : '▾') : '·'}</span>
                    </button>
                    {renaming === session.id ? (
                      <form
                        className="flex min-w-0 flex-1 items-center gap-1 px-1"
                        onSubmit={e => { e.preventDefault(); endRename(true) }}
                      >
                        <input
                          ref={el => { if (el && document.activeElement !== el && !el.dataset.focused) { el.dataset.focused = '1'; el.focus(); el.select() } }}
                          type="text"
                          value={draft}
                          maxLength={ALIAS_MAX_LENGTH}
                          aria-label={t('sessions.rename.field', { label: session.originalLabel ?? session.label })}
                          aria-describedby="session-rename-help"
                          onChange={e => setDraft(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endRename(false) } }}
                          onBlur={() => endRename(false, false)}
                          className={`min-h-6 min-w-0 flex-1 rounded border bg-transparent px-1 text-xs ${FOCUS_RING}`}
                          style={{ color: COLORS.textPrimary, borderColor: COLORS.controlBorder }}
                        />
                        <span id="session-rename-help" className="sr-only">{t('sessions.rename.help')}</span>
                      </form>
                    ) : (
                    <button
                      type="button" data-row-main data-row-key={`session:${row.id}`} data-session-id={hasAgents ? session.id : undefined}
                      data-closable-id={session.id}
                      aria-keyshortcuts={onRenameSession ? 'F2 Delete' : 'Delete'}
                      tabIndex={stopId === row.id ? 0 : -1}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => onSelectSession(session.id)}
                      className={`${rowLook} ${ROW_GRID} min-w-0 flex-1`} style={rowStyle}
                    >
                      <span className={`flex min-w-0 items-center gap-x-1.5 ${COLUMN_CLASSES.name}`}>
                        {unobserved
                          ? <span aria-hidden="true" className="inline-block w-3 shrink-0" />
                          : <SessionMarker kind={kind} />}
                        <span className="sr-only">
                          {statusText}{unobserved ? <>. {statusHelp}</> : null}
                          ,{' '}
                        </span>
                        {badge && <span className="sr-only">{t('sessions.runtimeSession', { runtime: badge.label })}{' '}</span>}
                        <span className="truncate min-w-[6ch] flex-1 text-xs font-semibold" style={{ color: selected ? COLORS.holoBright : COLORS.textPrimary }} title={session.originalLabel ? t('sessions.renamedTitle', { name: tabName, original: session.originalLabel }) : tabName}>{tabName}</span>
                        {session.originalLabel && <span className="sr-only">{t('sessions.renamedSr', { original: session.originalLabel })}</span>}
                      </span>
                      <ColumnValue column="model" cell={modelCell(modelId)} title={modelId} />
                      <ColumnValue column="runtime" cell={runtimeCell(session.runtime)} />
                      <ColumnValue column="branch" cell={branchCell(session.branch)} title={session.branch} />
                      <ColumnValue column="tokens" cell={rollupTokensCell(hasAgents ? rollups.get(row.id) : null)} />
                      <ColumnValue column="cost" cell={costCell(hasAgents ? rollups.get(row.id) : null)} />
                      <ColumnValue column="time" cell={sessionTimeCell(session, currentTime, relayOffline)} />
                      <ColumnValue column="activity" cell={activityCell(session, currentTime)} />
                      <span className={COLUMN_CLASSES.secondLine} style={{ paddingLeft: 20 }}>
                        {unobserved && (
                          <span aria-hidden="true" className="shrink-0" style={{ color: COLORS.textMuted }} title={statusHelp}>
                            {statusText}
                          </span>
                        )}
                        {attentionOf(session.id) && (
                          <span className="shrink-0 font-semibold" data-testid="session-attention" style={{ color: attention.bySession.get(session.id)!.waiting > 0 ? COLORS.waiting_permission : COLORS.error }}>
                            <span aria-hidden="true">! </span>{attentionOf(session.id)}
                          </span>
                        )}
                        {loopOf(session.id) && (
                          <span className="shrink-0 font-semibold" data-testid="session-health" style={{ color: COLORS.warn }}>
                            <span aria-hidden="true">⟳ </span>{loopOf(session.id)}
                          </span>
                        )}
                        {/* Cost and activity have their own columns from this width on */}
                        {hasAgents && rollups.get(row.id) && <span className={COLUMN_CLASSES.coveredByColumns}><RollupLabel total={rollups.get(row.id)!} label="session total" /></span>}
                        <span className={`shrink-0 tabular-nums ${COLUMN_CLASSES.coveredByColumns}`} style={{ color: COLORS.textDim }}>{session.lastActivityUnknown ? t('sessions.activityUnknown') : C.relativeTimeText(locale, session.lastActivityTime, currentTime)}</span>
                      </span>
                    </button>
                    )}
                    {onRenameSession && renaming !== session.id && (
                      <button
                        type="button"
                        aria-label={t('sessions.rename', { label: session.label })}
                        title={t('sessions.rename.title')}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => startRename(session.id)}
                        className={`min-h-6 min-w-6 rounded text-[11px] leading-none opacity-70 group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100 transition-opacity ${FOCUS_RING}`}
                        style={{ color: COLORS.textMuted }}
                      >
                        <span aria-hidden="true">✎</span>
                      </button>
                    )}
                    {onExportSession && renaming !== session.id && canExportSession?.(session.id) && (
                      <button
                        type="button"
                        aria-label={t('sessions.export', { label: session.label })}
                        title={t('sessions.export.title')}
                        onClick={() => onExportSession(session.id)}
                        className={`min-h-6 min-w-6 rounded text-[11px] leading-none opacity-70 group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100 transition-opacity ${FOCUS_RING}`}
                        style={{ color: COLORS.textMuted }}
                      >
                        <span aria-hidden="true">⤓</span>
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={t('sessions.hide', { label: session.label })}
                      title={t('sessions.hide', { label: session.label })}
                      onClick={() => onCloseSession(session.id)}
                      className={`min-h-6 min-w-6 rounded text-[11px] leading-none opacity-70 group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100 transition-opacity ${FOCUS_RING}`}
                      style={{ color: COLORS.tabClose }}
                    >
                      <span aria-hidden="true">✕</span>
                    </button>
                  </div>
                  {hasAgents && (
                    <CollapsibleSection open={!isCollapsed}>
                    <ul className="list-none m-0 ml-3 pl-2 pr-6 py-0.5" style={{ borderLeft: `2px solid ${COLORS.controlBorder}` }} aria-label={t('sessions.agentsOf', { label: session.label })}>
                      <AgentNodes nodes={row.roots} depth={0} selectedAgentId={selectedAgentId} onSelectAgent={stableSelectAgent} freshnessNow={freshnessNow} />
                    </ul>
                    </CollapsibleSection>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </SlidingPanel>
    </>
  )
}
