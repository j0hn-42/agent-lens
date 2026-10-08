'use client'

import { useState } from 'react'
import { COLORS, themed } from '@/lib/colors'
import { ToolContentRenderer } from './tool-content-renderer'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { truncateWithMarker, FOCUS_RING, COLLAPSED_TEXT_MAX, type CommKind } from '@/lib/feed-utils'
import { CheckIcon, GearIcon } from './feed-icons'

// ─── Message rendering utilities of the Conversation panel ───────────────────

/** Colors of the dispatch / return / teammate rows (text colors keep >= 4.5:1 on the dark panel). */
export const COMM_STYLE: Record<CommKind, { bg: string; bgSelected: string; text: string }> = themed(() => ({
  dispatch: { bg: COLORS.commDispatchBg, bgSelected: COLORS.commDispatchBgSelected, text: COLORS.commDispatchText },
  return: { bg: COLORS.commReturnBg, bgSelected: COLORS.commReturnBgSelected, text: COLORS.commReturnText },
  return_error: { bg: COLORS.commErrorBg, bgSelected: COLORS.commErrorBgSelected, text: COLORS.commErrorText },
  message: { bg: COLORS.commMessageBg, bgSelected: COLORS.commMessageBgSelected, text: COLORS.commMessageText },
}))

export function HighlightText({ text, query }: { text: string; query?: string }) {
  if (!query || !query.trim()) return <>{text}</>
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={i} style={{ background: COLORS.searchHighlightBg, color: 'inherit', borderRadius: 2, padding: '0 1px' }}>{part}</mark>
          : part
      )}
    </>
  )
}

/** Truncated text with a '… (+N chars)' marker and a 'Show all' toggle. */
function TruncatedText({ text, limit, query, color }: { text: string; limit: number; query?: string; color?: string }) {
  const [showAll, setShowAll] = useState(false)
  const t = truncateWithMarker(text, limit)
  return (
    <>
      <HighlightText text={showAll ? text : t.text} query={query} />
      {t.hidden > 0 && !showAll && <span style={{ color }}>{t.marker}</span>}
      {t.hidden > 0 && (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll(v => !v)}
          className={`block mt-0.5 min-h-6 px-1 rounded text-[11px] font-mono underline ${FOCUS_RING}`}
          style={{ color: COLORS.textMuted }}
        >
          {showAll ? 'Show less' : `Show all (+${t.hidden} chars)`}
        </button>
      )}
    </>
  )
}

/**
 * Tool activity rows of the Conversation panel (tool_call / tool_result). Conversation text, thinking and
 * agent-to-agent rows are rendered by the panel's own row component.
 */
export function TranscriptMessage({ message, searchQuery }: {
  message: ConversationMessage
  searchQuery?: string
}) {
  switch (message.type) {
    case 'tool_call':
      return (
        <div
          className="rounded px-2.5 py-1.5"
          style={{
            background: COLORS.toolCallBg,
            border: `1px solid ${COLORS.toolCallBorder}`,
          }}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <span aria-hidden="true" className="text-[11px]" style={{ color: COLORS.userLabel }}><GearIcon size={11} /></span>
            <span className="sr-only">Tool call:</span>
            <span className="text-[11px] font-mono font-semibold" style={{ color: COLORS.tool_calling }}>
              <HighlightText text={message.toolName || 'Tool'} query={searchQuery} />
            </span>
          </div>
          {message.inputData ? (
            <ToolContentRenderer
              toolName={message.toolName || ''}
              inputData={message.inputData}
              args={message.content}
              compact
            />
          ) : (
            <div className="text-xs font-mono" style={{ color: COLORS.contentDim }}>
              <HighlightText text={message.content} query={searchQuery} />
            </div>
          )}
        </div>
      )

    case 'tool_result': {
      const resultText = message.content.replace(/^< /, '')
      const isBash = message.toolName === 'Bash'
      const color = isBash ? COLORS.bashResultText : COLORS.toolResultText
      return (
        <div
          className="rounded px-2.5 py-1 text-xs font-mono"
          style={{
            background: isBash ? COLORS.bashResultBg : COLORS.toolResultBg,
            border: `1px solid ${isBash ? COLORS.bashResultBorder : COLORS.toolResultBorder}`,
            color,
          }}
        >
          <div className="flex items-center gap-1.5 mb-0.5">
            <span aria-hidden="true" className="text-[11px]">{isBash ? '$' : <CheckIcon size={11} />}</span>
            <span className="sr-only">Tool result:</span>
            {message.toolName && (
              <span className="text-[11px]">{message.toolName}</span>
            )}
          </div>
          <div className={isBash ? 'whitespace-pre-wrap leading-relaxed' : 'break-words'}>
            <TruncatedText text={resultText} limit={COLLAPSED_TEXT_MAX} query={searchQuery} color={COLORS.textMuted} />
          </div>
        </div>
      )
    }

    default:
      return (
        <div className="rounded px-2.5 py-1.5 text-xs font-mono" style={{ color: COLORS.textFaint }}>
          {message.content}
        </div>
      )
  }
}
