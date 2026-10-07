'use client'

import { CARD, Z, type AgentState } from '@/lib/agent-types'
import { COLORS, getStateColor } from '@/lib/colors'
import { TranscriptMessage } from './transcript-message'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { PanelHeader, SlidingPanel } from './shared-ui'
import { useEffect, useId, useState } from 'react'
import { getStateLabel } from '@/lib/state-labels'
import { useAutoScroll } from '@/hooks/use-auto-scroll'

interface ChatPanelProps {
  visible: boolean
  agentName: string
  agentState: AgentState
  conversation: ConversationMessage[]
  runtime?: 'claude' | 'codex'
  onClose: () => void
}

export function AgentChatPanel({
  visible,
  agentName,
  agentState,
  conversation,
  runtime,
  onClose,
}: ChatPanelProps) {
  const { ref: logRef, handleScroll, scrollToBottom, isAutoScrolling } = useAutoScroll(conversation.length, visible)

  const stateColor = getStateColor(agentState)
  const titleId = useId()
  // Number of messages the user has already seen (everything when pinned to the bottom)
  const [seenCount, setSeenCount] = useState(conversation.length)
  const unseen = Math.max(0, conversation.length - seenCount)

  useEffect(() => {
    if (isAutoScrolling.current) setSeenCount(conversation.length)
  }, [conversation.length, isAutoScrolling])

  const onScroll = () => {
    handleScroll()
    if (isAutoScrolling.current) setSeenCount(conversation.length)
  }
  const newMessagesText = `${unseen} new ${unseen === 1 ? 'message' : 'messages'}`

  return (
    <SlidingPanel
      visible={visible}
      position={{ bottom: 64, right: 12 }}
      zIndex={Z.chatPanel}
      width={CARD.chat.width}
      labelledBy={titleId}
    >
      <div className="glass-card" data-companion-panel style={{ display: 'flex', flexDirection: 'column', maxHeight: CARD.chat.maxHeight }}>
        <PanelHeader onClose={onClose} className="mb-2 flex-shrink-0" titleId={titleId}>
          <span
            aria-hidden="true"
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: stateColor, boxShadow: `0 0 6px ${stateColor}` }}
          />
          <span className="text-[11px] font-mono tracking-wider uppercase" style={{ color: COLORS.textPrimary }}>
            {agentName}
          </span>
          <span className="text-[11px] font-mono" style={{ color: stateColor }}>
            {getStateLabel(agentState)}
          </span>
        </PanelHeader>

        {/* Messages */}
        <div
          ref={logRef}
          role="log"
          aria-label={`Conversation with ${agentName}`}
          aria-live="off"
          tabIndex={0}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto space-y-1.5 mb-2"
          style={{ minHeight: CARD.chat.messagesMinHeight, maxHeight: CARD.chat.messagesMaxHeight }}
        >
          {conversation.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-[11px] font-mono" style={{ color: COLORS.textMuted }}>
                No messages yet...
              </p>
            </div>
          ) : (
            conversation.map((msg) => (
              <TranscriptMessage key={msg.id} message={msg} assistantLabel={runtime === 'codex' ? 'CODEX' : 'CLAUDE'} />
            ))
          )}
        </div>

        {/* Polite status line announces the count only, instead of every message */}
        <div role="status" className="sr-only">{unseen > 0 ? newMessagesText : ''}</div>

        {unseen > 0 && (
          <div className="flex justify-center pb-1 flex-shrink-0">
            <button
              type="button"
              onClick={() => { scrollToBottom(); setSeenCount(conversation.length) }}
              className="min-h-6 text-[11px] font-mono px-3 py-1 rounded-full transition-all motion-reduce:transition-none"
              style={{
                background: COLORS.holoBg10,
                border: `1px solid ${COLORS.controlBorder}`,
                color: COLORS.scrollBtnText,
              }}
            >
              <span aria-hidden="true">↓ </span>{newMessagesText}
            </button>
          </div>
        )}
      </div>
    </SlidingPanel>
  )
}
