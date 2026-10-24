'use client'

import { useLocale } from '@/lib/locale'
import { translate, type Locale } from '@/lib/messages'
import { DATA_EN } from '@/lib/panel-text'
import { stateLabelText, stateGlyphText, arrowKindText, arrowLabelText, timelineLabelText, earlierMessagesText, olderBlocksText, totalDroppedBlocks, blockLabelParts, type LabelPart } from '@/lib/timeline-text'
import { panelName } from '@/lib/command-palette'
import { useRef, useEffect, useMemo, useState, useId } from 'react'
import { TimelineEntry, Z } from '@/lib/agent-types'
import { COLORS, uiColor } from '@/lib/colors'
import { truncateName } from '@/lib/truncate-name'
import { formatDuration } from '@/lib/utils'
import {
  buildTimelineRows,
  computeTimelineRange,
  timelineMarkers,
  timelineBlockState,
  buildSwimlaneArrows,
  buildMessageRows,
  hitTestArrow,
  arrowGeometry,
  filterArrowsByPair,
  capMessageRows,
  orderEntriesBySequence,
  orderEntriesByStart,
  visibleRowRange,
  type SwimlaneArrow,
  type TimelineStateKey,
} from '@/lib/timeline-rows'
import type { AgentLink } from '@/hooks/simulation/types'
import { PanelHeader, SlidingPanel, useDockPanel, dockAttrs } from './shared-ui'
import { PairFilterChip } from './pair-filter-chip'
import { usePairFilter, clearPair } from '@/lib/pair-filter-store'
import { isPairComplete } from '@/lib/pair-filter'
import { FOCUS_RING } from '@/lib/focus-ring'
import { withHexAlpha } from '@/lib/color-alpha'

interface TimelinePanelProps {
  visible: boolean
  timelineEntries: Map<string, TimelineEntry>
  currentTime: number
  onClose: () => void
  /** Communication links (optional): drawn as dispatch / return / peer arrows between rows */
  links?: Map<string, AgentLink>
}

/** Arrow colors; the dash pattern is a second, non-color channel (dispatch solid, return dashed, peer dotted). */
function arrowColor(a: SwimlaneArrow): string {
  if (a.isError) return COLORS.swimlaneError
  switch (a.kind) {
    case 'dispatch': return COLORS.swimlaneDispatch
    case 'return': return COLORS.swimlaneReturn
    default: return COLORS.swimlaneMessage
  }
}

// ─── Layout constants ────────────────────────────────────────────────────────

const ROW_HEIGHT = 24
const HEADER_HEIGHT = 22
const LABEL_WIDTH = 104
const FONT = '11px monospace'
const MAX_NAME_CHARS = 13
const SWIMLANE_LAYOUT = { labelWidth: LABEL_WIDTH, headerHeight: HEADER_HEIGHT, rowHeight: ROW_HEIGHT }

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

