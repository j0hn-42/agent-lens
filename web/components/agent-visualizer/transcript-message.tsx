'use client'

import { useState } from 'react'
import { COLORS } from '@/lib/colors'
import { ToolContentRenderer } from './tool-content-renderer'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { truncateWithMarker, FOCUS_RING } from './feed-utils'

// ─── Shared message rendering utilities ──────────────────────────────────────

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
          {showAll ? 'Show less' : 'Show all'}
        </button>
      )}
    </>
  )
}

export function TranscriptMessage({ message, compact = false, searchQuery, assistantLabel = 'CLAUDE' }: { message: ConversationMessage; compact?: boolean; searchQuery?: string; assistantLabel?: string }) {
  const [expanded, setExpanded] = useState(false)

  switch (message.type) {
    case 'user':
      return (
        <div
          className="rounded px-2.5 py-2 text-xs font-mono leading-relaxed"
          style={{
            background: COLORS.userMsgBg,
            border: `1px solid ${COLORS.userMsgBorder}`,
          }}
        >
          <div className="text-[11px] mb-1 font-semibold tracking-wider" style={{ color: COLORS.userLabel }}>USER</div>
          <div style={{ color: COLORS.userText }} className="whitespace-pre-wrap break-words">
            <HighlightText text={message.content} query={searchQuery} />
          </div>
        </div>
      )

    case 'assistant':
      return (
        <div
          className="rounded px-2.5 py-2 text-xs font-mono leading-relaxed"
          style={{
            background: COLORS.panelSeparator,
            border: `1px solid ${COLORS.holoBorder08}`,
          }}
        >
          <div className="text-[11px] mb-1 font-semibold tracking-wider" style={{ color: COLORS.assistantLabel }}>{assistantLabel}</div>
          <div style={{ color: COLORS.assistantText }} className="whitespace-pre-wrap break-words">
            {compact
              ? <TruncatedText text={message.content} limit={200} query={searchQuery} color={COLORS.textMuted} />
              : <HighlightText text={message.content} query={searchQuery} />}
          </div>
        </div>
      )

    case 'thinking': {
      const preview = truncateWithMarker(message.content, 60)
      return (
        <div
          className="rounded px-2.5 py-1.5 motion-safe:transition-all"
          style={{
            background: expanded ? COLORS.thinkingBgExpanded : COLORS.thinkingBgCollapsed,
            border: `1px solid ${COLORS.thinkingBorder}`,
          }}
        >
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            title={expanded ? 'Collapse thinking' : message.content.slice(0, 200)}
            className={`flex items-center gap-1.5 w-full min-h-6 text-left rounded ${FOCUS_RING}`}
          >
            <span className="text-[11px] font-semibold tracking-wider" style={{ color: COLORS.thinkingLabel }}>THINKING</span>
            <span aria-hidden="true" className="text-[11px]" style={{ color: COLORS.thinkingArrow }}>{expanded ? '▾' : '▸'}</span>
            {!expanded && (
              <span className="text-[11px] font-mono truncate" style={{ color: COLORS.thinkingPreview }}>
                {preview.text}{preview.hidden > 0 ? preview.marker : ''}
              </span>
            )}
          </button>
          {expanded && (
            <div
              className="mt-1.5 text-xs font-mono leading-relaxed whitespace-pre-wrap break-words"
              style={{ color: COLORS.thinkingTextExpanded, borderLeft: `2px solid ${COLORS.thinkingBorderLeft}`, paddingLeft: 8 }}
            >
              {compact
                ? <TruncatedText text={message.content} limit={500} color={COLORS.thinkingTextExpanded} />
                : message.content}
            </div>
          )}
        </div>
      )
    }

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
            <span aria-hidden="true" className="text-[11px]" style={{ color: COLORS.userLabel }}>⚙</span>
            <span className="sr-only">Tool call:</span>
            <span className="text-[11px] font-mono font-semibold" style={{ color: COLORS.tool_calling }}>
              {message.toolName || 'Tool'}
            </span>
          </div>
          {message.inputData ? (
            <ToolContentRenderer
              toolName={message.toolName || ''}
              inputData={message.inputData}
              args={message.content}
              compact={compact}
            />
          ) : (
            <div className="text-xs font-mono" style={{ color: COLORS.contentDim }}>
              {message.content}
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
            <span aria-hidden="true" className="text-[11px]">{isBash ? '$' : '✓'}</span>
            <span className="sr-only">Tool result:</span>
            {message.toolName && (
              <span className="text-[11px]">{message.toolName}</span>
            )}
          </div>
          <div className={isBash ? 'whitespace-pre-wrap leading-relaxed' : 'break-words'}>
            <TruncatedText text={resultText} limit={compact ? 80 : 400} query={searchQuery} color={COLORS.textMuted} />
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
