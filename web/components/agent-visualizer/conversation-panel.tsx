'use client'

// The Conversation panel (issue #32): ONE component, two presentations of the same state.
//   - collapsed pill (top-left, under the top bar): the latest message, role as text
//   - open panel (right dock): agent tabs, pair filter, search, virtual message list
// It replaces the former message feed, session transcript and per-agent chat. The per-agent chat is a preset
// of this panel: selecting an agent opens it with that agent's tab selected.

import { useState, useEffect, useRef, useMemo, useCallback, useId } from 'react'
import { Agent, Z, CARD, type TeamSummary } from '@/lib/agent-types'
import { COLORS, ROLE_COLORS, getStateColor } from '@/lib/colors'
import type { ConversationMessage, AgentLink } from '@/hooks/simulation/types'
import { useVirtualList } from '@/hooks/use-virtual-list'
import { usePanelRegistration } from '@/hooks/use-panel-registry'
import {
  stateLabel, truncateWithMarker, formatElapsed, trackUnread, emptyUnreadState, type UnreadState, nextTabIndex,
  markUnread, activeTabIndexOf, EMPTY_MESSAGES, EMPTY_SEARCH, FOCUS_RING,
  FEED_MESSAGE_TYPES, TOOL_MESSAGE_TYPES, COMM_LABELS, commKindOf, directionText, agentNameOf, teamColorOf,
  hasMultipleSessions, isAgentDone, buildFeedMessages, filterByTab, filterByPair, filterBySearch, latestFeedMessage,
  droppedMarkerFor, agentIdsWithMessages, FEED_TOP, DOCK_TOP, tabBorderStyle, pickerAgentIds, pairFromShiftClick,
  pairOfMessage, tabForSelection, groupByTeam, COLLAPSED_TEXT_MAX, type FeedMessage,
} from '@/lib/feed-utils'
import { usePairFilter, setPair, pickPair, clearPair } from '@/lib/pair-filter-store'
import { isPairComplete, isPairSet, pairEmptyText } from '@/lib/pair-filter'
import { CONVERSATION_LABELS, HIERARCHY_TERMS } from '@/lib/ui-glossary'
import { ChevronIcon, ArrowDownIcon, SearchIcon } from './feed-icons'
import { PairFilterChip } from './pair-filter-chip'
import { COMM_STYLE, HighlightText, TranscriptMessage } from './transcript-message'
import { CloseButton, SlidingPanel } from './shared-ui'
import { PANEL_BUTTON_IDS } from './top-bar'

export interface ConversationPanelProps {
  /** Whether the open panel (true) or the collapsed pill (false) is shown */
  open: boolean
  onOpen: () => void
  onClose: () => void
  conversations: Map<string, ConversationMessage[]>
  agents: Map<string, Agent>
  /** Selecting an agent (canvas, row click) presets the panel to that agent's tab */
  selectedAgentId: string | null
  onAgentClick: (agentId: string | null) => void
  /** Communication links between agents (dispatch / return / teammate messages) */
  links?: Map<string, AgentLink>
  /** Messages dropped per agent key (shows '... N older messages dropped') */
  droppedMessages?: Map<string, number>
  /** Agent Teams, used for team accents */
  teams?: Map<string, TeamSummary>
}

// Truncation limits for compact display
const COLLAPSED_AGENT_NAME_MAX = 12
const TAB_AGENT_NAME_MAX = 14
const PREVIEW_MAX = 50

const MESSAGE_GAP = 4
const PILL_MAX_WIDTH = 320

// ─── Main component ─────────────────────────────────────────────────────────

