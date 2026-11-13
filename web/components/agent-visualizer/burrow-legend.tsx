'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useT } from '@/lib/locale'
import { FOCUS_RING } from '@/lib/focus-ring'
import { BURROW_ROOM_TOOLS } from '@/lib/burrow/burrow-model'

/** Rooms in the order of the legend; the tools of a room come from the model, so the legend cannot drift from the placement */
const LEGEND_ROOMS = ['lounge', 'office', 'library', 'workshop', 'lab', 'door'] as const

/** Burrow view: a toggle that opens a compact legend of the rooms and their tools (Escape or the button closes it) */
export function BurrowLegend() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const tools = (room: (typeof LEGEND_ROOMS)[number]): string =>
    room === 'lounge' ? t('burrow.legend.none') : room === 'lab' ? t('burrow.legend.other') : BURROW_ROOM_TOOLS[room].join(', ')

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(o => !o)}
        className={`min-h-6 cursor-pointer rounded px-1.5 py-0.5 ${FOCUS_RING}`}
        style={{ background: 'var(--lens-surface-raised)', border: '1px solid var(--lens-control-border)', color: 'var(--lens-ink)' }}
      >
        {t('burrow.legend')}
      </button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label={t('burrow.legend.title')}
          className="max-w-xs rounded p-2 text-left"
          style={{ background: 'var(--lens-surface-raised)', border: '1px solid var(--lens-control-border)', color: 'var(--lens-ink)' }}
        >
          <dl className="m-0 flex flex-col gap-1">
            {LEGEND_ROOMS.map(room => (
              <div key={room}>
                <dt className="inline font-bold">{t(`burrow.room.${room}`)}</dt>
                <dd className="m-0 inline">{' : '}{tools(room)}</dd>
              </div>
            ))}
          </dl>
          <p className="m-0 mt-1" style={{ color: 'var(--lens-ink-muted)' }}>{t('burrow.legend.letters')}</p>
        </div>
      )}
    </>
  )
}
