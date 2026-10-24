'use client'

// The Conversation panel (issue #32): ONE component, two presentations of the same state.
//   - collapsed pill (top-left, under the top bar): the latest message, role as text
//   - open panel (right dock): agent tabs, pair filter, search, virtual message list
// It replaces the former message feed, session transcript and per-agent chat. The per-agent chat is a preset
// of this panel: selecting an agent opens it with that agent's tab selected.

import { chromeRenderProbe } from '@/lib/row-sync'
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useId, memo } from 'react'
import { Agent, Z, type TeamSummary } from '@/lib/agent-types'
import { COLORS, ROLE_COLORS, getStateColor } from '@/lib/colors'
import type { ConversationMessage, AgentLink } from '@/hooks/simulation/types'
import { useVirtualList } from '@/hooks/use-virtual-list'
import { usePanelRegistration } from '@/hooks/use-panel-registry'
import {
  truncateWithMarker, formatElapsed, trackUnread, emptyUnreadState, type UnreadState,
  markUnread, activeTabIndexOf, EMPTY_MESSAGES, EMPTY_SEARCH, FEED_MESSAGE_TYPES, TOOL_MESSAGE_TYPES, COMM_LABELS, commKindOf, directionText, agentNameOf, teamColorOf,
  hasMultipleSessions, isAgentDone, buildFeedMessages, filterByTab, filterByPair, filterBySearch, latestFeedMessage,
  droppedMarkerFor, agentIdsWithMessages, FEED_TOP, tabBorderStyle, pickerAgentIds, pairFromShiftClick,
  pairOfMessage, tabForSelection, teamChipGroups, COLLAPSED_TEXT_MAX, usesAgentPicker, type FeedMessage,
} from '@/lib/feed-utils'
import { TOUCH_TARGET } from '@/lib/mobile-view'
import { AgentPicker } from './agent-picker'
import { FOCUS_RING, FOCUS_RING_INSET } from '@/lib/focus-ring'
import { nextTabIndex } from '@/lib/tab-nav'
import { usePairFilter, setPair, pickPair, clearPair } from '@/lib/pair-filter-store'
import { isPairComplete, isPairSet } from '@/lib/pair-filter'
import { formatDroppedMessages } from '@/lib/chrome-utils'
import { useLocale } from '@/lib/locale'
import type { Locale } from '@/lib/messages'
import { panelName } from '@/lib/command-palette'
import { stateText } from '@/lib/card-text'
import {
  DATA_EN, t as tr, messageCountText, droppedText, newMessagesText, roleLabelText, commLabelText, hierarchyTermText, teamChipTexts,
  copiedText, exportSavedText, pairEmptyTextT,
} from '@/lib/panel-text'
import { useCopyFeedback } from '@/hooks/use-copy-feedback'
import { conversationExport, copyText, redactForCopy, downloadText, exportFileName, exportNotes, type CommsExportEntry } from '@/lib/comms-export'
import { ChevronIcon, ArrowDownIcon, SearchIcon } from './feed-icons'
import { PairFilterChip } from './pair-filter-chip'
import { COMM_STYLE, HighlightText, TranscriptMessage } from './transcript-message'
import { CloseButton, SlidingPanel, DockResizer, useDockPanel, dockAttrs, dockPanelDomId } from './shared-ui'
import { PANEL_BUTTON_IDS, TOPBAR_MORE_ID } from './top-bar'
import { truncateName } from '@/lib/truncate-name'
import { withHexAlpha } from '@/lib/color-alpha'

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

