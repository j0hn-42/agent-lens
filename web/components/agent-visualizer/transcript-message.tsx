'use client'

import { useState, useId } from 'react'
import { COLORS } from '@/lib/colors'
import { ToolContentRenderer } from './tool-content-renderer'
import type { ConversationMessage } from '@/hooks/simulation/types'
import { truncateWithMarker, FOCUS_RING, commKindOf, COMM_LABELS, type CommKind } from '@/lib/feed-utils'
import { ChevronIcon, CheckIcon, GearIcon } from './feed-icons'

// ─── Shared message rendering utilities ──────────────────────────────────────

/** Colors of the dispatch / return / teammate rows (text colors keep >= 4.5:1 on the dark panel). */
export const COMM_STYLE: Record<CommKind, { bg: string; bgSelected: string; text: string }> = {
  dispatch: { bg: 'rgba(80,140,255,0.14)', bgSelected: 'rgba(80,140,255,0.26)', text: '#9cc4ff' },
  return: { bg: 'rgba(60,200,120,0.12)', bgSelected: 'rgba(60,200,120,0.24)', text: '#7fe3a3' },
  return_error: { bg: 'rgba(255,90,90,0.14)', bgSelected: 'rgba(255,90,90,0.26)', text: '#ff9b9b' },
  message: { bg: 'rgba(200,150,255,0.12)', bgSelected: 'rgba(200,150,255,0.24)', text: '#e0b0ff' },
}

/** Full prompts and reports are long: show a preview with a 'Show all' toggle. */
const COMM_PREVIEW_MAX = 400

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

export function TranscriptMessage({ message, compact = false, searchQuery, assistantLabel = 'CLAUDE', fromName, toName, accent, onFilterPair }: {
  message: ConversationMessage
  compact?: boolean
  searchQuery?: string
  assistantLabel?: string
  /** dispatch / return / message: display names of the sending and receiving agent */
  fromName?: string
  toName?: string
  /** Validated '#rrggbb' team color */
  accent?: string
  /** Communication rows: filter the transcript and the feed on this pair of agents */
  onFilterPair?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const thinkingId = useId()

  switch (message.type) {
    case 'dispatch':
    case 'return':
    case 'message': {
      const kind = commKindOf(message)!
      const style = COMM_STYLE[kind]
      const from = fromName ?? message.from ?? 'agent'
      const to = toName ?? message.to ?? 'agent'
      return (
        <div
          className="rounded px-2.5 py-2 text-xs font-mono leading-relaxed"
          style={{ background: style.bg, border: `1px solid ${style.text}40`, borderLeft: `3px solid ${accent ?? style.text}` }}
        >
          <div className="text-[11px] mb-1 font-semibold tracking-wider break-words" style={{ color: style.text }}>
            {from}<span aria-hidden="true"> {'\u2192'} </span><span className="sr-only"> to </span>{to}
            <span aria-hidden="true"> - </span><span className="sr-only">, </span>{COMM_LABELS[kind]}
          </div>
          <div style={{ color: style.text }} className="whitespace-pre-wrap break-words">
            <TruncatedText text={message.content} limit={compact ? 200 : COMM_PREVIEW_MAX} query={searchQuery} color={COLORS.textMuted} />
          </div>
          {onFilterPair && (
            <button
              type="button"
              aria-label={`Filter pair ${from} and ${to}`}
              onClick={onFilterPair}
              className={`mt-0.5 min-h-6 px-1 rounded text-[11px] font-mono underline ${FOCUS_RING}`}
              style={{ color: COLORS.textMuted }}
            >
              Filter pair
            </button>
          )}
        </div>
      )
    }

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
            aria-controls={thinkingId}
            onClick={() => setExpanded(!expanded)}
            title={expanded ? 'Collapse thinking' : message.content.slice(0, 200)}
            className={`flex items-center gap-1.5 w-full min-h-6 text-left rounded ${FOCUS_RING}`}
          >
            <span className="text-[11px] font-semibold tracking-wider" style={{ color: COLORS.thinkingLabel }}>THINKING</span>
            <span aria-hidden="true" className="text-[11px]" style={{ color: COLORS.thinkingArrow }}><ChevronIcon direction={expanded ? 'down' : 'right'} size={10} /></span>
            {!expanded && (
              <span className="text-[11px] font-mono truncate" style={{ color: COLORS.thinkingPreview }}>
                {preview.text}{preview.hidden > 0 ? preview.marker : ''}
              </span>
            )}
          </button>
          {expanded && (
            <div
              id={thinkingId}
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
            <span aria-hidden="true" className="text-[11px]" style={{ color: COLORS.userLabel }}><GearIcon size={11} /></span>
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
            <span aria-hidden="true" className="text-[11px]">{isBash ? '$' : <CheckIcon size={11} />}</span>
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
