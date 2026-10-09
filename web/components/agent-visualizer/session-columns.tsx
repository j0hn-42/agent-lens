'use client'

/**
 * Columns of the Sessions panel: Name / Model / Tokens / Time. Rows stay buttons inside the existing
 * lists (tree, arrow-key roving, folding), so the columns are a grid INSIDE each row button; every
 * cell names itself for assistive tech (a visually hidden column name before the value, or the
 * reason for a dash), and the visible header only repeats what every cell already says.
 *
 * Wide panel: one line per entry, columns aligned on the right edge. Narrow panel (container query,
 * #116 reflow): the name takes a full line and Model / Tokens / Time follow on a second line, each
 * with its visible label, so nothing overflows horizontally or overlaps.
 */
import { useEffect, useRef } from 'react'
import { COLORS } from '@/lib/colors'
import { createChrono } from '@/lib/active-time'
import { COLUMN_LABELS, agentTimeCell, type ColumnCell } from '@/lib/session-columns'
import type { Freshness } from '@/hooks/simulation/freshness'
import type { ActiveTimeFields } from '@/lib/active-time'

/** Container width (px) under which the panel stacks the columns on a second line. */
export const COLUMNS_REFLOW_PX = 440

/** The row grid: [name | model | tokens | time] wide, [name / model tokens time] narrow. */
export const ROW_GRID =
  'grid items-center gap-x-2 gap-y-0 grid-cols-[minmax(0,1fr)_10ch_7ch_8ch] @max-[440px]:flex @max-[440px]:flex-wrap'
const NAME_CELL = '@max-[440px]:basis-full'
const SECOND_LINE = 'col-span-full flex flex-wrap items-center gap-x-2 text-[11px]'

type ColumnKey = Exclude<keyof typeof COLUMN_LABELS, 'name'>

const CELL_CLASS: Record<ColumnKey, string> = {
  model: 'min-w-0 truncate text-left @max-[440px]:max-w-full',
  tokens: 'whitespace-nowrap text-right tabular-nums @max-[440px]:shrink-0',
  time: 'whitespace-nowrap text-right tabular-nums @max-[440px]:ml-auto @max-[440px]:shrink-0',
}

/** Visible label of a cell, only shown once the columns are stacked (the header is hidden then). */
function StackedLabel({ column }: { column: ColumnKey }) {
  return <span aria-hidden="true" className="hidden @max-[440px]:inline" style={{ color: COLORS.textDim }}>{COLUMN_LABELS[column]} </span>
}

interface ColumnValueProps {
  column: ColumnKey
  cell: ColumnCell
  /** Tooltip; defaults to the accessible wording */
  title?: string
}

/** A static cell. Known value: "<column>, <wording>" for assistive tech, the compact text for the eye. */
export function ColumnValue({ column, cell, title }: ColumnValueProps) {
  return (
    <span className={CELL_CLASS[column]} style={{ color: COLORS.textMuted }} title={title ?? cell.label} data-column={column}>
      {cell.empty
        ? <><StackedLabel column={column} /><span aria-hidden="true">{cell.text}</span><span className="sr-only">{cell.label}</span></>
        : <><StackedLabel column={column} /><span aria-hidden="true">{cell.text}</span><span className="sr-only">{COLUMN_LABELS[column]}, {cell.label}</span></>}
    </span>
  )
}

// One timer for every live cell of the panel, only while some cell runs and the page is visible
const liveListeners = new Set<() => void>()
let liveTimer: ReturnType<typeof setInterval> | null = null
function subscribeLive(fn: () => void): () => void {
  liveListeners.add(fn)
  if (liveTimer === null) {
    liveTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      for (const l of [...liveListeners]) l()
    }, 1000)
  }
  return () => {
    liveListeners.delete(fn)
    if (liveListeners.size === 0 && liveTimer !== null) { clearInterval(liveTimer); liveTimer = null }
  }
}

interface LiveTimeProps {
  agent: ActiveTimeFields
  freshness: Freshness
  /** Overrides for tests */
  now?: () => number
  monotonic?: () => number
}

/**
 * Time cell of an agent. While a span runs, the text node is written directly once per second (no
 * re-render of the row, monotonic clock so a wall-clock jump cannot move it); digits are tabular and
 * the column has a fixed width, so the layout never shifts.
 */
export function LiveTimeValue({ agent, freshness, now = Date.now, monotonic = () => performance.now() }: LiveTimeProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const agentRef = useRef(agent)
  agentRef.current = agent
  const since = agent.activeSince
  const live = since !== undefined && freshness === 'fresh'

  const chrono = live ? createChrono({ startedAt: since, wallNow: now(), monotonic }) : null
  const cell = agentTimeCell(agent, freshness, chrono?.elapsedMs() ?? 0)

  useEffect(() => {
    if (!live || since === undefined) return
    const c = createChrono({ startedAt: since, wallNow: now(), monotonic })
    const tick = () => {
      if (ref.current) ref.current.textContent = agentTimeCell(agentRef.current, 'fresh', c.elapsedMs()).text
    }
    tick()
    return subscribeLive(tick)
  }, [live, since])

  if (cell.empty) return <ColumnValue column="time" cell={cell} />
  return (
    <span className={CELL_CLASS.time} style={{ color: COLORS.textMuted }} data-column="time" title="Active time">
      <StackedLabel column="time" />
      <span className="sr-only">{COLUMN_LABELS.time}, active, </span>
      <span ref={ref} data-testid="row-active-time">{cell.text}</span>
    </span>
  )
}

/** Visible header of the columns (hidden when stacked): sighted-only, each cell already names itself. */
export function ColumnHeader() {
  return (
    <div
      aria-hidden="true"
      data-testid="session-columns-header"
      className={`sticky top-0 z-10 pl-11 pr-8 pb-0.5 text-[11px] tracking-wider uppercase @max-[440px]:hidden ${ROW_GRID}`}
      style={{ background: COLORS.void, color: COLORS.textMuted, borderBottom: `1px solid ${COLORS.controlBorder}` }}
    >
      <span>{COLUMN_LABELS.name}</span>
      <span>{COLUMN_LABELS.model}</span>
      <span className="text-right">{COLUMN_LABELS.tokens}</span>
      <span className="text-right">{COLUMN_LABELS.time}</span>
    </div>
  )
}

export const COLUMN_CLASSES = { name: NAME_CELL, secondLine: SECOND_LINE } as const