export const ConversationPanel = memo(function ConversationPanel({
  open, onOpen, onClose,
  conversations, agents, selectedAgentId, onAgentClick, links, droppedMessages, teams,
}: ConversationPanelProps) {
  chromeRenderProbe.onRender?.('ConversationPanel')
  const [activeTab, setActiveTab] = useState<string>(() => tabForSelection(selectedAgentId))
  const [unread, setUnread] = useState<Set<string>>(new Set())
  const [showTools, setShowTools] = useState(true)
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // The pair is shared with the timeline; only the picker visibility is local.
  const pair = usePairFilter()
  const [pickerOpen, setPickerOpen] = useState(false)
  const { message: feedback, notify } = useCopyFeedback()
  const { locale } = useLocale()
  const t = (key: Parameters<typeof tr>[1], params?: Parameters<typeof tr>[2]) => tr(locale, key, params)
  const logRef = useRef<HTMLDivElement>(null)
  const unreadStateRef = useRef<UnreadState>(emptyUnreadState())
  const unreadBaselineRef = useRef(false)
  const pillRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const searchToggleRef = useRef<HTMLButtonElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const baseId = useId()
  const regionId = `${baseId}-region`
  const pillLeadId = `${baseId}-pill-lead`
  const pillPreviewId = `${baseId}-pill-preview`
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

  const messageCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of allMessages) counts.set(m.agentId, (counts.get(m.agentId) ?? 0) + 1)
    return counts
  }, [allMessages])

  const pairActive = isPairComplete(pair)
  const tabMessages = useMemo(
    () => (pairActive ? filterByPair(allMessages, pair.a, pair.b) : filterByTab(allMessages, activeTab)),
    [allMessages, activeTab, pairActive, pair.a, pair.b],
  )
  const messages = useMemo(() => filterBySearch(tabMessages, searchQuery), [tabMessages, searchQuery])
  // A pair is read from the conversations of its two agents: older messages dropped from either may be pair messages
  const pairDropped = pairActive ? (droppedMessages?.get(pair.a) ?? 0) + (droppedMessages?.get(pair.b) ?? 0) : 0
  // English text for the Markdown export (a document written to disk); the panel shows the same count in its own language
  const droppedMarker = pairActive ? formatDroppedMessages(pairDropped) : droppedMarkerFor(droppedMessages, activeTab)
  const droppedCount = pairActive ? pairDropped
    : activeTab === 'all' ? [...(droppedMessages?.values() ?? [])].reduce((a, b) => a + b, 0) : (droppedMessages?.get(activeTab) ?? 0)
  const multiSession = hasMultipleSessions(agents)

  // Virtual list with auto-scroll
  const {
    visibleItems, handleScroll, measureRef,
    isAtBottom, scrollToBottom, startIndex, listStyle, windowStyle, newCount,
  } = useVirtualList(messages, logRef, { gap: MESSAGE_GAP, autoScroll: true, pruneAgainst: allMessages })

  // Track unread messages per agent tab: only agents whose message count increased
  useEffect(() => {
    const { increased, next } = trackUnread(unreadStateRef.current, conversations, links, FEED_MESSAGE_TYPES)
    unreadStateRef.current = next
    // The first pass is the baseline: messages that existed before the panel mounted are not "unread" (opened on an
    // agent tab, every other agent was otherwise counted, which the agent picker shows as "n unread")
    const baseline = !unreadBaselineRef.current
    unreadBaselineRef.current = true
    if (baseline || !open || activeTab === 'all') return
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
    // An open agent card (the panel was opened by selecting that agent) keeps focus: moving it to the pill or
    // the top bar button would close the card, so one Escape would close two things.
    const target = document.querySelector<HTMLElement>('[data-dock-panel="detail"]')
      ?? pillRef.current ?? document.getElementById(PANEL_BUTTON_IDS.conversation) ?? document.getElementById(TOPBAR_MORE_ID)
    target?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (showSearch) searchRef.current?.focus()
  }, [showSearch])

  // From AGENT_PICKER_MIN agents with messages one picker replaces the tabs (a row of 83 tabs scrolled sideways and showed 1 or 2)
  const showPicker = usesAgentPicker(agentsWithMessages.length)
  const showTabs = agentsWithMessages.length > 1 && !showPicker
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
    const next = nextTabIndex(activeTabIndex, e.key, tabKeys.length, 'both')
    if (next === null) return
    e.preventDefault()
    clearPair()
    setActiveTab(tabKeys[next])
    tabRefs.current[next]?.focus()
  }

  // The 5th agent that speaks swaps the tablist for the picker (and the other way when agents go): the focused element is
  // removed with it and focus would fall to <body> (WCAG 2.4.3). Where focus was in the row that leaves, it moves to its
  // counterpart: the picker button, or the active tab. Focus elsewhere is never taken. The refs follow focus in each row;
  // a blur without a target (the element removed, or the window left) does not clear them.
  const [agentListOpen, setAgentListOpen] = useState(false)
  const focusInTabsRef = useRef(false)
  const focusInPickerRef = useRef(false)
  const pickerSlotRef = useRef<HTMLDivElement>(null)
  const shownPickerRef = useRef(showPicker)
  useLayoutEffect(() => {
    const was = shownPickerRef.current
    shownPickerRef.current = showPicker
    if (was === showPicker) return
    const fromTabs = focusInTabsRef.current
    const fromPicker = focusInPickerRef.current
    focusInTabsRef.current = false
    focusInPickerRef.current = false
    const focused = document.activeElement
    if (focused && focused !== document.body) return
    if (showPicker && fromTabs) pickerSlotRef.current?.querySelector<HTMLElement>('[data-agent-picker-button]')?.focus({ preventScroll: true })
    else if (!showPicker && fromPicker) tabRefs.current[activeTabIndex]?.focus({ preventScroll: true })
  }, [showPicker, activeTabIndex])
  const trackFocus = (ref: React.MutableRefObject<boolean>) => ({
    onFocus: () => { ref.current = true },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) ref.current = false
    },
  })

  const teamGroups = useMemo(
    () => (open && teams && teams.size > 0
      ? teamChipGroups([...agents.values()], teams)
      : []),
    [open, teams, agents],
  )

  // Right dock (resizable): the open panel is placed by the shared layout, like Files
  const dock = useDockPanel('conversation', open)
  const { rect } = dock

  // ── Collapsed pill ──
  if (!open) {
    if (!latestMessage) return null
    const agentName = agentNameOf(agents, latestMessage.agentId)
    const latestKind = commKindOf(latestMessage)
    const base = ROLE_COLORS[latestMessage.type] ?? ROLE_COLORS.assistant
    const role = latestKind
      ? { ...COMM_STYLE[latestKind], label: commLabelText(locale, latestKind) }
      : { ...base, label: roleLabelText(locale, latestMessage.type, agents.get(latestMessage.agentId)?.runtime) }
    const preview = latestMessage.content.replace(/\n/g, ' ').slice(0, PREVIEW_MAX)

    return (
      <div
        // Companion of the agent card: an obstacle for the dock layout (the card is placed beside / below
        // it), and focus moving to the pill (focus return) must not close the card
        data-companion-panel=""
        // Laid over the canvas without reserving an edge: the halo titles and other canvas texts move off it (#378)
        data-canvas-cover=""
        lang={locale}
        className="absolute"
        style={{ top: FEED_TOP, left: 12, zIndex: Z.info, pointerEvents: 'auto', maxWidth: 'calc(100vw - 24px)' }}
      >
        <button
          ref={pillRef}
          type="button"
          aria-expanded={false}
          aria-controls={regionId}
          // Named by two hidden elements, not by an aria-label: the sentence is in the interface language, the preview is a
          // message of the conversation (data, "en") and an aria-label cannot declare a language (WCAG 3.1.2). The visible
          // role, agent and preview are all in this name (WCAG 2.5.3); the button content is not read a second time.
          aria-labelledby={`${pillLeadId} ${pillPreviewId}`}
          title={agentName}
          onClick={onOpen}
          className={`glass-card text-left px-3 py-2 min-h-6 flex items-center gap-2 w-full motion-safe:transition-all motion-safe:hover:scale-[1.02] ${FOCUS_RING_INSET}`}
          style={{ maxWidth: PILL_MAX_WIDTH }}
        >
          <span id={pillLeadId} hidden>{t('conv.pill.lead', { open: t('conv.open', { name: panelName(locale, 'conversation') }), role: role.label.toLowerCase(), agent: agentName })}</span>
          <span id={pillPreviewId} hidden {...DATA_EN}>{preview}</span>
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: role.text }} />
          {/* Role as text too: colour alone must not carry it (WCAG 1.4.1) */}
          <span className="text-2xs font-mono font-semibold shrink-0" style={{ color: role.text }}>{role.label}</span>
          <span className="text-2xs font-mono font-semibold shrink-0" style={{ color: COLORS.textPrimary }}>
            {truncateName(agentName, COLLAPSED_AGENT_NAME_MAX)}
          </span>
          <span {...DATA_EN} className="text-2xs font-mono truncate" style={{ color: role.text }}>
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

  const droppedLocal = droppedText(locale, droppedCount)
  const droppedNote = droppedLocal ? (
    <p className="text-2xs font-mono px-3 pb-1" style={{ color: COLORS.textMuted }}>{droppedLocal}</p>
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
      aria-label={pairActive ? t('conv.log.pair', { a: agentNameOf(agents, pair.a), b: agentNameOf(agents, pair.b) }) : activeTab === 'all' ? t('conv.log.all') : t('conv.log.agent', { name: agentNameOf(agents, activeTab) })}
      tabIndex={0}
      className={`flex-1 min-h-32 overflow-y-auto px-2 pb-2 ${FOCUS_RING_INSET}`}
      style={{ scrollbarWidth: 'thin', scrollbarColor: `${COLORS.scrollbarThumb} transparent` }}
    >
      {messages.length === 0 ? (
        <div className="flex items-center justify-center py-6">
          <span className="text-2xs font-mono" style={{ color: COLORS.textMuted }}>
            {searching ? t('conv.emptySearch') : pairActive ? pairEmptyTextT(locale, pair, nameOfAgent) : t('conv.empty')}
          </span>
        </div>
      ) : (
        <div style={listStyle}>
          <div role="list" aria-label={t('conv.list')} style={windowStyle}>
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
                    onCopy={msg.type === 'dispatch' || msg.type === 'return' ? () => { void copyMessage(msg) } : undefined}
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

  const exportScope = pairActive
    ? `${agentNameOf(agents, pair.a)} and ${agentNameOf(agents, pair.b)}`
    : activeTab === 'all' ? 'all agents' : agentNameOf(agents, activeTab)
  const entryOf = (m: FeedMessage): CommsExportEntry => ({
    label: (commKindOf(m) ? COMM_LABELS[commKindOf(m)!] : roleLabelOf(m.type, agents.get(m.agentId)?.runtime)).toUpperCase(),
    sender: m.from ? agentNameOf(agents, m.from) : (commKindOf(m) ? undefined : agentNameOf(agents, m.agentId)),
    receiver: m.to ? agentNameOf(agents, m.to) : undefined,
    time: formatElapsed(m.timestamp).label,
    content: m.content,
    truncatedChars: m.cutChars,
  })
  const roleLabelLocal = (m: FeedMessage) => (commKindOf(m) ? commLabelText(locale, commKindOf(m)!) : roleLabelText(locale, m.type, agents.get(m.agentId)?.runtime)).toUpperCase()
  const copyMessage = async (m: FeedMessage) => {
    const e = entryOf(m)
    const { text, redactions } = redactForCopy(m.content)
    const ok = await copyText(text)
    notify(ok ? copiedText(locale, roleLabelLocal(m), e.truncatedChars ?? 0, redactions) : t('conv.copyFailed'))
  }
  const exportConversation = () => {
    const title = `Conversation: ${exportScope}`
    const { markdown: md, redactions } = conversationExport({
      title,
      entries: messages.map(entryOf),
      notes: exportNotes({ droppedText: droppedMarker, toolsHidden: !showTools, searchQuery }),
    })
    notify(downloadText(exportFileName(title), md) ? exportSavedText(locale, redactions) : t('conv.exportFailed'))
  }

  const newMessagesLabel = newMessagesText(locale, newCount)

  // "Filter pair" toggle, on the row of the tabs or of the agent picker
  const pairToggle = (
    <button
      type="button"
      aria-expanded={pickerOpen}
      title={t('conv.pair.title')}
      onClick={() => setPickerOpen(v => !v)}
      className={`shrink-0 min-h-6 ${TOUCH_TARGET} px-2 rounded text-2xs font-mono ${FOCUS_RING_INSET}`}
      style={{ color: pickerOpen || isPairSet(pair) ? COLORS.textPrimary : COLORS.textMuted, border: `1px solid ${COLORS.controlBorder}` }}
    >
      {t('conv.pair.button')}
    </button>
  )

  return (
    <SlidingPanel
      visible
      position={rect ? { top: rect.y, left: rect.x } : { top: 'calc(var(--topbar-h, 60px) + 8px)', right: 12, bottom: 72 }}
      zIndex={Z.sidePanel}
      width={rect?.w ?? dock.rightWidth}
      labelledBy={titleId}
      attrs={{ ...dockAttrs('conversation', 'right', dock), 'data-sensitive': '' }}
      style={{ height: rect?.h, display: dock.hidden ? 'none' : undefined }}
    >
      <DockResizer label={t('conv.resize')} valueText={px => t('sessions.resize.value', { px })} controls={dockPanelDomId('conversation')} />
      <div
        id={regionId}
        lang={locale}
        className="h-full flex flex-col"
        style={{ background: COLORS.panelBg, backdropFilter: 'blur(24px)', borderLeft: `1px solid ${COLORS.holoBorder10}` }}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 flex-shrink-0 max-md:flex-wrap" style={{ borderBottom: `1px solid ${COLORS.holoBorder08}` }}>
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <h2 id={titleId} className="m-0 text-2xs font-mono tracking-widest font-semibold" style={{ color: COLORS.panelLabel }}>
              {panelName(locale, 'conversation')}
            </h2>
            <span className="text-2xs font-mono whitespace-nowrap shrink-0" style={{ color: COLORS.panelLabelDim }}>
              {searching ? messageCountText(locale, totalCount, messages.length) : messageCountText(locale, totalCount)}
            </span>
            {presetAgent && presetColor && (
              <span className="text-2xs font-mono inline-flex items-center gap-1 min-w-0" style={{ color: presetColor }}>
                <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: presetColor, boxShadow: `0 0 6px ${presetColor}` }} />
                <span className="truncate" title={presetAgent.name}>{presetAgent.name}</span>
                <span>{stateText(locale, presetAgent.state)}</span>
              </span>
            )}
          </div>
          {/* Under 768 px the 44 px Close button must stay inside a 320 px drawer: the actions wrap (#476) */}
          <div className="flex items-center gap-1 flex-shrink-0 max-md:flex-shrink max-md:min-w-0 max-md:flex-wrap max-md:justify-end">
            <button
              type="button"
              aria-pressed={showTools}
              title={t('conv.toolCalls.title')}
              onClick={() => setShowTools(v => !v)}
              className={`text-2xs font-mono px-1.5 min-h-6 min-w-6 rounded motion-safe:transition-all ${FOCUS_RING_INSET}`}
              style={{
                background: showTools ? COLORS.toggleActive : 'transparent',
                color: showTools ? COLORS.assistantText : COLORS.textMuted,
                border: `1px solid ${COLORS.controlBorder}`,
              }}
            >
              {t('conv.toolCalls')}
            </button>
            <button
              type="button"
              disabled={messages.length === 0}
              onClick={exportConversation}
              title={t('conv.export.title')}
              className={`text-2xs font-mono px-1.5 min-h-6 min-w-6 rounded motion-safe:transition-all disabled:opacity-50 ${FOCUS_RING_INSET}`}
              style={{ color: COLORS.textMuted, border: `1px solid ${COLORS.controlBorder}` }}
            >
              {t('conv.export')}
            </button>
            <button
              ref={searchToggleRef}
              type="button"
              onClick={() => { setShowSearch(s => !s); if (showSearch) setSearchQuery('') }}
              aria-label={t('conv.search')}
              aria-expanded={showSearch}
              aria-controls={searchId}
              title={t('conv.search')}
              className={`text-2xs font-mono px-1.5 min-h-6 min-w-6 rounded motion-safe:transition-all ${FOCUS_RING_INSET}`}
              style={{
                background: showSearch ? COLORS.toggleActive : 'transparent',
                color: showSearch ? COLORS.assistantText : COLORS.textMuted,
              }}
            >
              <SearchIcon size={12} />
            </button>
            <CloseButton onClick={onClose} className="px-1" label={t('common.close')} />
          </div>
        </div>

        {/* Search bar */}
        {showSearch && (
          <div id={searchId} className="px-3 py-1.5 flex-shrink-0" style={{ borderBottom: `1px solid ${COLORS.holoBorder06}` }}>
            <input
              ref={searchRef}
              type="search"
              aria-label={t('conv.search')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(''); searchToggleRef.current?.focus() }
                e.stopPropagation()
              }}
              placeholder={t('conv.search.placeholder')}
              className={`w-full px-2 py-1 min-h-6 rounded text-xs font-mono placeholder:text-[color:var(--ph)] ${FOCUS_RING}`}
              style={{
                background: COLORS.holoBg05,
                border: `1px solid ${COLORS.controlBorder}`,
                color: COLORS.assistantText,
                ['--ph' as string]: COLORS.textMuted,
              }}
            />
          </div>
        )}

        {/* Many agents: one picker button and a searchable, grouped list instead of the tabs */}
        {showPicker && (
          // display: contents keeps the picker a direct flex item of the panel (its 70 % cap); the wrapper only follows focus
          <div ref={pickerSlotRef} className="contents" {...trackFocus(focusInPickerRef)}>
          <AgentPicker
            ids={agentsWithMessages}
            agents={agents}
            teams={teams}
            activeKey={activeTab}
            unread={unread}
            messageCounts={messageCounts}
            totalMessages={allMessages.length}
            onPick={onTabClick}
            onOpenChange={setAgentListOpen}
          >
            {pairToggle}
          </AgentPicker>
          </div>
        )}

        {/* Agent tabs (hidden when only one agent speaks): they wrap, never scroll sideways */}
        {showTabs && (
          <div className="flex-shrink-0 pt-1.5 pb-1.5 px-2 flex flex-wrap items-start gap-1" style={{ borderBottom: `1px solid ${COLORS.holoBorder06}` }} {...trackFocus(focusInTabsRef)}>
            <div
              role="tablist"
              aria-label={t('conv.tablist')}
              aria-orientation="horizontal"
              // Roving tabindex: the active tab is the only tab stop; -1 lets the list own the arrow keys without adding one
              tabIndex={-1}
              onKeyDown={onTabKeyDown}
              // Takes the row (Filter pair wraps below it when the panel is narrow); up to 128 px high (four rows), 192 px under 768 px
              // (44 px tabs), then a vertical scroll
              className="flex flex-wrap gap-1 min-w-0 flex-[1_1_12rem] max-h-32 max-md:max-h-48 overflow-y-auto outline-none"
              style={{ scrollbarWidth: 'thin', scrollbarColor: `${COLORS.scrollbarThumb} transparent` }}
            >
              {tabKeys.map((key, i) => {
                const agent = key === 'all' ? undefined : agents.get(key)
                const name = key === 'all' ? t('conv.tab.all') : agentNameOf(agents, key)
                const color = key === 'all' ? COLORS.holoBase : (agent ? getStateColor(agent.state) : COLORS.idle)
                const done = key !== 'all' && isAgentDone(agent)
                return (
                  <TabButton
                    key={key}
                    id={tabId(i)}
                    panelId={tabPanelId}
                    buttonRef={(el) => { tabRefs.current[i] = el }}
                    label={truncateName(name, TAB_AGENT_NAME_MAX)}
                    fullName={name}
                    stateText={key === 'all' ? undefined : (done ? t('conv.tab.done') : stateText(locale, agent!.state))}
                    done={done}
                    accent={teamColorOf(agent, teams)}
                    active={i === activeTabIndex}
                    onClick={(e) => onTabClick(key, e.shiftKey)}
                    color={color}
                    hasUnread={key !== 'all' && unread.has(key)}
                    count={key === 'all' ? allMessages.length : (messageCounts.get(key) ?? 0)}
                    working={key !== 'all' && !done && (agent?.state === 'thinking' || agent?.state === 'tool_calling')}
                    isAll={key === 'all'}
                  />
                )
              })}
            </div>
            {pairToggle}
          </div>
        )}

        {/* Pair filter: the communications exchanged between two agents (toggle lives in the tab row) */}
        {(pickerOpen || isPairSet(pair)) && (
          <div className="px-2 py-1 flex flex-wrap items-center gap-1 flex-shrink-0 max-h-16 max-md:max-h-32 overflow-y-auto">
            {!showTabs && !showPicker && (
              <button
                type="button"
                aria-expanded={pickerOpen}
                onClick={() => setPickerOpen(v => !v)}
                className={`min-h-6 ${TOUCH_TARGET} px-2 rounded text-2xs font-mono ${FOCUS_RING_INSET}`}
                style={{ color: COLORS.textMuted, border: `1px solid ${COLORS.controlBorder}` }}
              >
                {t('conv.pair.button')}
              </button>
            )}
            <PairFilterChip pair={pair} nameOf={nameOfAgent} count={messages.length} onClear={clearPair} locale={locale} />
            {pickerOpen && (
              <span className="inline-flex flex-wrap items-center gap-1 max-w-full min-w-0">
                {([[t('conv.pair.first'), pair.a, (v: string) => setPair(v, pair.b)], [t('conv.pair.second'), pair.b, (v: string) => setPair(pair.a, v)]] as const).map(([label, value, set]) => (
                  <select
                    key={label}
                    aria-label={label}
                    value={value}
                    onChange={e => set(e.target.value)}
                    // No fixed width: a long agent name is no longer cut at 120 px; the panel width is the limit
                    className={`min-h-6 ${TOUCH_TARGET} max-w-full min-w-0 rounded text-2xs font-mono ${FOCUS_RING_INSET}`}
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
        {/* Folded while the agent list is open: on a short panel it took the height the list needed (WCAG 1.4.10) */}
        {teamGroups.length > 0 && !(showPicker && agentListOpen) && (
          <section aria-label={teamGroups.some(g => g.kind === 'workflow') ? t('conv.teamsAndWorkflows') : t('conv.teams')} tabIndex={0} className={`px-3 py-1.5 flex-shrink-0 max-h-24 overflow-y-auto ${FOCUS_RING_INSET}`} style={{ borderBottom: `1px solid ${COLORS.holoBorder06}`, scrollbarWidth: 'thin', scrollbarColor: `${COLORS.scrollbarThumb} transparent` }}>
            {teamGroups.map(g => (
              <div key={g.key} role="group" aria-label={teamChipTexts(locale, g).label}>
                <h3 className="text-2xs font-mono font-semibold tracking-wider" style={{ color: COLORS.panelLabel }}>
                  {teamChipTexts(locale, g).heading}
                </h3>
                <ul className="flex flex-wrap gap-x-2 gap-y-0.5 pb-1">
                  {g.items.map(a => (
                    <li key={a.id} className="text-2xs font-mono flex items-center gap-1" style={{ color: COLORS.textMuted }}>
                      <span aria-hidden="true" className="inline-block w-2 h-2 rounded-full" style={{ background: teamColorOf(a, teams) ?? COLORS.textMuted }} />
                      {a.name}
                      <span className="sr-only">, {hierarchyTermText(locale, a)}</span>
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
        <div role="status" className="sr-only">{!isAtBottom && newCount > 0 ? newMessagesLabel : ''}</div>
        <p role="status" data-testid="copy-feedback" className={`m-0 px-3 text-2xs font-mono ${feedback ? 'py-1' : ''}`} style={{ color: COLORS.textPrimary }}>{feedback}</p>

        {!isAtBottom && messages.length > 0 && (
          <div className="flex justify-center py-1 flex-shrink-0" style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
            <button
              type="button"
              aria-controls={listId}
              onClick={scrollToBottom}
              className={`text-2xs font-mono px-3 min-h-6 rounded-full motion-safe:transition-all ${FOCUS_RING_INSET}`}
              style={{ background: COLORS.holoBg10, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.scrollBtnText }}
            >
              <ArrowDownIcon size={11} className="mr-1 align-[-1px]" />
              {newCount > 0 ? newMessagesLabel : t('conv.jump')}
            </button>
          </div>
        )}
      </div>
    </SlidingPanel>
  )
})

/** Role label of a conversation message: the assistant is named after the runtime of the agent that spoke. */
function roleLabelOf(type: string, runtime?: Agent['runtime']): string {
  if (type === 'assistant' && runtime === 'codex') return 'CODEX'
  if (type === 'assistant' && runtime === 'copilot') return 'COPILOT'
  if (type === 'assistant' && runtime === 'pi') return 'PI'
  if (type === 'assistant' && runtime === 'gemini') return 'GEMINI'
  if (type === 'assistant' && runtime === 'opencode') return 'OPENCODE'
  return (ROLE_COLORS[type] ?? ROLE_COLORS.assistant).label
}

// ── Tab Button ──

function TabButton({ id, panelId, buttonRef, label, fullName, stateText, active, onClick, color, hasUnread, done, accent, count, working, isAll }: {
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
  /** Messages shown for this tab */
  count?: number
  /** The agent is running: its dot pulses */
  working?: boolean
  /** The 'All' tab has no state dot */
  isAll?: boolean
}) {
  const { locale } = useLocale()
  const accessibleName = [fullName, stateText ? `(${stateText})` : '', count !== undefined && count > 0 ? messageCountText(locale, count) : '', hasUnread ? tr(locale, 'conv.tab.unreadName') : '']
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
      className={`px-2 min-h-7 ${TOUCH_TARGET} max-w-full rounded-md text-xs font-mono motion-safe:transition-all shrink-0 relative inline-flex items-center gap-1.5 ${active ? 'font-semibold' : ''} ${FOCUS_RING_INSET}`}
      style={{
        background: active ? withHexAlpha(color, '26') : COLORS.holoBg05,
        color: active ? color : COLORS.textMuted,
        ...tabBorderStyle({ active, color, accent, done }),
      }}
    >
      {!isAll && (
        <span
          aria-hidden="true"
          className={`inline-block w-2 h-2 rounded-full shrink-0 ${working ? 'motion-safe:animate-pulse' : ''}`}
          style={{ background: color, opacity: done ? 0.5 : 1 }}
        />
      )}
      {label}
      {count !== undefined && count > 0 && (
        <span aria-hidden="true" className="text-[10px] tabular-nums px-1 rounded" style={{ background: COLORS.holoBg10, color: COLORS.textMuted }}>{count}</span>
      )}
      {done && <span aria-hidden="true" className="text-2xs">{tr(locale, 'conv.tab.done')}</span>}
      {hasUnread && (
        <>
          <span className="sr-only"> {tr(locale, 'conv.tab.unread')}</span>
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

function MessageRow({ message, agentName, fromName, toName, accent, sessionChip, showAgent, isSelected, searchQuery, onClick, runtime, contentId, onFilterPair, onCopy }: {
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
  /** DISPATCH / RETURN rows: copy the full prompt or report */
  onCopy?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const { locale } = useLocale()
  const commKind = commKindOf(message)
  const role = commKind ? COMM_STYLE[commKind] : (ROLE_COLORS[message.type] ?? ROLE_COLORS.assistant)
  const roleLabel = commKind ? commLabelText(locale, commKind) : roleLabelText(locale, message.type, runtime)
  // One truncation rule for every row: COLLAPSED_TEXT_MAX characters with a "Show all" toggle
  const truncated = truncateWithMarker(message.content, COLLAPSED_TEXT_MAX)
  const isLong = truncated.hidden > 0
  const displayText = expanded || !isLong ? message.content : truncated.text
  const markerText = expanded || !isLong ? '' : tr(locale, 'conv.marker', { n: truncated.hidden })
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
        title={direction ? `${direction} - ${roleLabel}` : (showAgent ? tr(locale, 'conv.row.showAgentNamed', { name: agentName }) : tr(locale, 'conv.row.showAgent'))}
        className={`block w-full min-h-6 text-left rounded ${FOCUS_RING_INSET}`}
      >
        {/* Header row */}
        <span className="flex items-center gap-1.5 mb-0.5 flex-wrap">
          {direction ? (
            <>
              <span className="text-2xs font-mono font-semibold break-all" style={{ color: role.text }}>
                {from}<span aria-hidden="true"> {'→'} </span><span className="sr-only"> {tr(locale, 'conv.row.to')} </span>{to}
              </span>
              <span className="text-2xs font-mono font-semibold" style={{ color: role.text }}>
                <span aria-hidden="true">- </span><span className="sr-only">, </span>{roleLabel}
              </span>
            </>
          ) : (
            <span className="text-2xs font-mono font-semibold" style={{ color: role.text }}>
              {roleLabel}
            </span>
          )}
          {showAgent && !direction && (
            <span className="text-2xs font-mono truncate" title={agentName} style={{ color: COLORS.textMuted }}>
              {agentName}
            </span>
          )}
          {sessionChip && (
            <span className="text-2xs font-mono truncate max-w-[96px] px-1 rounded" title={tr(locale, 'conv.row.sessionTitle', { id: sessionChip })}
              style={{ color: COLORS.textMuted, border: `1px solid ${COLORS.controlBorder}` }}>
              {sessionChip}
            </span>
          )}
          <time dateTime={time.iso} className="text-2xs font-mono ml-auto shrink-0" style={{ color: COLORS.textMuted }}>
            {time.label}
          </time>
        </span>

        {/* Content */}
        <span
          id={contentId}
          className="block text-xs font-mono leading-relaxed whitespace-pre-wrap break-words"
          style={{ color: role.text }}
        >
          <span {...DATA_EN}><HighlightText text={displayText} query={searchQuery} /></span>{markerText}
        </span>
      </button>

      {onFilterPair && (
        <button
          type="button"
          aria-label={direction ? tr(locale, 'conv.pair.rowAria', { direction }) : tr(locale, 'conv.pair.button')}
          onClick={onFilterPair}
          className={`text-2xs font-mono mt-0.5 mr-1 min-h-6 px-1 rounded motion-safe:transition-colors ${FOCUS_RING_INSET}`}
          style={{ color: COLORS.textMuted }}
        >
          {tr(locale, 'conv.pair.button')}
        </button>
      )}

      {onCopy && (
        <button
          type="button"
          aria-label={direction ? tr(locale, 'conv.row.copyAriaDir', { role: roleLabel.toLowerCase(), direction }) : tr(locale, 'conv.row.copyAria', { role: roleLabel.toLowerCase() })}
          onClick={onCopy}
          className={`text-2xs font-mono mt-0.5 mr-1 min-h-6 px-1 rounded motion-safe:transition-colors ${FOCUS_RING_INSET}`}
          style={{ color: COLORS.textMuted }}
        >
          {tr(locale, 'conv.row.copy')}
        </button>
      )}

      {/* Expand/collapse for long messages */}
      {isLong && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          className={`text-2xs font-mono mt-0.5 min-h-6 px-1 rounded motion-safe:transition-colors ${FOCUS_RING_INSET}`}
          style={{ color: COLORS.textMuted }}
          onClick={() => setExpanded(prev => !prev)}
        >
          <ChevronIcon direction={expanded ? 'up' : 'down'} size={10} className="mr-1" />
          {expanded ? tr(locale, 'conv.showLess') : tr(locale, 'conv.showAll', { n: truncated.hidden })}
        </button>
      )}
    </div>
  )
}
