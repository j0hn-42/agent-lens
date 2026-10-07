'use client'

import { useRef, useEffect, useMemo, useState, useId } from 'react'
import { TimelineEntry, Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { formatDuration } from '@/lib/utils'
import {
  buildTimelineRows,
  computeTimelineRange,
  timelineAriaLabel,
  timelineBlockState,
  TIMELINE_STATE_LABELS,
  buildSwimlaneArrows,
  buildMessageRows,
  hitTestArrow,
  arrowGeometry,
  filterArrowsByPair,
  capMessageRows,
  orderEntriesBySequence,
  orderEntriesByStart,
  type SwimlaneArrow,
  type TimelineStateKey,
} from '@/lib/timeline-rows'
import type { AgentLink } from '@/hooks/simulation/types'
import { PanelHeader, SlidingPanel } from './shared-ui'
import { PairFilterChip } from './pair-filter-chip'
import { usePairFilter, clearPair } from '@/lib/pair-filter-store'
import { isPairComplete } from '@/lib/pair-filter'

interface TimelinePanelProps {
  visible: boolean
  timelineEntries: Map<string, TimelineEntry>
  currentTime: number
  onClose: () => void
  /** Communication links (optional): drawn as dispatch / return / peer arrows between rows */
  links?: Map<string, AgentLink>
}

/** Arrow colors; the dash pattern is a second, non-color channel (dispatch solid, return dashed, peer dotted). */
const ARROW_COLOR = { dispatch: '#7fb2ff', return: '#7fe3a3', error: '#ff8f8f', message: '#e0b0ff' } as const

function arrowColor(a: SwimlaneArrow): string {
  return a.isError ? ARROW_COLOR.error : ARROW_COLOR[a.kind]
}

// ─── Layout constants ────────────────────────────────────────────────────────

const ROW_HEIGHT = 24
const HEADER_HEIGHT = 22
const LABEL_WIDTH = 104
const FONT = '11px monospace'
const MAX_NAME_CHARS = 13
const SWIMLANE_LAYOUT = { labelWidth: LABEL_WIDTH, headerHeight: HEADER_HEIGHT, rowHeight: ROW_HEIGHT }
/** Opaque, >= 4.5:1 on the glass panel background (COLORS.textMuted is translucent). */
const TEXT_MUTED_OPAQUE = '#8fcfef'

/** Short glyphs so narrow blocks never rely on color alone. */
const STATE_GLYPH: Record<TimelineStateKey, string> = {
  idle: 'I',
  thinking: 'T',
  tool_call: 'C',
  waiting_permission: 'P',
  error: 'E',
  complete: 'D',
}

type PatternKind = 'none' | 'dots' | 'diagonal' | 'vertical' | 'cross' | 'horizontal'

/** Non-color channel: each state gets its own fill pattern. */
const STATE_PATTERN: Record<TimelineStateKey, PatternKind> = {
  idle: 'dots',
  thinking: 'none',
  tool_call: 'diagonal',
  waiting_permission: 'vertical',
  error: 'cross',
  complete: 'horizontal',
}

// ─── Legend (static DOM — no perf cost) ─────────────────────────────────────

const LEGEND_ITEMS: { state: TimelineStateKey; color: string }[] = [
  { state: 'idle', color: COLORS.idle },
  { state: 'thinking', color: COLORS.thinking },
  { state: 'tool_call', color: COLORS.tool },
  { state: 'waiting_permission', color: COLORS.waiting_permission },
  { state: 'error', color: COLORS.error },
  { state: 'complete', color: COLORS.complete },
]

function legendSwatchBackground(state: TimelineStateKey, color: string): string {
  const line = color
  switch (STATE_PATTERN[state]) {
    case 'diagonal': return `repeating-linear-gradient(45deg, ${line} 0 1px, transparent 1px 3px)`
    case 'vertical': return `repeating-linear-gradient(90deg, ${line} 0 1px, transparent 1px 3px)`
    case 'horizontal': return `repeating-linear-gradient(0deg, ${line} 0 1px, transparent 1px 3px)`
    case 'cross': return `repeating-linear-gradient(45deg, ${line} 0 1px, transparent 1px 3px), repeating-linear-gradient(-45deg, ${line} 0 1px, transparent 1px 3px)`
    case 'dots': return `radial-gradient(${line} 1px, transparent 1.2px) 0 0 / 4px 4px`
    default: return `${line}66`
  }
}

function drawPattern(ctx: CanvasRenderingContext2D, kind: PatternKind, x: number, y: number, w: number, h: number) {
  if (kind === 'none') return
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.lineWidth = 1
  ctx.beginPath()
  const step = 4
  if (kind === 'dots') {
    for (let px = x + 2; px < x + w; px += step) {
      for (let py = y + 2; py < y + h; py += step) ctx.rect(px, py, 1, 1)
    }
    ctx.fill()
  } else {
    if (kind === 'diagonal' || kind === 'cross') {
      for (let d = -h; d < w; d += step) { ctx.moveTo(x + d, y + h); ctx.lineTo(x + d + h, y) }
    }
    if (kind === 'cross') {
      for (let d = 0; d < w + h; d += step) { ctx.moveTo(x + d, y + h); ctx.lineTo(x + d - h, y) }
    }
    if (kind === 'vertical') {
      for (let px = x; px < x + w; px += step) { ctx.moveTo(px + 0.5, y); ctx.lineTo(px + 0.5, y + h) }
    }
    if (kind === 'horizontal') {
      for (let py = y; py < y + h; py += step) { ctx.moveTo(x, py + 0.5); ctx.lineTo(x + w, py + 0.5) }
    }
    ctx.stroke()
  }
  ctx.restore()
}

// ─── Canvas-based timeline rendering ────────────────────────────────────────

function drawTimeline(
  ctx: CanvasRenderingContext2D,
  entries: TimelineEntry[],
  currentTime: number,
  width: number,
  height: number,
  dpr: number,
  arrows: readonly SwimlaneArrow[] = [],
  hoveredArrowId?: string,
) {
  ctx.clearRect(0, 0, width * dpr, height * dpr)
  ctx.save()
  ctx.scale(dpr, dpr)

  if (entries.length === 0) {
    ctx.font = FONT
    ctx.fillStyle = TEXT_MUTED_OPAQUE
    ctx.textAlign = 'center'
    ctx.fillText('No timeline data', width / 2, height / 2)
    ctx.restore()
    return
  }

  const { minTime, maxTime } = computeTimelineRange(entries, currentTime)
  const timeSpan = Math.max(maxTime - minTime, 1)
  const barWidth = width - LABEL_WIDTH

  // Time markers
  const markerInterval = timeSpan > 60 ? 10 : timeSpan > 20 ? 5 : timeSpan > 10 ? 2 : 1
  const markers: number[] = []
  for (let t = Math.ceil(minTime / markerInterval) * markerInterval; t <= maxTime; t += markerInterval) {
    markers.push(t)
  }

  ctx.font = FONT

  // ── Header row: time labels ──
  ctx.textAlign = 'center'
  ctx.fillStyle = TEXT_MUTED_OPAQUE
  for (const t of markers) {
    const x = LABEL_WIDTH + ((t - minTime) / timeSpan) * barWidth
    ctx.fillText(formatDuration(t), x, HEADER_HEIGHT - 4)
  }

  // ── Agent rows ──
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const y = HEADER_HEIGHT + i * ROW_HEIGHT

    // Agent label
    ctx.textAlign = 'right'
    ctx.fillStyle = COLORS.textPrimary
    const name = entry.agentName.length > MAX_NAME_CHARS ? entry.agentName.slice(0, MAX_NAME_CHARS) + '..' : entry.agentName
    ctx.fillText(name, LABEL_WIDTH - 6, y + ROW_HEIGHT / 2 + 4)

    // Background track
    const trackY = y + 4
    const trackH = ROW_HEIGHT - 8
    ctx.fillStyle = COLORS.holoBg03
    ctx.fillRect(LABEL_WIDTH, trackY, barWidth, trackH)

    // Vertical marker lines
    ctx.fillStyle = COLORS.panelSeparator
    for (const t of markers) {
      const x = LABEL_WIDTH + ((t - minTime) / timeSpan) * barWidth
      ctx.fillRect(x, trackY, 1, trackH)
    }

    // Blocks
    for (const block of entry.blocks) {
      const blockStart = ((block.startTime - minTime) / timeSpan) * barWidth
      const blockEndTime = block.endTime ?? currentTime
      const blockEnd = ((blockEndTime - minTime) / timeSpan) * barWidth
      const blockW = Math.max(blockEnd - blockStart, 1)
      const x = LABEL_WIDTH + blockStart

      const state = timelineBlockState(block)

      // Block fill
      ctx.globalAlpha = 0.3
      ctx.fillStyle = block.color
      ctx.fillRect(x, trackY + 1, blockW, trackH - 2)

      // Block border
      ctx.globalAlpha = 0.6
      ctx.strokeStyle = block.color
      ctx.lineWidth = 1
      ctx.strokeRect(x, trackY + 1, blockW, trackH - 2)

      // Per-state pattern (second, non-color channel)
      ctx.globalAlpha = 0.45
      ctx.fillStyle = block.color
      ctx.strokeStyle = block.color
      drawPattern(ctx, STATE_PATTERN[state], x, trackY + 1, blockW, trackH - 2)

      ctx.globalAlpha = 1

      // Label inside block if wide enough, otherwise a one-letter state glyph
      if (blockW >= 12) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(x, trackY, blockW, trackH)
        ctx.clip()
        ctx.fillStyle = block.color
        ctx.textAlign = 'left'
        ctx.fillText(blockW > 40 ? block.label : STATE_GLYPH[state], x + (blockW > 40 ? 4 : 3), trackY + trackH / 2 + 4)
        ctx.restore()
      }
    }

    // Playhead
    const playheadX = LABEL_WIDTH + ((currentTime - minTime) / timeSpan) * barWidth
    ctx.fillStyle = COLORS.holoHot
    ctx.globalAlpha = 0.8
    ctx.fillRect(playheadX, trackY, 1, trackH)
    ctx.globalAlpha = 1
  }

  // ── Arrows between rows: parent -> child at dispatch, child -> parent at return, peers ──
  const byId = new Map(arrows.map(a => [a.id, a]))
  for (const g of arrowGeometry(arrows, minTime, maxTime, width, SWIMLANE_LAYOUT)) {
    const a = byId.get(g.id)!
    const hovered = g.id === hoveredArrowId
    ctx.strokeStyle = arrowColor(a)
    ctx.fillStyle = arrowColor(a)
    ctx.lineWidth = hovered ? 2.5 : 1.5
    ctx.setLineDash(a.kind === 'return' ? [4, 3] : a.kind === 'message' ? [1, 3] : [])
    ctx.beginPath()
    ctx.moveTo(g.x, g.y1)
    ctx.lineTo(g.x, g.y2)
    ctx.stroke()
    ctx.setLineDash([])
    const dir = g.y2 >= g.y1 ? 1 : -1
    ctx.beginPath()
    ctx.moveTo(g.x, g.y2)
    ctx.lineTo(g.x - 4, g.y2 - dir * 6)
    ctx.lineTo(g.x + 4, g.y2 - dir * 6)
    ctx.closePath()
    ctx.fill()
  }

  ctx.restore()
}

