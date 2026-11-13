'use client'

import { useState, type KeyboardEvent } from 'react'
import { FOCUS_RING } from '@/lib/focus-ring'
import { Z } from '@/lib/agent-types'
import type { BurrowRow } from '@/lib/burrow/burrow-sync'

/**
 * Visually hidden until a button inside takes focus, then shown under the Room titles button: it hangs from the
 * burrow's control column (`top-full right-0`), which sits below the top bar, so no focused row is drawn under the
 * bar. It stays `position: absolute` in both states: `sr-only focus-within:not-sr-only` would reset it to `static`,
 * make it a flex child beside the stage and shrink the scene while the list has focus.
 */
const LIST_CLASS = [
  'absolute right-0 top-full mt-1 m-0 flex max-h-[calc(100dvh-var(--topbar-h,60px)-6rem)] w-max max-w-[min(24rem,calc(100vw-2rem))] list-none flex-col gap-1 p-0 text-2xs font-mono',
  'size-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]',
  'focus-within:h-auto focus-within:w-auto focus-within:overflow-y-auto focus-within:whitespace-normal focus-within:[clip-path:none]',
].join(' ')

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
export function BurrowAgentList({ label, rows, selectedAgentId, groupLabel, rowLabel, onAgentClick, onAgentHover }: BurrowAgentListProps) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const groups = groupBySession(rows)
  const ordered = groups.flatMap((g) => g.rows)
  // the tab stop: the row last focused, else the selected one, else the first (a row that left the list is not kept)
  const stop = [activeId, selectedAgentId].find((id) => id !== null && ordered.some((r) => r.id === id)) ?? ordered[0]?.id

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
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

  return (
    <ul data-burrow-agent-list aria-label={label} onKeyDown={onKeyDown} className={LIST_CLASS} style={{ color: 'var(--lens-ink)', zIndex: Z.info }}>
      {groups.map((g) => (
        <li key={g.sessionId ?? 'all'} className="contents">
          <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={g.sessionId !== null ? groupLabel(g.sessionId) : undefined}>
            {g.sessionId !== null && (
              <li data-burrow-session aria-hidden="true" className="truncate px-1 pt-1 font-semibold">{groupLabel(g.sessionId)}</li>
            )}
            {g.rows.map((r) => (
              <li key={r.id} style={r.depth > 0 ? { paddingInlineStart: `${r.depth * 0.75}rem` } : undefined}>
                <button
                  type="button"
                  tabIndex={r.id === stop ? 0 : -1}
                  title={rowLabel(r)}
                  aria-current={r.id === selectedAgentId ? 'true' : undefined}
                  onClick={() => onAgentClick(r.id)}
                  onFocus={() => { setActiveId(r.id); onAgentHover(r.id) }}
                  onBlur={() => onAgentHover(null)}
                  className={`block w-full max-w-full cursor-pointer truncate rounded px-1.5 py-0.5 text-left ${FOCUS_RING}`}
                  style={{ background: 'var(--lens-surface-raised)', border: '1px solid var(--lens-control-border)', color: 'var(--lens-ink)' }}
                >
                  {rowLabel(r)}
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )
}
