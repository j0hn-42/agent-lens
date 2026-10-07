'use client'

import { useRef, useEffect, useState, useId } from 'react'
import { Z, CARD } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { TranscriptMessage } from './transcript-message'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { CloseButton, SlidingPanel, stopPropagationHandlers } from './shared-ui'
import { useVirtualList } from '@/hooks/use-virtual-list'
import { EMPTY_MESSAGES, EMPTY_SEARCH, FOCUS_RING } from './feed-utils'

// ─── Constants ──────────────────────────────────────────────────────────────

const TRANSCRIPT_GAP = 8 // matches mb-2
const TRANSCRIPT_INITIAL_VIEWPORT = 400

// ─── Component ──────────────────────────────────────────────────────────────

interface TranscriptPanelProps {
  visible: boolean
  conversation: ConversationMessage[]
  runtime?: 'claude' | 'codex'
  onClose: () => void
}

export function SessionTranscriptPanel({
  visible,
  conversation,
  runtime,
  onClose,
}: TranscriptPanelProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchId = useId()

  useEffect(() => {
    if (showSearch) searchRef.current?.focus()
  }, [showSearch])

  const filteredConversation = visible
    ? (searchQuery.trim()
        ? conversation.filter(msg => {
            const q = searchQuery.toLowerCase()
            return msg.content.toLowerCase().includes(q)
              || (msg.toolName || '').toLowerCase().includes(q)
          })
        : conversation)
    : []

  const {
    visibleItems, handleScroll, measureRef: itemMeasureRef,
    isAtBottom, scrollToBottom, startIndex, listStyle, windowStyle, newCount,
  } = useVirtualList(filteredConversation, scrollRef, {
    gap: TRANSCRIPT_GAP,
    initialViewportHeight: TRANSCRIPT_INITIAL_VIEWPORT,
    autoScroll: true,
  })

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
              <span aria-hidden="true">/</span>
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
                if (e.key === 'Escape') { setShowSearch(false); setSearchQuery('') }
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

        {/* Virtualized message list */}
        <div
          ref={scrollRef}
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
                {searchQuery ? EMPTY_SEARCH : EMPTY_MESSAGES}
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
                    <TranscriptMessage message={msg} searchQuery={searchQuery} assistantLabel={runtime === 'codex' ? 'CODEX' : 'CLAUDE'} />
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
              onClick={scrollToBottom}
              className={`text-[11px] font-mono px-3 min-h-6 rounded-full motion-safe:transition-all ${FOCUS_RING}`}
              style={{
                background: COLORS.holoBg10,
                border: `1px solid ${COLORS.controlBorder}`,
                color: COLORS.scrollBtnText,
              }}
            >
              {newCount > 0 ? `↓ ${newCount} new message${newCount === 1 ? '' : 's'}` : '↓ Jump to latest'}
            </button>
          </div>
        )}
      </div>
    </SlidingPanel>
  )
}
