'use client'

import { useState, useEffect, useRef, useMemo, useCallback, useId } from 'react'
import { Agent, Z, type TeamSummary } from '@/lib/agent-types'
import { COLORS, ROLE_COLORS, getStateColor } from '@/lib/colors'
import type { ConversationMessage, AgentLink } from '@/hooks/simulation/types'
import { useVirtualList } from '@/hooks/use-virtual-list'
import { usePanelRegistration } from '@/hooks/use-panel-registry'
import {
  stateLabel, truncateWithMarker, formatElapsed, trackUnread, emptyUnreadState, type UnreadState, nextTabIndex,
  markUnread, activeTabIndexOf, EMPTY_MESSAGES, FOCUS_RING,
  FEED_MESSAGE_TYPES, COMM_LABELS, commKindOf, directionText, agentNameOf, teamColorOf,
  hasMultipleSessions, isAgentDone, buildFeedMessages, filterByTab, filterByPair,
  droppedMarkerFor, agentIdsWithMessages, FEED_TOP, tabBorderStyle, pickerAgentIds, pairFromShiftClick, pairOfMessage, type FeedMessage, type CommKind,
} from '@/lib/feed-utils'
import { usePairFilter, setPair, pickPair, clearPair } from '@/lib/pair-filter-store'
import { isPairComplete, isPairSet, pairEmptyText } from '@/lib/pair-filter'
import { ChevronIcon, ArrowDownIcon } from './feed-icons'
import { PairFilterChip } from './pair-filter-chip'
import { COMM_STYLE } from './transcript-message'

interface MessageFeedPanelProps {
  conversations: Map<string, ConversationMessage[]>
  agents: Map<string, Agent>
  onAgentClick: (agentId: string | null) => void
  selectedAgentId: string | null
  /** Communication links between agents (dispatch / return / teammate messages) */
  links?: Map<string, AgentLink>
  /** Messages dropped per agent key (shows '... N older messages dropped') */
  droppedMessages?: Map<string, number>
  /** Agent Teams, used for team accents */
  teams?: Map<string, TeamSummary>
}

// Text messages plus agent-to-agent communications; tool calls are visible via agent selection
const TEXT_TYPES = FEED_MESSAGE_TYPES

const COMM_TRUNCATE_MAX = 200

// Truncation limits for compact display
const COLLAPSED_AGENT_NAME_MAX = 12
const TAB_AGENT_NAME_MAX = 14
const PREVIEW_MAX = 50
const MESSAGE_TRUNCATE_MAX = 120

const MESSAGE_GAP = 4
const PANEL_WIDTH = 320

// ─── Main component ─────────────────────────────────────────────────────────

