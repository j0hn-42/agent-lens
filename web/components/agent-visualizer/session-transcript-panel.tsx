'use client'

import { useRef, useEffect, useState, useId } from 'react'
import { Z, CARD, type Agent, type TeamSummary } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { TranscriptMessage } from './transcript-message'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { CloseButton, SlidingPanel, stopPropagationHandlers } from './shared-ui'
import { useVirtualList } from '@/hooks/use-virtual-list'
import { pairOfMessage as pairOf, EMPTY_MESSAGES, EMPTY_SEARCH, FOCUS_RING, agentNameOf, teamColorOf, groupByTeam } from '@/lib/feed-utils'
import { SearchIcon, ArrowDownIcon } from './feed-icons'
import { PairFilterChip } from './pair-filter-chip'
import { usePairFilter, setPair, clearPair } from '@/lib/pair-filter-store'
import { applyPair, isPairComplete, isPairSet, pairEmptyText } from '@/lib/pair-filter'

// ─── Constants ──────────────────────────────────────────────────────────────

const TRANSCRIPT_GAP = 8 // matches mb-2
const TRANSCRIPT_INITIAL_VIEWPORT = 400

// ─── Component ──────────────────────────────────────────────────────────────

interface TranscriptPanelProps {
  visible: boolean
  conversation: ConversationMessage[]
  runtime?: 'claude' | 'codex'
  onClose: () => void
  /** Agents by key (optional): resolves display names for dispatch / return / teammate rows */
  agents?: Map<string, Agent>
  /** Agent Teams (optional): teammates are listed under their team heading */
  teams?: Map<string, TeamSummary>
}

