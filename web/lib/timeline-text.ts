/**
 * Words of the Timeline panel in the active language (#373).
 *
 * Only the language of a text is decided here: the rows, the times (1:05), the counts and the order come from
 * timeline-rows.ts; scripts/timeline-text-i18n.test.ts checks that the English output is identical to the helpers
 * these functions mirror. Pure: no React, no DOM; relative imports only so node:test can load it.
 */
import { translate, type Locale, type MessageKey } from './messages'
import { computeTimelineRange, type SwimlaneArrowKind, type TimelineStateKey } from './timeline-rows'
import type { TimelineEntry } from './agent-types'
import { EXPIRED_LABEL_SUFFIX } from './ui-glossary'
import { formatDuration } from './utils'

type Params = Readonly<Record<string, string | number>>

const t = (locale: Locale, key: MessageKey, params?: Params) => translate(locale, key, params)

/** "one" and "other" forms of a message; the locale's plural rule picks (French: 0 and 1 are singular). The number is written for the locale. */
function plural(locale: Locale, base: 'tl.aria.range' | 'tl.earlier' | 'tl.olderBlocks', n: number, params: Params = {}): string {
  const rule = new Intl.PluralRules(locale).select(n) === 'one' ? 'one' : 'other'
  return t(locale, `${base}.${rule}` as MessageKey, { n: new Intl.NumberFormat(locale).format(n), ...params })
}

export function stateLabelText(locale: Locale, state: TimelineStateKey): string {
  return t(locale, `tl.state.${state}` as MessageKey)
}

/** The letter drawn in a block too narrow for its label: one per state, distinct in each language (never colour alone). */
export function stateGlyphText(locale: Locale, state: TimelineStateKey): string {
  return t(locale, `tl.glyph.${state}` as MessageKey)
}

const KIND_KEY: Record<SwimlaneArrowKind, MessageKey> = {
  dispatch: 'conv.comm.dispatch', return: 'conv.comm.return', message: 'conv.comm.message',
}

/** 'Dispatch' | 'Return' | 'Return (error)' | 'Message' (column Kind of the table view). */
export function arrowKindText(locale: Locale, kind: SwimlaneArrowKind, isError: boolean): string {
  if (kind === 'dispatch') return t(locale, 'tl.kind.dispatch')
  if (kind === 'return') return t(locale, isError ? 'tl.kind.returnError' : 'tl.kind.return')
  return t(locale, 'tl.kind.message')
}

/** 'orchestrator -> explore - DISPATCH'; the names are data and stay as they came. */
export function arrowLabelText(locale: Locale, kind: SwimlaneArrowKind, isError: boolean, fromName: string, toName: string): string {
  const word = kind === 'return' && isError ? t(locale, 'conv.comm.returnError') : t(locale, KIND_KEY[kind])
  return `${fromName} -> ${toName} - ${word}`
}

/** Accessible name of the timeline canvas. */
export function timelineLabelText(locale: Locale, entries: readonly TimelineEntry[], currentTime: number): string {
  if (entries.length === 0) return t(locale, 'tl.aria.none')
  const { minTime, maxTime } = computeTimelineRange(entries, currentTime)
  return plural(locale, 'tl.aria.range', entries.length, { from: formatDuration(minTime), to: formatDuration(maxTime) })
}

export function earlierMessagesText(locale: Locale, hidden: number): string {
  return plural(locale, 'tl.earlier', hidden)
}

/** Total of the blocks dropped to keep the timeline bounded (#659). */
export function totalDroppedBlocks(entries: Iterable<Pick<TimelineEntry, 'droppedBlocks'>>): number {
  let n = 0
  for (const e of entries) n += e.droppedBlocks ?? 0
  return n
}

export function olderBlocksText(locale: Locale, hidden: number): string {
  return plural(locale, 'tl.olderBlocks', hidden)
}

/** A piece of a block label: `data` is text that came from a tool call (name, arguments) and keeps its language. */
export interface LabelPart { text: string; data: boolean }

const FIXED_LABEL: Record<string, MessageKey> = {
  'Thinking...': 'tl.block.thinking', Starting: 'tl.block.starting', Done: 'tl.block.done', Permission: 'tl.block.permission', Resumed: 'tl.block.resumed',
}

/**
 * The label of a timeline block, as it was written when the event came (hooks/simulation), in the active language.
 * The fixed words (Thinking..., Starting, Done, Permission, Resumed, FAILED, CANCELLED, the expiry suffix) are translated;
 * the rest is a tool call and its arguments, data that is never translated and is returned flagged so a DOM can mark it `lang="en"`.
 */
export function blockLabelParts(locale: Locale, label: string): LabelPart[] {
  const suffix = ` ${EXPIRED_LABEL_SUFFIX}`
  const expired = label.endsWith(suffix)
  const base = expired ? label.slice(0, -suffix.length) : label
  const parts: LabelPart[] = []
  const outcome = /^([\s\S]*): (FAILED|CANCELLED)$/.exec(base)
  if (FIXED_LABEL[base]) parts.push({ text: t(locale, FIXED_LABEL[base]), data: false })
  else if (outcome) {
    parts.push({ text: `${outcome[1]}: `, data: true })
    parts.push({ text: t(locale, outcome[2] === 'FAILED' ? 'tl.block.failed' : 'tl.block.cancelled'), data: false })
  } else parts.push({ text: base, data: true })
  if (expired) parts.push({ text: ` ${t(locale, 'tl.block.expired')}`, data: false })
  return parts
}