const legendItems = (): { state: TimelineStateKey; color: string }[] => [
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
    default: return `${withHexAlpha(line, '66')}`
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
  locale: Locale = 'en',
  /** Rows to draw (#659): the canvas keeps its full height, the rows out of the scroll viewport are skipped. */
  rowRange?: { first: number; last: number },
) {
  ctx.clearRect(0, 0, width * dpr, height * dpr)
  ctx.save()
  ctx.scale(dpr, dpr)

  if (entries.length === 0) {
    ctx.font = FONT
    ctx.fillStyle = COLORS.textMutedOpaque
    ctx.textAlign = 'center'
    ctx.fillText(translate(locale, 'tl.empty'), width / 2, height / 2)
    ctx.restore()
    return
  }

  const { minTime, maxTime } = computeTimelineRange(entries, currentTime)
  const timeSpan = Math.max(maxTime - minTime, 1)
  const barWidth = width - LABEL_WIDTH

  ctx.font = FONT

  // Time markers: spaced for the widest label at this width, none cut by the edge (#378)
  const markers = timelineMarkers(minTime, maxTime, LABEL_WIDTH, barWidth, ctx.measureText(formatDuration(maxTime)).width, width)

  // ── Header row: time labels ──
  ctx.textAlign = 'center'
  ctx.fillStyle = COLORS.textMutedOpaque
  for (const m of markers) {
    if (m.labelled) ctx.fillText(formatDuration(m.t), m.labelX, HEADER_HEIGHT - 4)
  }

  // ── Agent rows ──
  const firstRow = rowRange ? Math.max(0, rowRange.first) : 0
  const lastRow = rowRange ? Math.min(entries.length - 1, rowRange.last) : entries.length - 1
  for (let i = firstRow; i <= lastRow; i++) {
    const entry = entries[i]
    const y = HEADER_HEIGHT + i * ROW_HEIGHT

    // Agent label
    ctx.textAlign = 'right'
    ctx.fillStyle = COLORS.textPrimary
    const name = truncateName(entry.agentName, MAX_NAME_CHARS)
    ctx.fillText(name, LABEL_WIDTH - 6, y + ROW_HEIGHT / 2 + 4)

    // Background track
    const trackY = y + 4
    const trackH = ROW_HEIGHT - 8
    ctx.fillStyle = COLORS.holoBg03
    ctx.fillRect(LABEL_WIDTH, trackY, barWidth, trackH)

    // Vertical marker lines
    ctx.fillStyle = COLORS.panelSeparator
    for (const m of markers) ctx.fillRect(m.x, trackY, 1, trackH)

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
      ctx.fillStyle = uiColor(block.color, state)
      ctx.fillRect(x, trackY + 1, blockW, trackH - 2)

      // Block border
      ctx.globalAlpha = 0.6
      ctx.strokeStyle = uiColor(block.color, state)
      ctx.lineWidth = 1
      ctx.strokeRect(x, trackY + 1, blockW, trackH - 2)

      // Per-state pattern (second, non-color channel)
      ctx.globalAlpha = 0.45
      ctx.fillStyle = uiColor(block.color, state)
      ctx.strokeStyle = uiColor(block.color, state)
      drawPattern(ctx, STATE_PATTERN[state], x, trackY + 1, blockW, trackH - 2)

      ctx.globalAlpha = 1

      // Label inside block if wide enough, otherwise a one-letter state glyph
      if (blockW >= 12) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(x, trackY, blockW, trackH)
        ctx.clip()
        ctx.fillStyle = uiColor(block.color, state)
        ctx.textAlign = 'left'
        ctx.fillText(blockW > 40 ? blockLabelParts(locale, block.label).map(p => p.text).join('') : stateGlyphText(locale, state), x + (blockW > 40 ? 4 : 3), trackY + trackH / 2 + 4)
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

/** The label of a block: the fixed words come from the catalog, the tool call (name, arguments) is data and declares its language. */
function LabelParts({ parts }: { parts: readonly LabelPart[] }) {
  return <>{parts.map((p, i) => p.data ? <span key={i} {...DATA_EN}>{p.text}</span> : <span key={i}>{p.text}</span>)}</>
}

/** "Idle (Starting)": the state, then the label of the block between parentheses when it adds something. */
function StateCell({ locale, state, detail }: { locale: Locale; state: TimelineStateKey; detail: string }) {
  const stateText = stateLabelText(locale, state)
  const parts = detail ? blockLabelParts(locale, detail) : []
  const showDetail = parts.length > 0 && parts.map(p => p.text).join('') !== stateText
  return <>{stateText}{showDetail && <>{' ('}<LabelParts parts={parts} />{')'}</>}</>
}

export function TimelinePanel({ visible, timelineEntries, currentTime, onClose, links }: TimelinePanelProps) {
  const { locale } = useLocale()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [tableView, setTableView] = useState(false)
  const [hoveredName, setHoveredName] = useState<string | undefined>()
  const [sequence, setSequence] = useState(false)
  const [activeArrowId, setActiveArrowId] = useState<string | undefined>()
  // Rows in view (#659): only they are drawn; updated on scroll, and only when the range changes
  const [rowRange, setRowRange] = useState({ first: 0, last: 20 })
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
  // The words of the arrows come from the catalog; the names and the content are data
  const arrowText = (a: SwimlaneArrow) => arrowLabelText(locale, a.kind, a.isError, a.fromName, a.toName)
  const messageRows = useMemo(() => buildMessageRows(arrows, {
    kindLabel: (kind, isError) => arrowKindText(locale, kind, isError),
    label: a => arrowLabelText(locale, a.kind, a.isError, a.fromName, a.toName),
  }), [arrows, locale])
  const cappedButtons = useMemo(() => capMessageRows(messageRows), [messageRows])
  const activeArrow = arrows.find(a => a.id === activeArrowId)
  const ariaLabel = timelineLabelText(locale, sortedEntries, currentTime)

  const canvasHeight = HEADER_HEIGHT + sortedEntries.length * ROW_HEIGHT
  const droppedBlocks = useMemo(() => totalDroppedBlocks(sortedEntries), [sortedEntries])


  // Bottom dock: centred above the control bar, narrowed by the chat / link / card beside it
  const dock = useDockPanel('timeline', visible)
  const dockRect = dock.rect

  const updateRowRange = () => {
    const el = scrollRef.current
    if (!el) return
    const next = visibleRowRange(el.scrollTop, el.clientHeight || 300, sortedEntries.length, HEADER_HEIGHT, ROW_HEIGHT)
    setRowRange(prev => (prev.first === next.first && prev.last === next.last ? prev : next))
  }
  // Scroll, then a change in the number of rows (clientHeight is read there, not at render)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- updateRowRange only reads refs and sortedEntries.length
  useEffect(() => { if (visible) updateRowRange() }, [visible, sortedEntries.length, dockRect?.h])

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
    const scrollContainer = scrollRef.current
    const width = scrollContainer?.clientWidth ?? canvas.clientWidth
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = canvasHeight * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${canvasHeight}px`

    drawTimeline(ctx, sortedEntries, currentTime, width, canvasHeight, dpr, arrows, activeArrowId, locale, rowRange)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- redraw on every prop change (component only re-renders on data/time updates)
  }, [visible, tableView, sortedEntries, currentTime, canvasHeight, arrows, activeArrowId, dockRect?.w, locale, rowRange])

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
      position={dockRect ? { bottom: dock.bottomOffset, left: dockRect.x } : { bottom: 72, left: 16, right: 16 }}
      axis="Y"
      zIndex={Z.sidePanel}
      width={dockRect?.w}
      className="motion-reduce:transition-none"
      attrs={{ ...dockAttrs('timeline', 'bottom', dock, visible), 'data-sensitive': '' }}
      label={panelName(locale, 'timeline')}
      labelLang={locale}
      style={dock.hidden ? { display: 'none' } : dockRect ? undefined : { maxWidth: 700, margin: '0 auto' }}
    >
      <div className="glass-card relative flex flex-col" role="region" aria-label={translate(locale, 'tl.region')} lang={locale} style={{ maxHeight: dockRect?.h }}>
        <PanelHeader
          onClose={onClose}
          closeLabel={translate(locale, 'common.close')}
          actions={
            <div className="flex items-center gap-1">
            {links && (
              <button
                type="button"
                onClick={() => setSequence(v => !v)}
                aria-pressed={sequence}
                title={translate(locale, 'tl.sequence.title')}
                className={`min-h-6 min-w-6 px-2 rounded-sm text-2xs font-mono ${FOCUS_RING}`}
                style={{ color: COLORS.textPrimary, border: `1px solid ${COLORS.holoBorder06}` }}
              >
                {translate(locale, 'tl.sequence')}
              </button>
            )}
            <button
              type="button"
              onClick={() => setTableView(v => !v)}
              aria-pressed={tableView}
              aria-controls={tableId}
              className={`min-h-6 min-w-6 px-2 rounded-sm text-2xs font-mono ${FOCUS_RING}`}
              style={{ color: COLORS.textPrimary, border: `1px solid ${COLORS.holoBorder06}` }}
            >
              {translate(locale, 'tl.table')}
            </button>
            </div>
          }
        >
          <span lang={locale} className="text-2xs font-mono tracking-wider" style={{ color: COLORS.textPrimary }}>
            {translate(locale, 'panel.heading.timeline')}
          </span>
        </PanelHeader>

        <div
          ref={scrollRef}
          tabIndex={0}
          role="group"
          aria-label={translate(locale, 'tl.scroll')}
          className={`min-h-0 overflow-auto ${FOCUS_RING}`}
          style={{ maxHeight: 300 }}
          onScroll={updateRowRange}
        >
          {/* The image role sits on a wrapper: the canvas keeps its pointer handlers (hover names) without
              being turned into a non-interactive element. The table view is the full text alternative. */}
          <div role="img" aria-label={ariaLabel} hidden={tableView} style={{ display: tableView ? 'none' : 'block' }}>
            <canvas
              ref={canvasRef}
              title={hoveredName}
              onMouseMove={handleMouseMove}
              onMouseLeave={() => { setHoveredName(undefined); setActiveArrowId(undefined) }}
              style={{ display: 'block' }}
            >
              {translate(locale, 'tl.canvasFallback', { label: ariaLabel })}
            </canvas>
          </div>

          {/* Hidden, the table sits in a 1 px clipped box: a table is never narrower than its content, so as `sr-only` itself it
              stuck out of the panel and made it wider than the window for nothing (measured in French at 320 px) */}
          <div className={tableView ? undefined : 'sr-only'}>
          <table
            id={tableId}
            className="w-full text-xs font-mono border-collapse"
            style={tableView ? { color: COLORS.textPrimary } : undefined}
          >
            <caption className="sr-only">{ariaLabel}</caption>
            <thead>
              <tr style={{ color: COLORS.textMutedOpaque }}>
                <th scope="col" className="text-left px-2 py-1 font-normal">{translate(locale, 'tl.col.agent')}</th>
                <th scope="col" className="text-left px-2 py-1 font-normal">{translate(locale, 'tl.col.state')}</th>
                <th scope="col" className="text-left px-2 py-1 font-normal">{translate(locale, 'tl.col.start')}</th>
                <th scope="col" className="text-left px-2 py-1 font-normal">{translate(locale, 'tl.col.end')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={4} className="px-2 py-1">{translate(locale, 'tl.empty')}</td></tr>
              )}
              {rows.map((r, i) => (
                <tr key={`${r.agentId}-${i}`} style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
                  <th scope="row" className="text-left px-2 py-1 font-normal break-all">{r.agentName}</th>
                  <td className="px-2 py-1 [overflow-wrap:anywhere]"><StateCell locale={locale} state={r.state} detail={r.detail} /></td>
                  <td className="px-2 py-1">{r.start}</td>
                  <td className="px-2 py-1">{r.endTime === null ? translate(locale, 'tl.ongoing') : r.end}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          {messageRows.length > 0 && tableView && (
            <table id={messagesTableId} className="w-full text-xs font-mono border-collapse mt-2" style={{ color: COLORS.textPrimary }}>
              <caption className="text-left px-2 py-1" style={{ color: COLORS.textMutedOpaque }}>{translate(locale, 'tl.msgs.caption')}</caption>
              <thead>
                <tr style={{ color: COLORS.textMutedOpaque }}>
                  <th scope="col" className="text-left px-2 py-1 font-normal">{translate(locale, 'tl.msgs.col.time')}</th>
                  <th scope="col" className="text-left px-2 py-1 font-normal">{translate(locale, 'tl.msgs.col.kind')}</th>
                  <th scope="col" className="text-left px-2 py-1 font-normal">{translate(locale, 'tl.msgs.col.from')}</th>
                  <th scope="col" className="text-left px-2 py-1 font-normal">{translate(locale, 'tl.msgs.col.to')}</th>
                  <th scope="col" className="text-left px-2 py-1 font-normal">{translate(locale, 'tl.msgs.col.content')}</th>
                </tr>
              </thead>
              <tbody>
                {messageRows.map(r => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
                    <td className="px-2 py-1 whitespace-nowrap">{r.start}</td>
                    <th scope="row" className="text-left px-2 py-1 font-normal break-words">{r.kindLabel}</th>
                    <td className="px-2 py-1 break-words">{r.from}</td>
                    <td className="px-2 py-1 break-words">{r.to}</td>
                    <td {...DATA_EN} className="px-2 py-1 break-words whitespace-pre-wrap">{r.content.slice(0, 300)}{r.content.length > 300 ? '…' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {isPairComplete(pair) && (
          <div className="px-3 py-1.5" style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
            <PairFilterChip pair={pair} nameOf={id => nameById.get(id) ?? id} count={arrows.length} onClear={clearPair} locale={locale} />
          </div>
        )}

        {/* Messages between rows: hover or focus an entry to read it (canvas arrows have no focus of their own) */}
        {!tableView && messageRows.length > 0 && (
          <div className="px-3 py-1.5" style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
            <div
              role="group"
              aria-label={translate(locale, 'tl.msgs.caption')}
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
                  className={`min-h-6 px-1.5 rounded-sm text-2xs font-mono ${FOCUS_RING}`}
                  style={{ color: COLORS.textMutedOpaque, border: `1px solid ${COLORS.holoBorder06}` }}
                >
                  {r.start} {r.label}
                </button>
              ))}
              {cappedButtons.hidden > 0 && (
                <span className="text-2xs font-mono self-center" style={{ color: COLORS.textMutedOpaque }}>
                  {earlierMessagesText(locale, cappedButtons.hidden)}
                </span>
              )}
            </div>
            <div role="status" className="text-2xs font-mono mt-1 whitespace-pre-wrap break-words" style={{ color: COLORS.textPrimary, maxHeight: 64, overflow: 'auto' }}>
              {activeArrow && (
                <>
                  {arrowText(activeArrow)}{': '}
                  <span {...DATA_EN}>{activeArrow.content.slice(0, 400)}{activeArrow.content.length > 400 ? '…' : ''}</span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Blocks dropped to keep the timeline bounded (#659): counted, never lost silently */}
        {droppedBlocks > 0 && (
          <div className="px-3 py-1 text-2xs font-mono" style={{ borderTop: `1px solid ${COLORS.holoBorder06}`, color: COLORS.textMutedOpaque }}>
            {olderBlocksText(locale, droppedBlocks)}
          </div>
        )}

        {/* Legend (static DOM) */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5" style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
          {legendItems().map(item => (
            <div key={item.state} className="flex items-center gap-1">
              <div
                className="w-3 h-3 rounded-sm"
                aria-hidden="true"
                style={{ background: legendSwatchBackground(item.state, item.color), border: `1px solid ${item.color}` }}
              />
              <span className="text-2xs font-mono" style={{ color: COLORS.textMutedOpaque }}>
                {stateLabelText(locale, item.state)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </SlidingPanel>
  )
}