export function ConversationPanel({
  open, onOpen, onClose,
  conversations, agents, selectedAgentId, onAgentClick, links, droppedMessages, teams,
}: ConversationPanelProps) {
  const [activeTab, setActiveTab] = useState<string>(() => tabForSelection(selectedAgentId))
  const [unread, setUnread] = useState<Set<string>>(new Set())
  const [showTools, setShowTools] = useState(true)
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // The pair is shared with the timeline; only the picker visibility is local.
  const pair = usePairFilter()
  const [pickerOpen, setPickerOpen] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const unreadStateRef = useRef<UnreadState>(emptyUnreadState())
  const pillRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const searchToggleRef = useRef<HTMLButtonElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false })
  const baseId = useId()
  const regionId = `${baseId}-region`
  const listId = `${baseId}-list`
  const tabPanelId = `${baseId}-panel`
  const searchId = `${baseId}-search`
  const titleId = `${baseId}-title`
  const tabId = (i: number) => `${baseId}-tab-${i}`
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  // ── Latest message (cheap: used by the pill) ──
  const latestMessage = useMemo(() => latestFeedMessage(conversations, links), [conversations, links])

  // ── Expensive memos: only compute while the panel is open ──
  const allMessages = useMemo<FeedMessage[]>(
    () => (open ? buildFeedMessages(conversations, links, showTools ? TOOL_MESSAGE_TYPES : undefined) : []),
    [open, conversations, links, showTools],
  )

  const agentsWithMessages = useMemo(
    () => agentIdsWithMessages(allMessages, agents),
    [allMessages, agents],
  )

  const pairActive = isPairComplete(pair)
  const tabMessages = useMemo(
    () => (pairActive ? filterByPair(allMessages, pair.a, pair.b) : filterByTab(allMessages, activeTab)),
    [allMessages, activeTab, pairActive, pair.a, pair.b],
  )
  const messages = useMemo(() => filterBySearch(tabMessages, searchQuery), [tabMessages, searchQuery])
  const droppedMarker = droppedMarkerFor(droppedMessages, pairActive ? 'none' : activeTab)
  const multiSession = hasMultipleSessions(agents)

  // Virtual list with auto-scroll
  const {
    visibleItems, handleScroll, measureRef,
    isAtBottom, scrollToBottom, startIndex, listStyle, windowStyle, newCount,
  } = useVirtualList(messages, logRef, { gap: MESSAGE_GAP, autoScroll: true })

  // Track unread messages per agent tab: only agents whose message count increased
  useEffect(() => {
    const { increased, next } = trackUnread(unreadStateRef.current, conversations, links, FEED_MESSAGE_TYPES)
    unreadStateRef.current = next
    if (!open || activeTab === 'all') return
    if (increased.length === 0) return
    setUnread(prev => markUnread(prev, increased, activeTab))
  }, [conversations, links, open, activeTab])

  useEffect(() => {
    if (activeTab !== 'all') {
      setUnread(prev => { const next = new Set(prev); next.delete(activeTab); return next })
    } else {
      setUnread(new Set())
    }
  }, [activeTab])

  useEffect(() => {
    if (open && activeTab !== 'all' && agentsWithMessages.length > 0 && !agentsWithMessages.includes(activeTab)) {
      // the tab disappears: the pair filter would otherwise keep a list that no tab describes
      clearPair()
      setActiveTab('all')
    }
  }, [open, agentsWithMessages, activeTab])

  // Per-agent preset: a selection made anywhere (canvas, sessions list, a row of this panel) selects that
  // agent's tab. The pair filter would keep showing a list that the highlighted tab does not describe, so it
  // is cleared (not on mount, where a pair chosen in another panel must survive).
  const lastSelectedRef = useRef<string | null>(selectedAgentId)
  useEffect(() => {
    if (lastSelectedRef.current !== selectedAgentId) clearPair()
    lastSelectedRef.current = selectedAgentId
    setActiveTab(tabForSelection(selectedAgentId))
  }, [selectedAgentId])

  // Escape stack: close the open panel (the registry asks the newest panel first)
  usePanelRegistration('conversation', () => {
    if (!open) return false
    onClose()
    return true
  })
  // No outside-click close: the panel is non-modal; clicks on the canvas or other panels must not close it.
  // The close button, the top bar button, C and Escape (registry above) close it.

  // Closing (any way) must not strand focus on <body>: it returns to the pill, or to the top bar button when
  // there is no pill. Focus that is already somewhere else (e.g. on the top bar button just clicked) is kept.
  const wasOpenRef = useRef(open)
  useEffect(() => {
    const wasOpen = wasOpenRef.current
    wasOpenRef.current = open
    if (open || !wasOpen) return
    const active = document.activeElement
    if (active && active !== document.body) return
    const target = pillRef.current ?? document.getElementById(PANEL_BUTTON_IDS.conversation)
    target?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (showSearch) searchRef.current?.focus()
  }, [showSearch])

  const updateTabOverflow = useCallback(() => {
    const el = tabsRef.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setTabOverflow(prev => (prev.left === left && prev.right === right ? prev : { left, right }))
  }, [])

  useEffect(() => {
    updateTabOverflow()
    const el = tabsRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(updateTabOverflow)
    ro.observe(el)
    return () => ro.disconnect()
  }, [updateTabOverflow, agentsWithMessages, open])

  const showTabs = agentsWithMessages.length > 1
  const tabKeys = ['all', ...agentsWithMessages]
  const activeTabIndex = activeTabIndexOf(tabKeys, activeTab)

  const selectPair = (a: string, b: string) => setPair(a, b)
  const nameOfAgent = useCallback((key: string) => agentNameOf(agents, key), [agents])
  const onTabClick = (key: string, shift: boolean) => {
    if (shift && key !== 'all') {
      // Click an agent, then Shift-click another: filter on their exchanges. With no pair started yet the
      // current tab is the first agent.
      if (pair.a === '' && pairFromShiftClick(activeTab, key)) selectPair(activeTab, key)
      else pickPair(key)
      return
    }
    clearPair()
    setActiveTab(key)
  }

  const onTabKeyDown = (e: React.KeyboardEvent) => {
    const next = nextTabIndex(e.key, activeTabIndex, tabKeys.length)
    if (next === null) return
    e.preventDefault()
    clearPair()
    setActiveTab(tabKeys[next])
    tabRefs.current[next]?.focus()
  }

  const teamGroups = useMemo(
    () => (open && teams && teams.size > 0
      ? groupByTeam([...agents.values()].filter(a => a.teamName)).filter(g => g.team !== null)
      : []),
    [open, teams, agents],
  )

  // ── Collapsed pill ──
  if (!open) {
    if (!latestMessage) return null
    const agentName = agentNameOf(agents, latestMessage.agentId)
    const latestKind = commKindOf(latestMessage)
    const base = ROLE_COLORS[latestMessage.type] ?? ROLE_COLORS.assistant
    const role = latestKind
      ? { ...COMM_STYLE[latestKind], label: COMM_LABELS[latestKind] }
      : { ...base, label: roleLabelOf(latestMessage.type, agents.get(latestMessage.agentId)?.runtime) }
    const preview = latestMessage.content.replace(/\n/g, ' ').slice(0, PREVIEW_MAX)

    return (
      <div
        className="absolute"
        style={{ top: FEED_TOP, left: 12, zIndex: Z.info, pointerEvents: 'auto', maxWidth: 'calc(100vw - 24px)' }}
      >
        <button
          ref={pillRef}
          type="button"
          aria-expanded={false}
          aria-controls={regionId}
          aria-label={`${CONVERSATION_LABELS.open}. Latest ${role.label.toLowerCase()} message from ${agentName}: ${preview}`}
          title={agentName}
          onClick={onOpen}
          className={`glass-card text-left px-3 py-2 min-h-6 flex items-center gap-2 w-full motion-safe:transition-all motion-safe:hover:scale-[1.02] ${FOCUS_RING}`}
          style={{ maxWidth: PILL_MAX_WIDTH }}
        >
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: role.text }} />
          {/* Role as text too: colour alone must not carry it (WCAG 1.4.1) */}
          <span className="text-[11px] font-mono font-semibold shrink-0" style={{ color: role.text }}>{role.label}</span>
          <span className="text-[11px] font-mono font-semibold shrink-0" style={{ color: COLORS.textPrimary }}>
            {agentName.length > COLLAPSED_AGENT_NAME_MAX ? agentName.slice(0, COLLAPSED_AGENT_NAME_MAX) + '..' : agentName}
          </span>
          <span className="text-[11px] font-mono truncate" style={{ color: role.text }}>
            {preview}{latestMessage.content.length > PREVIEW_MAX ? '...' : ''}
          </span>
          <span aria-hidden="true" className="shrink-0" style={{ color: COLORS.textMuted }}><ChevronIcon direction="down" /></span>
        </button>
      </div>
    )
  }

  // ── Open panel (right dock, virtualized list) ──
  const presetAgent = activeTab !== 'all' && !pairActive ? agents.get(activeTab) : undefined
  const presetColor = presetAgent ? getStateColor(presetAgent.state) : undefined
  const searching = searchQuery.trim() !== ''
  const totalCount = tabMessages.length

  const droppedNote = droppedMarker ? (
    <p className="text-[11px] font-mono px-3 pb-1" style={{ color: COLORS.textMuted }}>{droppedMarker}</p>
  ) : null
  const messageList = (
    <>
    {droppedNote}
    <div
      ref={logRef}
      id={listId}
      onScroll={handleScroll}
      role="log"
      aria-live="off"
      aria-label={pairActive ? `Messages between ${agentNameOf(agents, pair.a)} and ${agentNameOf(agents, pair.b)}` : activeTab === 'all' ? 'Messages from all agents' : `Messages from ${agentNameOf(agents, activeTab)}`}
      tabIndex={0}
      className={`flex-1 min-h-0 overflow-y-auto px-2 pb-2 ${FOCUS_RING}`}
      style={{ scrollbarWidth: 'thin', scrollbarColor: `${COLORS.scrollbarThumb} transparent` }}
    >
      {messages.length === 0 ? (
        <div className="flex items-center justify-center py-6">
          <span className="text-[11px] font-mono" style={{ color: COLORS.textMuted }}>
            {searching ? EMPTY_SEARCH : pairActive ? pairEmptyText(pair, nameOfAgent) : EMPTY_MESSAGES}
          </span>
        </div>
      ) : (
        <div style={listStyle}>
          <div role="list" aria-label="Messages" style={windowStyle}>
            {visibleItems.map((msg, i) => (
              <div
                key={msg.id}
                role="listitem"
                aria-setsize={messages.length}
                aria-posinset={startIndex + i + 1}
                ref={(el) => measureRef(msg.id, el)}
                style={{ marginBottom: MESSAGE_GAP }}
              >
                {TOOL_MESSAGE_TYPES.has(msg.type) ? (
                  <TranscriptMessage message={msg} searchQuery={searchQuery} />
                ) : (
                  <MessageRow
                    message={msg}
                    agentName={agentNameOf(agents, msg.agentId)}
                    fromName={msg.from ? agentNameOf(agents, msg.from) : undefined}
                    toName={msg.to ? agentNameOf(agents, msg.to) : undefined}
                    accent={teamColorOf(agents.get(msg.from ?? msg.agentId), teams)}
                    sessionChip={multiSession ? sessionChipOf(agents.get(msg.agentId)) : undefined}
                    showAgent={activeTab === 'all' || pairActive}
                    isSelected={selectedAgentId === msg.agentId}
                    searchQuery={searchQuery}
                    onClick={(e) => {
                      const rowPair = e.shiftKey ? pairOfMessage(msg) : null
                      if (rowPair) { selectPair(rowPair[0], rowPair[1]); return }
                      onAgentClick(msg.agentId)
                    }}
                    runtime={agents.get(msg.agentId)?.runtime}
                    onFilterPair={(() => { const rp = pairOfMessage(msg); return rp ? () => selectPair(rp[0], rp[1]) : undefined })()}
                    contentId={`${baseId}-msg-${msg.id}`}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
    </>
  )

  const newMessagesText = `${newCount} new message${newCount === 1 ? '' : 's'}`

  return (
    <SlidingPanel
      visible
      position={{ right: 0, bottom: 0, top: DOCK_TOP }}
      zIndex={Z.transcriptPanel}
      width={CARD.transcript.width}
      labelledBy={titleId}
    >
      <div
        id={regionId}
        className="h-full flex flex-col"
        style={{ background: COLORS.panelBg, backdropFilter: 'blur(24px)', borderLeft: `1px solid ${COLORS.holoBorder10}` }}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 flex-shrink-0" style={{ borderBottom: `1px solid ${COLORS.holoBorder08}` }}>
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <h2 id={titleId} className="m-0 text-[11px] font-mono tracking-widest font-semibold" style={{ color: COLORS.panelLabel }}>
              {CONVERSATION_LABELS.title}
            </h2>
            <span className="text-[11px] font-mono" style={{ color: COLORS.panelLabelDim }}>
              {searching ? `${messages.length}/${totalCount}` : totalCount} messages
            </span>
            {presetAgent && presetColor && (
              <span className="text-[11px] font-mono inline-flex items-center gap-1 min-w-0" style={{ color: presetColor }}>
                <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: presetColor, boxShadow: `0 0 6px ${presetColor}` }} />
                <span className="truncate" title={presetAgent.name}>{presetAgent.name}</span>
                <span>{stateLabel(presetAgent.state)}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              aria-pressed={showTools}
              title="Show or hide tool calls and results"
              onClick={() => setShowTools(v => !v)}
              className={`text-[11px] font-mono px-1.5 min-h-6 min-w-6 rounded motion-safe:transition-all ${FOCUS_RING}`}
              style={{
                background: showTools ? COLORS.toggleActive : 'transparent',
                color: showTools ? COLORS.assistantText : COLORS.textMuted,
                border: `1px solid ${COLORS.controlBorder}`,
              }}
            >
              Tool calls
            </button>
            <button
              ref={searchToggleRef}
              type="button"
              onClick={() => { setShowSearch(s => !s); if (showSearch) setSearchQuery('') }}
              aria-label={CONVERSATION_LABELS.search}
              aria-expanded={showSearch}
              aria-controls={searchId}
              title={CONVERSATION_LABELS.search}
              className={`text-[11px] font-mono px-1.5 min-h-6 min-w-6 rounded motion-safe:transition-all ${FOCUS_RING}`}
              style={{
                background: showSearch ? COLORS.toggleActive : 'transparent',
                color: showSearch ? COLORS.assistantText : COLORS.textMuted,
              }}
            >
              <SearchIcon size={12} />
            </button>
            <CloseButton onClick={onClose} className="px-1" />
          </div>
        </div>

        {/* Search bar */}
        {showSearch && (
          <div id={searchId} className="px-3 py-1.5 flex-shrink-0" style={{ borderBottom: `1px solid ${COLORS.holoBorder06}` }}>
            <input
              ref={searchRef}
              type="search"
              aria-label={CONVERSATION_LABELS.search}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(''); searchToggleRef.current?.focus() }
                e.stopPropagation()
              }}
              placeholder="Search messages..."
              className="w-full px-2 py-1 min-h-6 rounded text-xs font-mono focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#aaeeff] placeholder:text-[color:var(--ph)]"
              style={{
                background: COLORS.holoBg05,
                border: `1px solid ${COLORS.controlBorder}`,
                color: COLORS.assistantText,
                ['--ph' as string]: COLORS.textMuted,
              }}
            />
          </div>
        )}

        {/* Agent tabs (hidden when only one agent speaks) */}
        {showTabs && (
          <div className="relative flex-shrink-0 pt-1.5">
            <div
              ref={tabsRef}
              role="tablist"
              aria-label={CONVERSATION_LABELS.tablist}
              aria-orientation="horizontal"
              onKeyDown={onTabKeyDown}
              onScroll={updateTabOverflow}
              className="flex gap-0.5 px-2 pb-1.5 overflow-x-auto"
              style={{ scrollbarWidth: 'thin', scrollbarColor: `${COLORS.scrollbarThumb} transparent` }}
            >
              {tabKeys.map((key, i) => {
                const agent = key === 'all' ? undefined : agents.get(key)
                const name = key === 'all' ? 'All' : agentNameOf(agents, key)
                const color = key === 'all' ? COLORS.holoBase : (agent ? getStateColor(agent.state) : COLORS.idle)
                const done = key !== 'all' && isAgentDone(agent)
                return (
                  <TabButton
                    key={key}
                    id={tabId(i)}
                    panelId={tabPanelId}
                    buttonRef={(el) => { tabRefs.current[i] = el }}
                    label={name.length > TAB_AGENT_NAME_MAX ? name.slice(0, TAB_AGENT_NAME_MAX) + '..' : name}
                    fullName={name}
                    stateText={key === 'all' ? undefined : (done ? 'done' : stateLabel(agent!.state))}
                    done={done}
                    accent={teamColorOf(agent, teams)}
                    active={i === activeTabIndex}
                    onClick={(e) => onTabClick(key, e.shiftKey)}
                    color={color}
                    hasUnread={key !== 'all' && unread.has(key)}
                  />
                )
              })}
            </div>
            {tabOverflow.left && (
              <span aria-hidden="true" className="pointer-events-none absolute left-0 top-1.5 bottom-1.5 w-4 flex items-center"
                style={{ color: COLORS.textMuted, background: `linear-gradient(90deg, ${COLORS.panelBg}, transparent)` }}><ChevronIcon direction="left" size={10} /></span>
            )}
            {tabOverflow.right && (
              <span aria-hidden="true" className="pointer-events-none absolute right-0 top-1.5 bottom-1.5 w-4 flex items-center justify-end"
                style={{ color: COLORS.textMuted, background: `linear-gradient(270deg, ${COLORS.panelBg}, transparent)` }}><ChevronIcon direction="right" size={10} /></span>
            )}
          </div>
        )}

        {/* Pair filter: the communications exchanged between two agents */}
        {(agentsWithMessages.length > 1 || isPairSet(pair)) && (
          <div className="px-2 pb-1.5 flex flex-wrap items-center gap-1 flex-shrink-0">
            <button
              type="button"
              aria-expanded={pickerOpen}
              title="Filter on the messages exchanged between two agents (or Shift-click a second agent tab or message row)"
              onClick={() => setPickerOpen(v => !v)}
              className={`min-h-6 px-2 rounded text-[11px] font-mono ${FOCUS_RING}`}
              style={{ color: pickerOpen ? COLORS.textPrimary : COLORS.textMuted, border: `1px solid ${COLORS.controlBorder}` }}
            >
              Filter pair
            </button>
            <PairFilterChip pair={pair} nameOf={nameOfAgent} count={messages.length} onClear={clearPair} />
            {pickerOpen && (
              <span className="inline-flex flex-wrap items-center gap-1">
                {([['First agent', pair.a, (v: string) => setPair(v, pair.b)], ['Second agent', pair.b, (v: string) => setPair(pair.a, v)]] as const).map(([label, value, set]) => (
                  <select
                    key={label}
                    aria-label={label}
                    value={value}
                    onChange={e => set(e.target.value)}
                    className={`min-h-6 max-w-[120px] rounded text-[11px] font-mono ${FOCUS_RING}`}
                    style={{ background: COLORS.holoBg05, color: COLORS.textPrimary, border: `1px solid ${COLORS.controlBorder}` }}
                  >
                    <option value="">{label}</option>
                    {pickerAgentIds(agentsWithMessages, pair).map(id => <option key={id} value={id}>{agentNameOf(agents, id)}</option>)}
                  </select>
                ))}
              </span>
            )}
          </div>
        )}

        {/* Teammates grouped under their team heading */}
        {teamGroups.length > 0 && (
          <section aria-label="Teams" className="px-3 py-1.5 flex-shrink-0" style={{ borderBottom: `1px solid ${COLORS.holoBorder06}` }}>
            {teamGroups.map(g => (
              <div key={g.team}>
                <h3 className="text-[11px] font-mono font-semibold tracking-wider" style={{ color: COLORS.panelLabel }}>
                  {g.team}
                </h3>
                <ul className="flex flex-wrap gap-x-2 gap-y-0.5 pb-1">
                  {g.items.map(a => (
                    <li key={a.id} className="text-[11px] font-mono flex items-center gap-1" style={{ color: COLORS.textMuted }}>
                      <span aria-hidden="true" className="inline-block w-2 h-2 rounded-full" style={{ background: teamColorOf(a, teams) ?? COLORS.textMuted }} />
                      {a.name}
                      <span className="sr-only">, {roleTermOf(a)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}

        {/* Message list (virtualized) */}
        {showTabs ? (
          <div
            role="tabpanel"
            id={tabPanelId}
            aria-labelledby={tabId(activeTabIndex)}
            className="flex flex-col flex-1 min-h-0"
          >
            {messageList}
          </div>
        ) : (
          <div className="flex flex-col flex-1 min-h-0">{messageList}</div>
        )}

        {/* Intentional: the log is not live (it would read every message). While pinned to the bottom the
            list is already in view; when scrolled up this polite status line announces only the unseen count. */}
        <div role="status" className="sr-only">{!isAtBottom && newCount > 0 ? newMessagesText : ''}</div>

        {!isAtBottom && messages.length > 0 && (
          <div className="flex justify-center py-1 flex-shrink-0" style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
            <button
              type="button"
              aria-controls={listId}
              onClick={scrollToBottom}
              className={`text-[11px] font-mono px-3 min-h-6 rounded-full motion-safe:transition-all ${FOCUS_RING}`}
              style={{ background: COLORS.holoBg10, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.scrollBtnText }}
            >
              <ArrowDownIcon size={11} className="mr-1 align-[-1px]" />
              {newCount > 0 ? newMessagesText : 'Jump to latest'}
            </button>
          </div>
        )}
      </div>
    </SlidingPanel>
  )
}

/** Role label of a conversation message: the assistant is named after the runtime of the agent that spoke. */
function roleLabelOf(type: string, runtime?: Agent['runtime']): string {
  if (type === 'assistant' && runtime === 'codex') return 'CODEX'
  return (ROLE_COLORS[type] ?? ROLE_COLORS.assistant).label
}

/** Hierarchy term of an agent (Main / Lead, Subagent, Teammate), from the fixed glossary. */
function roleTermOf(agent: { kind?: string; isMain?: boolean }): string {
  if (agent.kind === 'teammate') return HIERARCHY_TERMS.teammate
  if (agent.kind === 'subagent') return HIERARCHY_TERMS.subagent
  return agent.isMain ? HIERARCHY_TERMS.main : HIERARCHY_TERMS.agent
}

// ── Tab Button ──

function TabButton({ id, panelId, buttonRef, label, fullName, stateText, active, onClick, color, hasUnread, done, accent }: {
  id: string
  panelId: string
  buttonRef: (el: HTMLButtonElement | null) => void
  label: string
  fullName: string
  stateText?: string
  active: boolean
  onClick: (e: React.MouseEvent) => void
  color: string
  hasUnread?: boolean
  /** Finished agent: the tab stays, flagged 'done' */
  done?: boolean
  /** Validated team color */
  accent?: string
}) {
  const accessibleName = [fullName, stateText ? `(${stateText})` : '', hasUnread ? ', unread messages' : '']
    .filter(Boolean).join(' ')
  return (
    <button
      ref={buttonRef}
      id={id}
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={panelId}
      aria-label={accessibleName}
      tabIndex={active ? 0 : -1}
      title={fullName}
      onClick={onClick}
      className={`px-2 min-h-6 rounded text-[11px] font-mono motion-safe:transition-all shrink-0 relative ${FOCUS_RING}`}
      style={{
        background: active ? color + '20' : 'transparent',
        color: active ? color : COLORS.textMuted,
        ...tabBorderStyle({ active, color, accent, done }),
      }}
    >
      {label}
      {done && <span aria-hidden="true" className="ml-1 text-[11px]">done</span>}
      {hasUnread && (
        <>
          <span className="sr-only"> unread</span>
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full"
            style={{ background: COLORS.unreadDot }}
          />
        </>
      )}
    </button>
  )
}

// ── Message Row ──

/** Short session label for the chip shown when several sessions are present. */
function sessionChipOf(agent: Agent | undefined): string | undefined {
  if (!agent) return undefined
  return (agent.sessionLabel ?? agent.sessionId).slice(0, 24)
}

function MessageRow({ message, agentName, fromName, toName, accent, sessionChip, showAgent, isSelected, searchQuery, onClick, runtime, contentId, onFilterPair }: {
  message: ConversationMessage
  agentName: string
  fromName?: string
  toName?: string
  accent?: string
  sessionChip?: string
  showAgent: boolean
  isSelected: boolean
  searchQuery?: string
  onClick: (e: React.MouseEvent) => void
  runtime?: Agent['runtime']
  contentId: string
  /** Communication rows: filter the panel on the two agents of this row (keyboard path for Shift-click) */
  onFilterPair?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const commKind = commKindOf(message)
  const role = commKind ? COMM_STYLE[commKind] : (ROLE_COLORS[message.type] ?? ROLE_COLORS.assistant)
  const roleLabel = commKind ? COMM_LABELS[commKind] : roleLabelOf(message.type, runtime)
  // One truncation rule for every row: COLLAPSED_TEXT_MAX characters with a "Show all" toggle
  const truncated = truncateWithMarker(message.content, COLLAPSED_TEXT_MAX)
  const isLong = truncated.hidden > 0
  const displayText = expanded || !isLong ? message.content : truncated.text + truncated.marker
  const time = formatElapsed(message.timestamp)
  const from = fromName ?? agentName
  const to = toName ?? ''
  const direction = commKind && to ? directionText(from, to) : null
  const borderColor = accent ?? (isSelected ? role.text : 'transparent')

  return (
    <div
      className="rounded px-2 py-1.5 motion-safe:transition-all"
      style={{
        background: isSelected ? role.bgSelected : role.bg,
        borderLeft: `${accent || isSelected ? 3 : 2}px solid ${borderColor}`,
      }}
    >
      <button
        type="button"
        aria-pressed={isSelected}
        onClick={onClick}
        title={direction ? `${direction} - ${roleLabel}` : (showAgent ? `${agentName}: show this agent` : 'Show this agent')}
        className={`block w-full min-h-6 text-left rounded ${FOCUS_RING}`}
      >
        {/* Header row */}
        <span className="flex items-center gap-1.5 mb-0.5 flex-wrap">
          {direction ? (
            <>
              <span className="text-[11px] font-mono font-semibold break-all" style={{ color: role.text }}>
                {from}<span aria-hidden="true"> {'→'} </span><span className="sr-only"> to </span>{to}
              </span>
              <span className="text-[11px] font-mono font-semibold" style={{ color: role.text }}>
                <span aria-hidden="true">- </span><span className="sr-only">, </span>{roleLabel}
              </span>
            </>
          ) : (
            <span className="text-[11px] font-mono font-semibold" style={{ color: role.text }}>
              {roleLabel}
            </span>
          )}
          {showAgent && !direction && (
            <span className="text-[11px] font-mono truncate" title={agentName} style={{ color: COLORS.textMuted }}>
              {agentName}
            </span>
          )}
          {sessionChip && (
            <span className="text-[11px] font-mono truncate max-w-[96px] px-1 rounded" title={`Session ${sessionChip}`}
              style={{ color: COLORS.textMuted, border: `1px solid ${COLORS.controlBorder}` }}>
              {sessionChip}
            </span>
          )}
          <time dateTime={time.iso} className="text-[11px] font-mono ml-auto shrink-0" style={{ color: COLORS.textMuted }}>
            {time.label}
          </time>
        </span>

        {/* Content */}
        <span
          id={contentId}
          className="block text-xs font-mono leading-relaxed whitespace-pre-wrap break-words"
          style={{ color: role.text }}
        >
          <HighlightText text={displayText} query={searchQuery} />
        </span>
      </button>

      {onFilterPair && (
        <button
          type="button"
          aria-label={`Filter pair ${direction ?? ''}`.trim()}
          onClick={onFilterPair}
          className={`text-[11px] font-mono mt-0.5 mr-1 min-h-6 px-1 rounded motion-safe:transition-colors ${FOCUS_RING}`}
          style={{ color: COLORS.textMuted }}
        >
          Filter pair
        </button>
      )}

      {/* Expand/collapse for long messages */}
      {isLong && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          className={`text-[11px] font-mono mt-0.5 min-h-6 px-1 rounded motion-safe:transition-colors ${FOCUS_RING}`}
          style={{ color: COLORS.textMuted }}
          onClick={() => setExpanded(prev => !prev)}
        >
          <ChevronIcon direction={expanded ? 'up' : 'down'} size={10} className="mr-1" />
          {expanded ? 'Show less' : `Show all (+${truncated.hidden} chars)`}
        </button>
      )}
    </div>
  )
}
