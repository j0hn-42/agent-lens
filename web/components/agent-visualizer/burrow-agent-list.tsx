'use client'

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { FOCUS_RING_INSET } from '@/lib/focus-ring'
import { Z } from '@/lib/agent-types'
import type { BurrowRow } from '@/lib/burrow/burrow-sync'

/**
 * Visually hidden until a button inside takes focus, then shown under the Room titles button: it hangs from the
 * burrow's control column (`top-full right-0`), which sits below the top bar, so no focused row is drawn under the
 * bar. It stays `position: absolute` in both states: `sr-only focus-within:not-sr-only` would reset it to `static`,
 * make it a flex child beside the stage and shrink the scene while the list has focus.
 */
const LIST_CLASS = [
  'absolute right-0 top-full mt-1 m-0 flex max-h-[calc(100dvh-var(--topbar-h,60px)-6rem)] w-max max-w-[min(24rem,var(--burrow-room,calc(100vw-2rem)))] list-none flex-col gap-1 p-0 text-2xs font-mono',
  'size-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]',
  'focus-within:h-auto focus-within:w-auto focus-within:overflow-y-auto focus-within:whitespace-normal focus-within:[clip-path:none]',
].join(' ')

/** Portrait: always shown, filling the panel the view places under the stage, scrolled when the rows overflow it */
const PANEL_CLASS = 'm-0 flex size-full list-none flex-col gap-1 overflow-y-auto p-0 text-2xs font-mono'

export interface PopupAnchor { x: number; y: number }

/** Where a popup opened from an element goes: under its bottom centre, in viewport pixels (the popup's own placement) */
export function popupAnchor(el: Element): PopupAnchor {
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.bottom }
}

/** The L shortcut: the focus goes to the list's tab stop (it appears, as when Tab reaches it); false when there is none */
export function focusBurrowAgentList(): boolean {
  const target = document.querySelector<HTMLElement>('[data-burrow-agent-list] button[tabindex="0"]')
    ?? document.querySelector<HTMLElement>('[data-burrow-agent-list] button')
  target?.focus()
  return target !== null
}

export interface BurrowAgentListProps {
  label: string
  rows: BurrowRow[]
  selectedAgentId: string | null
  rowLabel: (row: BurrowRow) => string
  /** Heading of a session group, used when the rows come from several sessions */
  groupLabel: (sessionId: string) => string
  onAgentClick: (agentId: string) => void
  onAgentHover: (agentId: string | null) => void
  /** Opens the tool call a row names (Shift+Enter on a row that carries a running call), its popup at the row; absent = no such action */
  onToolCallClick?: (toolCallId: string, anchor: PopupAnchor) => void
  /** Accessible description of that key, said after the row's name (the hint of the secondary action) */
  toolCallKeyHint?: string
  /** Portrait layout: the list is always shown and fills its panel; otherwise it is hidden until it takes the focus */
  panel?: boolean
}

/** The rows by session, in order of first appearance (the tree order kept inside each); a single session is not split */
function groupBySession(rows: BurrowRow[]): Array<{ sessionId: string | null; rows: BurrowRow[] }> {
  if (new Set(rows.map((r) => r.sessionId)).size < 2) return [{ sessionId: null, rows }]
  const groups = new Map<string, BurrowRow[]>()
  for (const r of rows) {
    const list = groups.get(r.sessionId)
    if (list) list.push(r)
    else groups.set(r.sessionId, [r])
  }
  return [...groups].map(([sessionId, list]) => ({ sessionId, rows: list }))
}

/**
 * The keyboard and screen reader path: one button per agent, the same pick as a click on its animal. One Tab stop
 * (roving tabindex): the arrows, Home and End move between rows, Enter and Space select as on any button. The visible
 * name is truncated, the title and the accessible name carry it in full.
 */
