'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/feed-utils'
import {
  isPairSet, pairAnnouncement, pairChipLabel, pairSpokenLabel, type PairState,
} from '@/lib/pair-filter'

// One polite live region shared by every chip on the page (feed, transcript, timeline): the first mounted
// chip renders it, and a message is announced only when the pair or its on/off state changes, never when
// the message count of an unchanged pair moves.
const owners: symbol[] = []
const subscribers = new Set<() => void>()
let announcedKey: string | null = null
let announcedText = ''
let version = 0

function emit() { version++; for (const s of [...subscribers]) s() }
function subscribe(l: () => void) { subscribers.add(l); return () => { subscribers.delete(l) } }
const snapshot = () => version

function registerChip(id: symbol): () => void {
  owners.push(id)
  emit()
  return () => {
    owners.splice(owners.indexOf(id), 1)
    if (owners.length === 0) { announcedKey = null; announcedText = '' }
    emit()
  }
}

function announce(key: string, text: string, initial: boolean, pairIsSet: boolean) {
  if (announcedKey === key) return
  const first = announcedKey === null
  announcedKey = key
  // A chip mounted while no pair is chosen has nothing to say yet
  if (first && initial && !pairIsSet) return
  announcedText = text
  emit()
}

/**
 * Visible, removable chip for the active Pair filter ("orchestrator <-> audit-ux") plus the shared polite
 * live region that announces changes and the number of messages shown. Used by the feed, the transcript
 * and the timeline.
 */
export function PairFilterChip({ pair, nameOf, count, onClear }: {
  pair: PairState
  nameOf: (key: string) => string
  /** Messages currently shown for the pair */
  count: number
  onClear: () => void
}) {
  const set = isPairSet(pair)
  const id = useRef<symbol>(Symbol('pair-chip'))
  useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => registerChip(id.current), [])
  const isOwner = owners[0] === id.current
  const key = `${pair.a}|${pair.b}`
  const countRef = useRef(count)
  countRef.current = count
  const nameOfRef = useRef(nameOf)
  nameOfRef.current = nameOf
  const pairRef = useRef(pair)
  pairRef.current = pair
  const mounted = useRef(false)
  useEffect(() => {
    const initial = !mounted.current
    mounted.current = true
    announce(key, pairAnnouncement(pairRef.current, nameOfRef.current, countRef.current), initial, isPairSet(pairRef.current))
  }, [key])

  return (
    <>
      {isOwner && <div role="status" aria-live="polite" className="sr-only">{announcedText}</div>}
      {set && (
        <span
          role="group"
          aria-label={`Pair filter: ${pairSpokenLabel(pair, nameOf)}`}
          className="inline-flex items-center gap-0.5 rounded-full pl-2 text-[11px] font-mono max-w-full"
          style={{ background: COLORS.holoBg10, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
        >
          <span className="truncate" title={pairSpokenLabel(pair, nameOf)}>{pairChipLabel(pair, nameOf)}</span>
          <button
            type="button"
            aria-label="Clear pair filter"
            title="Clear pair filter"
            onClick={onClear}
            className={`min-h-6 min-w-6 inline-flex items-center justify-center rounded-full ${FOCUS_RING}`}
            style={{ color: COLORS.textMuted }}
          >
            <span aria-hidden="true">{'×'}</span>
          </button>
        </span>
      )}
    </>
  )
}