// ─── Component ──────────────────────────────────────────────────────────────

const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#aaeeff]'

export function TimelinePanel({ visible, timelineEntries, currentTime, onClose, links }: TimelinePanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [tableView, setTableView] = useState(false)
  const [hoveredName, setHoveredName] = useState<string | undefined>()
  const [sequence, setSequence] = useState(false)
  const [activeArrowId, setActiveArrowId] = useState<string | undefined>()
  const tableId = useId()
  const messagesTableId = useId()

  const sortedEntries = useMemo(() => {
    if (!visible) return []
    const all = Array.from(timelineEntries.values())
    return sequence ? orderEntriesBySequence(all, links) : orderEntriesByStart(all)
  }, [visible, timelineEntries, sequence, links])

  const rows = useMemo(() => buildTimelineRows(sortedEntries), [sortedEntries])
  const pair = usePairFilter()
  const nameById = useMemo(() => new Map(sortedEntries.map(e => [e.agentId, e.agentName])), [sortedEntries])
  const arrows = useMemo(() => {
    if (!visible || !links) return []
    const all = buildSwimlaneArrows(sortedEntries.map(e => e.agentId), links, id => nameById.get(id) ?? id)
    return isPairComplete(pair) ? filterArrowsByPair(all, pair.a, pair.b) : all
  }, [visible, links, sortedEntries, nameById, pair])
  const messageRows = useMemo(() => buildMessageRows(arrows), [arrows])
  const cappedButtons = useMemo(() => capMessageRows(messageRows), [messageRows])
  const activeArrow = arrows.find(a => a.id === activeArrowId)
  const ariaLabel = timelineAriaLabel(sortedEntries, currentTime)

  const canvasHeight = HEADER_HEIGHT + sortedEntries.length * ROW_HEIGHT

  // Focus moves into the panel on open and returns to the opener on close.
  // Escape is owned by the global LIFO handler (use-keyboard-shortcuts); no local listener.
  useEffect(() => {
    if (!visible) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    scrollRef.current?.focus({ preventScroll: true })
    return () => {
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true })
    }
  }, [visible])

  useEffect(() => {
    if (!visible || tableView) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Use the scroll container's clientWidth (excludes scrollbar) for a snug fit
    const scrollContainer = canvas.parentElement
    const width = scrollContainer?.clientWidth ?? canvas.clientWidth
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = canvasHeight * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${canvasHeight}px`

    drawTimeline(ctx, sortedEntries, currentTime, width, canvasHeight, dpr, arrows, activeArrowId)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- redraw on every prop change (component only re-renders on data/time updates)
  }, [visible, tableView, sortedEntries, currentTime, canvasHeight, arrows, activeArrowId])

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const idx = Math.floor((e.clientY - rect.top - HEADER_HEIGHT) / ROW_HEIGHT)
    const entry = x < LABEL_WIDTH ? sortedEntries[idx] : undefined
    setHoveredName(entry?.agentName)
    if (arrows.length > 0) {
      const { minTime, maxTime } = computeTimelineRange(sortedEntries, currentTime)
      const geo = arrowGeometry(arrows, minTime, maxTime, rect.width, SWIMLANE_LAYOUT)
      setActiveArrowId(hitTestArrow(geo, x, e.clientY - rect.top))
    }
  }

  if (!visible) return null

  return (
    <SlidingPanel
      visible={visible}
      position={{ bottom: 72, left: 16, right: 16 }}
      axis="Y"
      zIndex={Z.sidePanel}
      className="mx-auto motion-reduce:transition-none"
      style={{ maxWidth: 700 }}
    >
      <div className="glass-card relative" role="region" aria-label="Execution timeline">
        <PanelHeader
          onClose={onClose}
          actions={
            <div className="flex items-center gap-1">
            {links && (
              <button
                type="button"
                onClick={() => setSequence(v => !v)}
                aria-pressed={sequence}
                title="Order rows by first interaction"
                className={`min-h-6 min-w-6 px-2 rounded-sm text-[11px] font-mono ${FOCUS_RING}`}
                style={{ color: COLORS.textPrimary, border: `1px solid ${COLORS.holoBorder06}` }}
              >
                Sequence
              </button>
            )}
            <button
              type="button"
              onClick={() => setTableView(v => !v)}
              aria-pressed={tableView}
              aria-controls={tableId}
              className={`min-h-6 min-w-6 px-2 rounded-sm text-[11px] font-mono ${FOCUS_RING}`}
              style={{ color: COLORS.textPrimary, border: `1px solid ${COLORS.holoBorder06}` }}
            >
              Table view
            </button>
            </div>
          }
        >
          <span className="text-[11px] font-mono tracking-wider" style={{ color: COLORS.textPrimary }}>
            EXECUTION TIMELINE
          </span>
        </PanelHeader>

        <div
          ref={scrollRef}
          tabIndex={0}
          role="group"
          aria-label="Timeline scroll area"
          className={`overflow-auto ${FOCUS_RING}`}
          style={{ maxHeight: 300 }}
        >
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={ariaLabel}
            title={hoveredName}
            hidden={tableView}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => { setHoveredName(undefined); setActiveArrowId(undefined) }}
            style={{ display: tableView ? 'none' : 'block' }}
          >
            {ariaLabel}. Open the table view for the list of agents, states, start and end times.
          </canvas>

          <table
            id={tableId}
            className={tableView ? 'w-full text-xs font-mono border-collapse' : 'sr-only'}
            style={tableView ? { color: COLORS.textPrimary } : undefined}
          >
            <caption className="sr-only">{ariaLabel}</caption>
            <thead>
              <tr style={{ color: TEXT_MUTED_OPAQUE }}>
                <th scope="col" className="text-left px-2 py-1 font-normal">Agent</th>
                <th scope="col" className="text-left px-2 py-1 font-normal">State</th>
                <th scope="col" className="text-left px-2 py-1 font-normal">Start</th>
                <th scope="col" className="text-left px-2 py-1 font-normal">End</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={4} className="px-2 py-1">No timeline data</td></tr>
              )}
              {rows.map((r, i) => (
                <tr key={`${r.agentId}-${i}`} style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
                  <th scope="row" className="text-left px-2 py-1 font-normal break-all">{r.agentName}</th>
                  <td className="px-2 py-1">{r.stateLabel}{r.detail && r.detail !== r.stateLabel ? ` (${r.detail})` : ''}</td>
                  <td className="px-2 py-1">{r.start}</td>
                  <td className="px-2 py-1">{r.end}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {messageRows.length > 0 && tableView && (
            <table id={messagesTableId} className="w-full text-xs font-mono border-collapse mt-2" style={{ color: COLORS.textPrimary }}>
              <caption className="text-left px-2 py-1" style={{ color: TEXT_MUTED_OPAQUE }}>Messages between agents</caption>
              <thead>
                <tr style={{ color: TEXT_MUTED_OPAQUE }}>
                  <th scope="col" className="text-left px-2 py-1 font-normal">Time</th>
                  <th scope="col" className="text-left px-2 py-1 font-normal">Kind</th>
                  <th scope="col" className="text-left px-2 py-1 font-normal">From</th>
                  <th scope="col" className="text-left px-2 py-1 font-normal">To</th>
                  <th scope="col" className="text-left px-2 py-1 font-normal">Content</th>
                </tr>
              </thead>
              <tbody>
                {messageRows.map(r => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
                    <td className="px-2 py-1 whitespace-nowrap">{r.start}</td>
                    <th scope="row" className="text-left px-2 py-1 font-normal break-words">{r.kindLabel}</th>
                    <td className="px-2 py-1 break-words">{r.from}</td>
                    <td className="px-2 py-1 break-words">{r.to}</td>
                    <td className="px-2 py-1 break-words whitespace-pre-wrap">{r.content.slice(0, 300)}{r.content.length > 300 ? '…' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {isPairComplete(pair) && (
          <div className="px-3 py-1.5" style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
            <PairFilterChip pair={pair} nameOf={id => nameById.get(id) ?? id} count={arrows.length} onClear={clearPair} />
          </div>
        )}

        {/* Messages between rows: hover or focus an entry to read it (canvas arrows have no focus of their own) */}
        {!tableView && messageRows.length > 0 && (
          <div className="px-3 py-1.5" style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
            <div
              role="group"
              aria-label="Messages between agents"
              className="flex flex-wrap gap-1 overflow-auto"
              style={{ maxHeight: 56 }}
            >
              {cappedButtons.rows.map(r => (
                <button
                  key={r.id}
                  type="button"
                  onMouseEnter={() => setActiveArrowId(r.id)}
                  onMouseLeave={() => setActiveArrowId(undefined)}
                  onFocus={() => setActiveArrowId(r.id)}
                  onBlur={() => setActiveArrowId(undefined)}
                  className={`min-h-6 px-1.5 rounded-sm text-[11px] font-mono ${FOCUS_RING}`}
                  style={{ color: TEXT_MUTED_OPAQUE, border: `1px solid ${COLORS.holoBorder06}` }}
                >
                  {r.start} {r.label}
                </button>
              ))}
              {cappedButtons.hidden > 0 && (
                <span className="text-[11px] font-mono self-center" style={{ color: TEXT_MUTED_OPAQUE }}>
                  +{cappedButtons.hidden} earlier messages, see Table view
                </span>
              )}
            </div>
            <div role="status" className="text-[11px] font-mono mt-1 whitespace-pre-wrap break-words" style={{ color: COLORS.textPrimary, maxHeight: 64, overflow: 'auto' }}>
              {activeArrow ? `${activeArrow.label}: ${activeArrow.content.slice(0, 400)}${activeArrow.content.length > 400 ? '…' : ''}` : ''}
            </div>
          </div>
        )}

        {/* Legend (static DOM) */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5" style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
          {LEGEND_ITEMS.map(item => (
            <div key={item.state} className="flex items-center gap-1">
              <div
                className="w-3 h-3 rounded-sm"
                aria-hidden="true"
                style={{ background: legendSwatchBackground(item.state, item.color), border: `1px solid ${item.color}` }}
              />
              <span className="text-[11px] font-mono" style={{ color: TEXT_MUTED_OPAQUE }}>
                {TIMELINE_STATE_LABELS[item.state]}
              </span>
            </div>
          ))}
        </div>
      </div>
    </SlidingPanel>
  )
}