export function BurrowAgentList({ label, rows, selectedAgentId, groupLabel, rowLabel, onAgentClick, onAgentHover, onToolCallClick, toolCallKeyHint, panel = false }: BurrowAgentListProps) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const groups = groupBySession(rows)
  const ordered = groups.flatMap((g) => g.rows)
  // the tab stop: the row last focused, else the selected one, else the first (a row that left the list is not kept)
  const stop = [activeId, selectedAgentId].find((id) => id !== null && ordered.some((r) => r.id === id)) ?? ordered[0]?.id

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, toolCallId?: string) => {
    // the secondary action: a row that runs a tool opens that call (a plain Enter stays the click that selects the agent)
    if (e.key === 'Enter' && e.shiftKey && toolCallId && onToolCallClick) {
      e.preventDefault()
      onToolCallClick(toolCallId, popupAnchor(e.currentTarget))
      return
    }
    const buttons = Array.from(e.currentTarget.closest('[data-burrow-agent-list]')?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    const next = e.key === 'ArrowDown' ? Math.min(at + 1, buttons.length - 1)
      : e.key === 'ArrowUp' ? Math.max(at - 1, 0)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? buttons.length - 1
      : -1
    if (next < 0) return
    e.preventDefault()
    buttons[next].focus()
  }

  // React gives the focus back to a button it only moved (rows reordered by attention), not to one it remounted: when
  // the list splits into session groups or merges back, the focused button is a new node, the focus would fall to
  // <body> and the list, shown only while it holds the focus, would vanish. The focused row is read before this
  // render is committed and focused again after it.
  const listRef = useRef<HTMLUListElement>(null)
  const focusedRow = useRef<string | null>(null)
  const active = typeof document === 'undefined' ? null : document.activeElement
  focusedRow.current = active instanceof HTMLElement && listRef.current?.contains(active) ? active.dataset.burrowRow ?? null : null
  useLayoutEffect(() => {
    const id = focusedRow.current
    if (id === null) return
    const target = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-burrow-row]') ?? [])
      .find((b) => b.dataset.burrowRow === id)
    if (target && document.activeElement !== target) target.focus()
  })

  const item = (r: BurrowRow) => (
    <li key={r.id} style={r.depth > 0 ? { paddingInlineStart: `${r.depth * 0.75}rem` } : undefined}>
      <button
        type="button"
        data-burrow-row={r.id}
        tabIndex={r.id === stop ? 0 : -1}
        title={rowLabel(r)}
        aria-current={r.id === selectedAgentId ? 'true' : undefined}
        onClick={() => onAgentClick(r.id)}
        onFocus={() => { setActiveId(r.id); onAgentHover(r.id) }}
        onBlur={() => onAgentHover(null)}
        onKeyDown={(e) => onKeyDown(e, r.toolCallId)}
        {...(r.toolCallId && onToolCallClick ? { 'aria-keyshortcuts': 'Shift+Enter', 'aria-description': toolCallKeyHint } : {})}
        className={`block w-full max-w-full cursor-pointer truncate rounded px-1.5 py-0.5 text-left ${FOCUS_RING_INSET}`}
        style={{ background: 'var(--lens-surface-raised)', border: '1px solid var(--lens-control-border)', color: 'var(--lens-ink)' }}
      >
        {/* the colour of the animal's floor ring (its session or team halo), a picture beside the text that names the group */}
        {r.marker && (
          <span
            aria-hidden="true"
            data-burrow-swatch
            className="mr-1 inline-block size-2 rounded-full align-middle"
            style={{ background: r.marker, outline: '1px solid var(--lens-control-border)' }}
          />
        )}
        {rowLabel(r)}
      </button>
    </li>
  )

  return (
    <ul ref={listRef} data-burrow-agent-list aria-label={label} className={panel ? PANEL_CLASS : LIST_CLASS} style={{ color: 'var(--lens-ink)', zIndex: Z.info }}>
      {/* one session: a flat list of agents; several: one labelled list per session, each in an item of its own */}
      {groups.length === 1 ? groups[0].rows.map(item) : groups.map((g) => (
        <li key={g.sessionId ?? ''}>
          <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={g.sessionId !== null ? groupLabel(g.sessionId) : undefined}>
            {g.sessionId !== null && (
              <li data-burrow-session aria-hidden="true" className="truncate px-1 pt-1 font-semibold">{groupLabel(g.sessionId)}</li>
            )}
            {g.rows.map(item)}
          </ul>
        </li>
      ))}
    </ul>
  )
}