export function MessageFeedPanel({
  conversations,
  agents,
  onAgentClick,
  selectedAgentId,
  links,
  droppedMessages,
  teams,
}: MessageFeedPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [activeTab, setActiveTab] = useState<string>('all')
  const [unread, setUnread] = useState<Set<string>>(new Set())
  // The pair is shared with the transcript and the timeline; only the pickers' visibility is local.
  const pair = usePairFilter()
  const [pickerOpen, setPickerOpen] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const unreadStateRef = useRef<UnreadState>(emptyUnreadState())
  const pillRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef(false)
  const tabsRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false })
  const baseId = useId()
  const regionId = `${baseId}-region`
  const listId = `${baseId}-list`
  const tabPanelId = `${baseId}-panel`
  const tabId = (i: number) => `${baseId}-tab-${i}`
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  // ── Latest message (cheap — used by collapsed view) ──
  const latestMessage = useMemo(() => {
    let latest: FeedMessage | null = null
    // Finished agents keep their messages: no filtering on live agents
    for (const [agentId, msgs] of conversations) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (!TEXT_TYPES.has(msgs[i].type)) continue
        if (!latest || msgs[i].timestamp > latest.timestamp) {
          latest = { ...msgs[i], agentId }
        }
        break
      }
    }
    if (links) {
      for (const link of links.values()) {
        const last = link.messages[link.messages.length - 1]
        if (last && TEXT_TYPES.has(last.type) && (!latest || last.timestamp > latest.timestamp)) {
          latest = { ...last, agentId: last.from ?? link.from }
        }
      }
    }
    return latest
  }, [conversations, links])

  // ── Expensive memos — only compute when expanded ──

  const allMessages = useMemo<FeedMessage[]>(
    () => (expanded ? buildFeedMessages(conversations, links) : []),
    [expanded, conversations, links],
  )

  const agentsWithMessages = useMemo(
    () => agentIdsWithMessages(allMessages, agents),
    [allMessages, agents],
  )

  const pairActive = isPairComplete(pair)
  const messages = useMemo(
    () => (pairActive ? filterByPair(allMessages, pair.a, pair.b) : filterByTab(allMessages, activeTab)),
    [allMessages, activeTab, pairActive, pair.a, pair.b],
  )
  const droppedMarker = droppedMarkerFor(droppedMessages, pairActive ? 'none' : activeTab)
  const multiSession = hasMultipleSessions(agents)

  // Virtual list with auto-scroll
  const {
    visibleItems, handleScroll, measureRef,
    isAtBottom, scrollToBottom, startIndex, listStyle, windowStyle, newCount,
  } = useVirtualList(messages, logRef, { gap: MESSAGE_GAP, autoScroll: true })

  // Track unread messages per agent tab: only agents whose message count increased
  useEffect(() => {
    const { increased, next } = trackUnread(unreadStateRef.current, conversations, links, TEXT_TYPES)
    unreadStateRef.current = next
    if (!expanded || activeTab === 'all') return
    if (increased.length === 0) return
    setUnread(prev => markUnread(prev, increased, activeTab))
  }, [conversations, links, expanded, activeTab])

  useEffect(() => {
    if (activeTab !== 'all') {
      setUnread(prev => { const next = new Set(prev); next.delete(activeTab); return next })
    } else {
      setUnread(new Set())
    }
  }, [activeTab])

  useEffect(() => {
    if (expanded && activeTab !== 'all' && agentsWithMessages.length > 0 && !agentsWithMessages.includes(activeTab)) {
      // the tab disappears: the pair filter would otherwise keep a list that no tab describes
      clearPair()
      setActiveTab('all')
    }
  }, [expanded, agentsWithMessages, activeTab])

  const lastSelectedRef = useRef<string | null>(selectedAgentId)
  useEffect(() => {
    // A selection made elsewhere (canvas, other panel) moves the tab; the pair filter would keep showing a
    // list that the highlighted tab does not describe, so it is cleared (not on mount, where a pair chosen
    // in another panel must survive).
    if (lastSelectedRef.current !== selectedAgentId) clearPair()
    lastSelectedRef.current = selectedAgentId
    if (selectedAgentId) {
      const selected = agentsRef.current.get(selectedAgentId)
      if (selected && !selected.isMain) setActiveTab(selectedAgentId)
      else setActiveTab('all')
    } else {
      setActiveTab('all')
    }
  }, [selectedAgentId])

  // Escape stack: close the feed (returning focus to its pill) when it is open
  usePanelRegistration('message-feed', () => {
    if (!expanded) return false
    restoreFocusRef.current = true
    setExpanded(false)
    return true
  })
  // No outside-click close: the feed is a non-modal panel; clicks on the canvas or other panels must not
  // collapse it. Explicit close button, the pill, row selection and Escape (registry above) close it.

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
  }, [updateTabOverflow, agentsWithMessages, expanded])

  useEffect(() => {
    if (!expanded && restoreFocusRef.current) {
      restoreFocusRef.current = false
      pillRef.current?.focus()
    }
  }, [expanded])

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

  if (!latestMessage && agentsWithMessages.length === 0) return null

  // ── Collapsed ──
  if (!expanded) {
    if (!latestMessage) return null
    const agentName = agentNameOf(agents, latestMessage.agentId)
    const latestKind = commKindOf(latestMessage)
    const role = latestKind
      ? { ...COMM_STYLE[latestKind], label: COMM_LABELS[latestKind] }
      : (ROLE_COLORS[latestMessage.type] ?? ROLE_COLORS.assistant)
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
          aria-label={`Expand messages. Latest ${role.label.toLowerCase()} message from ${agentName}: ${preview}`}
          title={agentName}
          onClick={() => setExpanded(true)}
          className={`glass-card text-left px-3 py-2 min-h-6 flex items-center gap-2 w-full motion-safe:transition-all motion-safe:hover:scale-[1.02] ${FOCUS_RING}`}
          style={{ maxWidth: PANEL_WIDTH }}
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

  // ── Expanded (virtualized) ──
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
      className={`flex-1 overflow-y-auto px-2 pb-2 ${FOCUS_RING}`}
      style={{ maxHeight: 340, scrollbarWidth: 'thin', scrollbarColor: `${COLORS.scrollbarThumb} transparent` }}
    >
      {messages.length === 0 ? (
        <div className="flex items-center justify-center py-6">
          <span className="text-[11px] font-mono" style={{ color: COLORS.textMuted }}>
            {pairActive ? pairEmptyText(pair, nameOfAgent) : EMPTY_MESSAGES}
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
                <MessageRow
                  message={msg}
                  agentName={agentNameOf(agents, msg.agentId)}
                  fromName={msg.from ? agentNameOf(agents, msg.from) : undefined}
                  toName={msg.to ? agentNameOf(agents, msg.to) : undefined}
                  accent={teamColorOf(agents.get(msg.from ?? msg.agentId), teams)}
                  sessionChip={multiSession ? sessionChipOf(agents.get(msg.agentId)) : undefined}
                  showAgent={activeTab === 'all' || pairActive}
                  isSelected={selectedAgentId === msg.agentId}
                  onClick={(e) => {
                    const rowPair = e.shiftKey ? pairOfMessage(msg) : null
                    if (rowPair) { selectPair(rowPair[0], rowPair[1]); return }
                    onAgentClick(msg.agentId); restoreFocusRef.current = true; setExpanded(false)
                  }}
                  runtime={agents.get(msg.agentId)?.runtime}
                  onFilterPair={(() => { const rp = pairOfMessage(msg); return rp ? () => selectPair(rp[0], rp[1]) : undefined })()}
                  contentId={`${baseId}-msg-${msg.id}`}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
    </>
  )

  return (
    // Presentation wrapper: it only keeps clicks from reaching the canvas behind the panel; the region inside owns the semantics
    <div
      role="presentation"
      className="absolute"
      style={{ top: FEED_TOP, left: 12, zIndex: Z.info, pointerEvents: 'auto', maxWidth: 'calc(100vw - 24px)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div id={regionId} role="region" aria-label="Messages">
      <div className="glass-card flex flex-col" style={{ width: PANEL_WIDTH, maxWidth: 'calc(100vw - 24px)', maxHeight: 420 }}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 pt-2 pb-1">
          <span className="text-[11px] font-mono font-semibold tracking-wider" style={{ color: COLORS.textPrimary }}>
            MESSAGES
          </span>
          <button
            type="button"
            aria-label="Collapse messages"
            aria-expanded={true}
            aria-controls={regionId}
            title="Collapse messages (Esc)"
            onClick={() => { restoreFocusRef.current = true; setExpanded(false) }}
            className={`min-h-6 min-w-6 inline-flex items-center justify-center rounded text-[11px] motion-safe:transition-colors ${FOCUS_RING}`}
            style={{ color: COLORS.textMuted }}
          >
            <ChevronIcon direction="up" />
          </button>
        </div>

        {/* Agent Tabs (hidden when only 1 agent) */}
        {showTabs && (
          <div className="relative">
            <div
              ref={tabsRef}
              role="tablist"
              aria-label="Filter messages by agent"
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
              <span aria-hidden="true" className="pointer-events-none absolute left-0 top-0 bottom-1.5 w-4 flex items-center"
                style={{ color: COLORS.textMuted, background: `linear-gradient(90deg, ${COLORS.panelBg}, transparent)` }}><ChevronIcon direction="left" size={10} /></span>
            )}
            {tabOverflow.right && (
              <span aria-hidden="true" className="pointer-events-none absolute right-0 top-0 bottom-1.5 w-4 flex items-center justify-end"
                style={{ color: COLORS.textMuted, background: `linear-gradient(270deg, ${COLORS.panelBg}, transparent)` }}><ChevronIcon direction="right" size={10} /></span>
            )}
          </div>
        )}

        {/* Pair filter: the communications exchanged between two agents */}
        {(agentsWithMessages.length > 1 || isPairSet(pair)) && (
          <div className="px-2 pb-1.5 flex flex-wrap items-center gap-1">
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

        {/* Message List (virtualized) */}
        {showTabs ? (
          <div
            role="tabpanel"
            id={tabPanelId}
            aria-labelledby={tabId(activeTabIndex)}
            className="flex flex-col flex-1 min-h-0"
          >
            {messageList}
          </div>
        ) : messageList}

        {!isAtBottom && messages.length > 0 && (
          <div className="flex justify-center pt-1">
            <button
              type="button"
              aria-controls={listId}
              onClick={scrollToBottom}
              className={`text-[11px] font-mono px-3 min-h-6 rounded-full motion-safe:transition-all ${FOCUS_RING}`}
              style={{ background: COLORS.holoBg10, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.scrollBtnText }}
            >
              <ArrowDownIcon size={11} className="mr-1 align-[-1px]" />
              {newCount > 0 ? `${newCount} new message${newCount === 1 ? '' : 's'}` : 'Jump to latest'}
            </button>
          </div>
        )}
      </div>
      </div>
    </div>
  )
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

function MessageRow({ message, agentName, fromName, toName, accent, sessionChip, showAgent, isSelected, onClick, runtime, contentId, onFilterPair }: {
  message: ConversationMessage
  agentName: string
  fromName?: string
  toName?: string
  accent?: string
  sessionChip?: string
  showAgent: boolean
  isSelected: boolean
  onClick: (e: React.MouseEvent) => void
  runtime?: Agent['runtime']
  contentId: string
  /** Communication rows: filter the feed on the two agents of this row (keyboard path for Shift-click) */
  onFilterPair?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const commKind = commKindOf(message)
  const role = commKind ? COMM_STYLE[commKind] : (ROLE_COLORS[message.type] ?? ROLE_COLORS.assistant)
  const roleLabel = commKind
    ? COMM_LABELS[commKind]
    : message.type === 'assistant' && runtime === 'codex' ? 'CODEX' : (ROLE_COLORS[message.type] ?? ROLE_COLORS.assistant).label
  const truncated = truncateWithMarker(message.content, commKind ? COMM_TRUNCATE_MAX : MESSAGE_TRUNCATE_MAX)
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
                {from}<span aria-hidden="true"> {'\u2192'} </span><span className="sr-only"> to </span>{to}
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
          {displayText}
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
