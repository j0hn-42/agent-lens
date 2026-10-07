'use client'

import { useState, useEffect, useRef, useMemo, useCallback, useId } from 'react'
import { Agent, Z, type AgentState } from '@/lib/agent-types'
import { COLORS, ROLE_COLORS, getStateColor } from '@/lib/colors'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { useClickOutside } from '@/hooks/use-click-outside'
import { useVirtualList } from '@/hooks/use-virtual-list'
import {
  stateLabel, truncateWithMarker, formatElapsed, agentsWithNewText, nextTabIndex,
  EMPTY_MESSAGES, FOCUS_RING,
} from './feed-utils'

interface MessageFeedPanelProps {
  conversations: Map<string, ConversationMessage[]>
  agents: Map<string, Agent>
  onAgentClick: (agentId: string | null) => void
  selectedAgentId: string | null
}

// Only show text messages (assistant, user, thinking) — tool calls visible via agent selection
const TEXT_TYPES = new Set(['assistant', 'user', 'thinking'])

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
}: MessageFeedPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [activeTab, setActiveTab] = useState<string>('all')
  const [unread, setUnread] = useState<Set<string>>(new Set())
  const logRef = useRef<HTMLDivElement>(null)
  const prevLensRef = useRef<Map<string, number>>(new Map())
  const pillRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef(false)
  const tabsRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [tabOverflow, setTabOverflow] = useState({ left: false, right: false })
  const baseId = useId()
  const tabPanelId = `${baseId}-panel`
  const tabId = (i: number) => `${baseId}-tab-${i}`
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  // Stable key that only changes when agent set membership or names change
  const agentKey = useMemo(() => {
    const parts: string[] = []
    for (const [id, a] of agents) parts.push(`${id}:${a.name}:${a.isMain}`)
    return parts.sort().join('|')
  }, [agents])

  // ── Latest message (cheap — used by collapsed view) ──
  const latestMessage = useMemo(() => {
    const currentAgents = agentsRef.current
    let latest: (ConversationMessage & { agentId: string }) | null = null
    for (const [agentId, msgs] of conversations) {
      if (!currentAgents.has(agentId)) continue
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (!TEXT_TYPES.has(msgs[i].type)) continue
        if (!latest || msgs[i].timestamp > latest.timestamp) {
          latest = { ...msgs[i], agentId }
        }
        break
      }
    }
    return latest
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, agentKey])

  // ── Expensive memos — only compute when expanded ──

  const agentsWithMessages = useMemo(() => {
    if (!expanded) return []
    const currentAgents = agentsRef.current
    const ids: string[] = []
    for (const [agentId, msgs] of conversations) {
      if (!currentAgents.has(agentId)) continue
      if (msgs.some(m => TEXT_TYPES.has(m.type))) ids.push(agentId)
    }
    return ids.sort((a, b) => {
      const agA = currentAgents.get(a)
      const agB = currentAgents.get(b)
      if (agA?.isMain) return -1
      if (agB?.isMain) return 1
      return (agA?.name ?? a).localeCompare(agB?.name ?? b)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded ? conversations : null, expanded, agentKey])

  // Incremental message cache
  const messagesCacheRef = useRef<{
    key: string
    counts: Map<string, number>
    result: (ConversationMessage & { agentId: string })[]
  }>({ key: '', counts: new Map(), result: [] })

  const messages = useMemo(() => {
    if (!expanded) return []
    const currentAgents = agentsRef.current
    const cache = messagesCacheRef.current
    const cacheKey = `${activeTab}:${agentKey}`

    if (cache.key !== cacheKey) {
      cache.key = cacheKey
      cache.counts = new Map()
      cache.result = []
    }

    if (activeTab === 'all') {
      let appended = false
      for (const [agentId, msgs] of conversations) {
        if (!currentAgents.has(agentId)) continue
        const prevLen = cache.counts.get(agentId) ?? 0
        if (msgs.length > prevLen) {
          for (let i = prevLen; i < msgs.length; i++) {
            if (TEXT_TYPES.has(msgs[i].type)) cache.result.push({ ...msgs[i], agentId })
          }
          cache.counts.set(agentId, msgs.length)
          appended = true
        }
      }
      if (appended) cache.result.sort((a, b) => a.timestamp - b.timestamp)
      return cache.result
    }

    const msgs = conversations.get(activeTab) ?? []
    const prevLen = cache.counts.get(activeTab) ?? 0
    if (msgs.length > prevLen) {
      for (let i = prevLen; i < msgs.length; i++) {
        if (TEXT_TYPES.has(msgs[i].type)) cache.result.push({ ...msgs[i], agentId: activeTab })
      }
      cache.counts.set(activeTab, msgs.length)
    }
    return cache.result
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded ? conversations : null, expanded, activeTab, agentKey])

  // Virtual list with auto-scroll
  const {
    visibleItems, handleScroll, measureRef,
    isAtBottom, scrollToBottom, startIndex, listStyle, windowStyle, newCount,
  } = useVirtualList(messages, logRef, { gap: MESSAGE_GAP, autoScroll: true })

  // Track unread messages per agent tab: only agents whose message count increased
  useEffect(() => {
    const { increased, nextLens } = agentsWithNewText(prevLensRef.current, conversations, TEXT_TYPES)
    prevLensRef.current = nextLens
    if (!expanded || activeTab === 'all') return
    const toMark = increased.filter(id => id !== activeTab)
    if (toMark.length === 0) return
    setUnread(prev => {
      const next = new Set(prev)
      for (const id of toMark) next.add(id)
      return next
    })
  }, [conversations, expanded, activeTab])

  useEffect(() => {
    if (activeTab !== 'all') {
      setUnread(prev => { const next = new Set(prev); next.delete(activeTab); return next })
    } else {
      setUnread(new Set())
    }
  }, [activeTab])

  useEffect(() => {
    if (activeTab !== 'all' && !conversations.has(activeTab)) setActiveTab('all')
  }, [conversations, activeTab])

  useEffect(() => {
    if (selectedAgentId) {
      const selected = agentsRef.current.get(selectedAgentId)
      if (selected && !selected.isMain) setActiveTab(selectedAgentId)
      else setActiveTab('all')
    } else {
      setActiveTab('all')
    }
  }, [selectedAgentId])

  const panelRef = useRef<HTMLDivElement>(null)
  const collapsePanel = useCallback(() => setExpanded(false), [])
  useClickOutside(panelRef, collapsePanel)

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
  const activeTabIndex = Math.max(0, tabKeys.indexOf(activeTab))

  const onTabKeyDown = (e: React.KeyboardEvent) => {
    const next = nextTabIndex(e.key, activeTabIndex, tabKeys.length)
    if (next === null) return
    e.preventDefault()
    setActiveTab(tabKeys[next])
    tabRefs.current[next]?.focus()
  }

  if (!latestMessage && agentsWithMessages.length === 0) return null

  // ── Collapsed ──
  if (!expanded) {
    if (!latestMessage) return null
    const agent = agents.get(latestMessage.agentId)
    const agentName = agent?.name ?? latestMessage.agentId
    const role = ROLE_COLORS[latestMessage.type] ?? ROLE_COLORS.assistant
    const preview = latestMessage.content.replace(/\n/g, ' ').slice(0, PREVIEW_MAX)

    return (
      <div
        className="absolute"
        style={{ top: 48, left: 12, zIndex: Z.info, pointerEvents: 'auto', maxWidth: 'calc(100vw - 24px)' }}
      >
        <button
          ref={pillRef}
          type="button"
          aria-expanded={false}
          aria-label={`Expand messages. Latest from ${agentName}: ${preview}`}
          title={agentName}
          onClick={() => setExpanded(true)}
          className={`glass-card text-left px-3 py-2 min-h-6 flex items-center gap-2 w-full motion-safe:transition-all motion-safe:hover:scale-[1.02] ${FOCUS_RING}`}
          style={{ maxWidth: PANEL_WIDTH }}
        >
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: role.text }} />
          <span className="text-[11px] font-mono font-semibold shrink-0" style={{ color: COLORS.textPrimary }}>
            {agentName.length > COLLAPSED_AGENT_NAME_MAX ? agentName.slice(0, COLLAPSED_AGENT_NAME_MAX) + '..' : agentName}
          </span>
          <span className="text-[11px] font-mono truncate" style={{ color: role.text }}>
            {preview}{latestMessage.content.length > PREVIEW_MAX ? '...' : ''}
          </span>
          <span aria-hidden="true" className="text-[11px] shrink-0" style={{ color: COLORS.textMuted }}>▾</span>
        </button>
      </div>
    )
  }

  // ── Expanded (virtualized) ──
  const messageList = (
    <div
      ref={logRef}
      onScroll={handleScroll}
      role="log"
      aria-live="off"
      aria-label={activeTab === 'all' ? 'Messages from all agents' : `Messages from ${agents.get(activeTab)?.name ?? activeTab}`}
      tabIndex={0}
      className={`flex-1 overflow-y-auto px-2 pb-2 ${FOCUS_RING}`}
      style={{ maxHeight: 340, scrollbarWidth: 'thin', scrollbarColor: `${COLORS.scrollbarThumb} transparent` }}
    >
      {messages.length === 0 ? (
        <div className="flex items-center justify-center py-6">
          <span className="text-[11px] font-mono" style={{ color: COLORS.textMuted }}>
            {EMPTY_MESSAGES}
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
                  agentName={agents.get(msg.agentId)?.name ?? msg.agentId}
                  showAgent={activeTab === 'all'}
                  isSelected={selectedAgentId === msg.agentId}
                  onClick={() => { onAgentClick(msg.agentId); setExpanded(false) }}
                  runtime={agents.get(msg.agentId)?.runtime}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div
      ref={panelRef}
      role="region"
      aria-label="Messages"
      className="absolute"
      style={{ top: 48, left: 12, zIndex: Z.info, pointerEvents: 'auto', maxWidth: 'calc(100vw - 24px)' }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          restoreFocusRef.current = true
          setExpanded(false)
        }
      }}
    >
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
            title="Collapse messages (Esc)"
            onClick={() => { restoreFocusRef.current = true; setExpanded(false) }}
            className={`min-h-6 min-w-6 inline-flex items-center justify-center rounded text-[11px] motion-safe:transition-colors ${FOCUS_RING}`}
            style={{ color: COLORS.textMuted }}
          >
            <span aria-hidden="true">▴</span>
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
                const name = key === 'all' ? 'All' : (agent?.name ?? key)
                const color = key === 'all' ? COLORS.holoBase : (agent ? getStateColor(agent.state) : COLORS.idle)
                return (
                  <TabButton
                    key={key}
                    id={tabId(i)}
                    panelId={tabPanelId}
                    buttonRef={(el) => { tabRefs.current[i] = el }}
                    label={name.length > TAB_AGENT_NAME_MAX ? name.slice(0, TAB_AGENT_NAME_MAX) + '..' : name}
                    fullName={name}
                    stateText={agent ? stateLabel(agent.state) : undefined}
                    active={activeTab === key}
                    onClick={() => setActiveTab(key)}
                    color={color}
                    hasUnread={key !== 'all' && unread.has(key)}
                  />
                )
              })}
            </div>
            {tabOverflow.left && (
              <span aria-hidden="true" className="pointer-events-none absolute left-0 top-0 bottom-1.5 w-4 flex items-center text-[11px]"
                style={{ color: COLORS.textMuted, background: `linear-gradient(90deg, ${COLORS.panelBg}, transparent)` }}>‹</span>
            )}
            {tabOverflow.right && (
              <span aria-hidden="true" className="pointer-events-none absolute right-0 top-0 bottom-1.5 w-4 flex items-center justify-end text-[11px]"
                style={{ color: COLORS.textMuted, background: `linear-gradient(270deg, ${COLORS.panelBg}, transparent)` }}>›</span>
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
              onClick={scrollToBottom}
              className={`text-[11px] font-mono px-3 min-h-6 rounded-full motion-safe:transition-all ${FOCUS_RING}`}
              style={{ background: COLORS.holoBg10, border: `1px solid ${COLORS.glassBorder}`, color: COLORS.scrollBtnText }}
            >
              {newCount > 0 ? `↓ ${newCount} new message${newCount === 1 ? '' : 's'}` : '↓ Jump to latest'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Tab Button ──

function TabButton({ id, panelId, buttonRef, label, fullName, stateText, active, onClick, color, hasUnread }: {
  id: string
  panelId: string
  buttonRef: (el: HTMLButtonElement | null) => void
  label: string
  fullName: string
  stateText?: string
  active: boolean
  onClick: () => void
  color: string
  hasUnread?: boolean
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
        border: active ? `1px solid ${color}30` : '1px solid transparent',
      }}
    >
      {label}
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

function MessageRow({ message, agentName, showAgent, isSelected, onClick, runtime }: {
  message: ConversationMessage
  agentName: string
  showAgent: boolean
  isSelected: boolean
  onClick: () => void
  runtime?: Agent['runtime']
}) {
  const [expanded, setExpanded] = useState(false)
  const role = ROLE_COLORS[message.type] ?? ROLE_COLORS.assistant
  const roleLabel = message.type === 'assistant' && runtime === 'codex' ? 'CODEX' : role.label
  const truncated = truncateWithMarker(message.content, MESSAGE_TRUNCATE_MAX)
  const isLong = truncated.hidden > 0
  const displayText = expanded || !isLong ? message.content : truncated.text + truncated.marker
  const time = formatElapsed(message.timestamp)

  return (
    <div
      className="rounded px-2 py-1.5 motion-safe:transition-all"
      style={{
        background: isSelected ? role.bgSelected : role.bg,
        borderLeft: isSelected ? `2px solid ${role.text}` : '2px solid transparent',
      }}
    >
      <button
        type="button"
        aria-pressed={isSelected}
        onClick={onClick}
        title={showAgent ? `${agentName}: show this agent` : 'Show this agent'}
        className={`block w-full min-h-6 text-left rounded ${FOCUS_RING}`}
      >
        {/* Header row */}
        <span className="flex items-center gap-1.5 mb-0.5">
          <span className="text-[11px] font-mono font-semibold" style={{ color: role.text }}>
            {roleLabel}
          </span>
          {showAgent && (
            <span className="text-[11px] font-mono truncate" title={agentName} style={{ color: COLORS.textMuted }}>
              {agentName}
            </span>
          )}
          <time dateTime={time.iso} className="text-[11px] font-mono ml-auto shrink-0" style={{ color: COLORS.textMuted }}>
            {time.label}
          </time>
        </span>

        {/* Content */}
        <span
          className="block text-xs font-mono leading-relaxed whitespace-pre-wrap break-words"
          style={{ color: role.text }}
        >
          {displayText}
        </span>
      </button>

      {/* Expand/collapse for long messages */}
      {isLong && (
        <button
          type="button"
          aria-expanded={expanded}
          className={`text-[11px] font-mono mt-0.5 min-h-6 px-1 rounded motion-safe:transition-colors ${FOCUS_RING}`}
          style={{ color: COLORS.textMuted }}
          onClick={() => setExpanded(prev => !prev)}
        >
          {expanded ? '▴ Show less' : `▾ Show all (+${truncated.hidden} chars)`}
        </button>
      )}
    </div>
  )
}