export function SessionTranscriptPanel({
  visible,
  conversation,
  runtime,
  onClose,
  agents,
  teams,
}: TranscriptPanelProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const logId = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchId = useId()

  useEffect(() => {
    if (showSearch) searchRef.current?.focus()
  }, [showSearch])

  // Shared with the message feed: only the dispatch / return / peer messages between the two agents
  const pair = usePairFilter()
  const pairActive = isPairComplete(pair)
  const nameOf = (key: string) => (agents ? agentNameOf(agents, key) : key)

  const pairFiltered = visible ? (pairActive ? applyPair(conversation, pair) : conversation) : []
  const filteredConversation = visible
    ? (searchQuery.trim()
        ? pairFiltered.filter(msg => {
            const q = searchQuery.toLowerCase()
            return msg.content.toLowerCase().includes(q)
              || (msg.toolName || '').toLowerCase().includes(q)
          })
        : pairFiltered)
    : []

  const {
    visibleItems, handleScroll, measureRef: itemMeasureRef,
    isAtBottom, scrollToBottom, startIndex, listStyle, windowStyle, newCount,
  } = useVirtualList(filteredConversation, scrollRef, {
    gap: TRANSCRIPT_GAP,
    initialViewportHeight: TRANSCRIPT_INITIAL_VIEWPORT,
    autoScroll: true,
  })

  const teamGroups = (teams && teams.size > 0 && agents)
    ? groupByTeam([...agents.values()].filter(a => a.teamName)).filter(g => g.team !== null)
    : []

  if (!visible) return null

  return (
    <SlidingPanel
      visible={visible}
      position={{ right: 0, bottom: 0, top: 36 }}
      zIndex={Z.transcriptPanel}
      width={CARD.transcript.width}
      {...stopPropagationHandlers}
    >
      <div
        className="h-full flex flex-col"
        style={{
          background: COLORS.panelBg,
          backdropFilter: 'blur(24px)',
          borderLeft: `1px solid ${COLORS.holoBorder10}`,
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-2.5 flex-shrink-0"
          style={{ borderBottom: `1px solid ${COLORS.holoBorder08}` }}
        >
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono tracking-widest font-semibold" style={{ color: COLORS.panelLabel }}>
              TRANSCRIPT
            </span>
            <span className="text-[11px] font-mono" style={{ color: COLORS.panelLabelDim }}>
              {searchQuery ? `${filteredConversation.length}/${conversation.length}` : conversation.length} messages
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              ref={toggleRef}
              type="button"
              onClick={() => { setShowSearch(s => !s); if (showSearch) setSearchQuery('') }}
              aria-label="Filter messages"
              aria-expanded={showSearch}
              aria-controls={searchId}
              title="Filter messages"
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
          <div id={searchId} className="px-3 pb-2 flex-shrink-0" style={{ borderBottom: `1px solid ${COLORS.holoBorder06}` }}>
            <input
              ref={searchRef}
              type="search"
              aria-label="Filter messages"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(''); toggleRef.current?.focus() }
                e.stopPropagation()
              }}
              placeholder="Filter messages..."
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

        {/* Pair filter chip (shared with the message feed) */}
        {(isPairSet(pair) || (agents && agents.size > 1)) && (
          <div className="px-3 py-1 flex flex-wrap items-center gap-1 flex-shrink-0" style={{ borderBottom: `1px solid ${COLORS.holoBorder06}` }}>
            {agents && agents.size > 1 && (
              <PairPicker agents={agents} pair={pair} />
            )}
            <PairFilterChip pair={pair} nameOf={nameOf} count={filteredConversation.length} onClear={clearPair} />
          </div>
        )}

        {/* Teammates grouped under their team heading */}
        {teamGroups.length > 0 && (
          <section
            aria-label="Teams"
            className="px-3 py-1.5 flex-shrink-0"
            style={{ borderBottom: `1px solid ${COLORS.holoBorder06}` }}
          >
            {teamGroups.map(g => (
              <div key={g.team}>
                <h3 className="text-[11px] font-mono font-semibold tracking-wider" style={{ color: COLORS.panelLabel }}>
                  {g.team}
                </h3>
                <ul className="flex flex-wrap gap-x-2 gap-y-0.5 pb-1">
                  {g.items.map(a => (
                    <li key={a.id} className="text-[11px] font-mono flex items-center gap-1" style={{ color: COLORS.textMuted }}>
                      <span
                        aria-hidden="true"
                        className="inline-block w-2 h-2 rounded-full"
                        style={{ background: teamColorOf(a, teams) ?? COLORS.textMuted }}
                      />
                      {a.name}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}

        {/* Virtualized message list */}
        <div
          ref={scrollRef}
          id={logId}
          onScroll={handleScroll}
          role="log"
          aria-live="off"
          aria-label="Session transcript"
          tabIndex={0}
          className={`flex-1 overflow-y-auto px-3 py-2 ${FOCUS_RING}`}
          style={{ scrollbarWidth: 'thin', scrollbarColor: `${COLORS.scrollbarThumb} transparent` }}
        >
          {filteredConversation.length === 0 ? (
            <div className="flex items-center justify-center h-32">
              <p className="text-xs font-mono" style={{ color: COLORS.textMuted }}>
                {searchQuery ? EMPTY_SEARCH : pairActive ? pairEmptyText(pair, nameOf) : EMPTY_MESSAGES}
              </p>
            </div>
          ) : (
            <div style={listStyle}>
              <div role="list" aria-label="Transcript messages" style={windowStyle}>
                {visibleItems.map((msg, i) => (
                  <div
                    key={msg.id}
                    role="listitem"
                    aria-setsize={filteredConversation.length}
                    aria-posinset={startIndex + i + 1}
                    ref={(el) => itemMeasureRef(msg.id, el)}
                    style={{ marginBottom: TRANSCRIPT_GAP }}
                  >
                    <TranscriptMessage
                      message={msg}
                      searchQuery={searchQuery}
                      assistantLabel={runtime === 'codex' ? 'CODEX' : 'CLAUDE'}
                      fromName={agents && msg.from ? agentNameOf(agents, msg.from) : undefined}
                      toName={agents && msg.to ? agentNameOf(agents, msg.to) : undefined}
                      onFilterPair={pairOf(msg) ? () => { const p = pairOf(msg)!; setPair(p[0], p[1]) } : undefined}
                      accent={agents ? teamColorOf(agents.get(msg.from ?? ''), teams) : undefined}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Scroll-to-bottom button */}
        {!isAtBottom && filteredConversation.length > 0 && (
          <div className="flex justify-center py-1 flex-shrink-0" style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
            <button
              type="button"
              aria-controls={logId}
              onClick={scrollToBottom}
              className={`text-[11px] font-mono px-3 min-h-6 rounded-full motion-safe:transition-all ${FOCUS_RING}`}
              style={{
                background: COLORS.holoBg10,
                border: `1px solid ${COLORS.controlBorder}`,
                color: COLORS.scrollBtnText,
              }}
            >
              <ArrowDownIcon size={11} className="mr-1 align-[-1px]" />
              {newCount > 0 ? `${newCount} new message${newCount === 1 ? '' : 's'}` : 'Jump to latest'}
            </button>
          </div>
        )}
      </div>
    </SlidingPanel>
  )
}

/** Keyboard path to the Pair filter: two native selects (Shift-click has no keyboard equivalent). */
function PairPicker({ agents, pair }: { agents: Map<string, Agent>; pair: { a: string; b: string } }) {
  const ids = [...agents.keys()]
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="text-[11px] font-mono" style={{ color: COLORS.textMuted }}>Filter pair</span>
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
          {ids.map(id => <option key={id} value={id}>{agentNameOf(agents, id)}</option>)}
        </select>
      ))}
    </span>
  )
}
