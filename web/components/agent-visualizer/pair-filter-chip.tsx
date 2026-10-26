'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING_INSET } from '@/lib/focus-ring'
import { isPairComplete, isPairSet, type PairState } from '@/lib/pair-filter'
import { pairAnnouncementText, pairChipLabelText, pairSpokenText, t as tr } from '@/lib/panel-text'
import type { Locale } from '@/lib/messages'

// One polite live region shared by every chip on the page (Conversation panel, timeline): the first mounted
// chip renders it, and a message is announced only when the pair or its on/off state changes, never when
// the message count of an unchanged pair moves.
const owners: symbol[] = []
const subscribers = new Set<() => void>()
let announcedKey: string | null = null
let announcedText = ''
let announcedEmpty = false
/** Language of the announcement now in the live region */
let announcedLang: Locale = 'en'
let version = 0

function emit() { version++; for (const s of [...subscribers]) s() }
function subscribe(l: () => void) { subscribers.add(l); return () => { subscribers.delete(l) } }
const snapshot = () => version

function registerChip(id: symbol): () => void {
  owners.push(id)
  emit()
  return () => {
    owners.splice(owners.indexOf(id), 1)
    if (owners.length === 0) { announcedKey = null; announcedText = ''; announcedEmpty = false; announcedLang = 'en' }
    emit()
  }
}

function announce(key: string, text: string, lang: Locale, initial: boolean, pairIsSet: boolean, count: number, isPairCompleteKey: boolean) {
  // The guard also dedups the several chips (Conversation panel, timeline) that report the same pair.
  if (announcedKey === key) {
    // A pair chosen before its messages loaded announced "No messages"; say the real count once, but never
    // re-announce a count that merely moves
    if (announcedEmpty && count > 0) { announcedEmpty = false; announcedText = text; announcedLang = lang; emit() }
    return
  }
  const first = announcedKey === null
  announcedKey = key
  // A chip mounted while no pair is chosen has nothing to say yet
  if (first && initial && !pairIsSet) return
  announcedText = text
  announcedLang = lang
  announcedEmpty = count === 0 && isPairCompleteKey
  emit()
}

/**
 * Visible, removable chip for the active Pair filter ("orchestrator <-> audit-ux") plus the shared polite
 * live region that announces changes and the number of messages shown. Used by the Conversation panel
 * and the timeline.
 */
export function PairFilterChip({ pair, nameOf, count, onClear, locale = 'en' }: {
  pair: PairState
  nameOf: (key: string) => string
  /** Language of the chip and of its announcement */
  locale?: Locale
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
  const hasMessages = count > 0
  const mounted = useRef(false)
  useEffect(() => {
    const initial = !mounted.current
    mounted.current = true
    announce(key, pairAnnouncementText(locale, pairRef.current, nameOfRef.current, countRef.current), locale, initial, isPairSet(pairRef.current), countRef.current, isPairComplete(pairRef.current))
  }, [key, hasMessages, locale])

  return (
    <>
      {isOwner && <div role="status" aria-live="polite" lang={announcedLang} className="sr-only">{announcedText}</div>}
      {set && (
        <span
          role="group"
          lang={locale}
          aria-label={tr(locale, 'pair.group', { label: pairSpokenText(locale, pair, nameOf) })}
          className="inline-flex items-center gap-0.5 rounded-full pl-2 text-2xs font-mono max-w-full"
          style={{ background: COLORS.holoBg10, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
        >
          <span className="truncate" title={pairSpokenText(locale, pair, nameOf)}>{pairChipLabelText(pair, nameOf)}</span>
          <button
            type="button"
            aria-label={tr(locale, 'pair.clear')}
            title={tr(locale, 'pair.clear')}
            onClick={onClear}
            className={`min-h-6 min-w-6 inline-flex items-center justify-center rounded-full ${FOCUS_RING_INSET}`}
            style={{ color: COLORS.textMuted }}
          >
            <span aria-hidden="true">{'×'}</span>
          </button>
        </span>
      )}
    </>
  )
}
