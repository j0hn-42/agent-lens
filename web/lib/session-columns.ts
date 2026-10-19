/**
 * Cells of the Sessions panel columns (Name / Model / Tokens / Time). Pure (no React, no DOM, no
 * clock of its own): the figures come from the existing helpers (usage, cost-rollup, active-time,
 * model names) and are only given their compact, honest display form here.
 *
 * Principle: a column without data shows a dash AND an accessible name saying why (never a 0 or an
 * empty cell), and a figure that is a lower bound or an estimate says so in words for assistive tech.
 */
import { CHRONO_CAP_MS, ACTIVE_UNKNOWN_TEXT, type ActiveTimeFields } from './active-time'
import { runtimeBadge } from './chrome-utils'
import { isPseudoModel } from './model-provenance'
import type { RollupTotal } from './cost-rollup'
import type { UsageTotal } from './usage'
import { COST_LABELS } from './ui-glossary'
import { formatCost, formatModelName, formatTokens } from './utils'
import { translate, type Locale, type MessageKey } from './messages'
import { relativeTimeText, usageText } from './card-text'
import type { SessionInfo } from './bridge-types'
import type { Freshness } from '../hooks/simulation/freshness'

/** The columns, in order (their header labels are the cols.* messages). */
export type ColumnName = 'name' | 'model' | 'runtime' | 'branch' | 'tokens' | 'cost' | 'time' | 'activity'

/** Header label of a column in the active language. */
export function columnLabel(column: ColumnName, locale: Locale = 'en'): string {
  return translate(locale, `cols.${column}` as MessageKey)
}

type Params = Readonly<Record<string, string | number>>
const tr = (locale: Locale, key: MessageKey, params?: Params) => translate(locale, key, params)

/** What a column shows when it has no data. */
export const NO_VALUE = '—'

/** One cell: `text` is what sighted users read, `label` what assistive tech reads instead (and the tooltip). */
export interface ColumnCell {
  /** Visible text; the dash when the value is unknown */
  text: string
  /** Accessible wording of the whole value ("at least 12k tokens", "model not reported") */
  label: string
  /** True when `text` stands for "no data" */
  empty: boolean
}

function emptyCell(label: string): ColumnCell {
  return { text: NO_VALUE, label, empty: true }
}

/** Short model name; the dash (named "model not reported") when no model ran or only a pseudo-model was seen. */
export function modelCell(modelId: string | null | undefined, locale: Locale = 'en'): ColumnCell {
  if (!modelId || isPseudoModel(modelId)) return emptyCell(tr(locale, 'cols.model.none'))
  const short = formatModelName(modelId)
  return { text: short, label: tr(locale, 'cols.model.value', { name: short }), empty: false }
}

/** Compact tokens of one agent: "12k", with a lower-bound mark (≥) or an estimate mark (~) that is also spelled out. */
export function tokensCell(
  usage: UsageTotal, locale: Locale = 'en',
  /**
   * The agent's session lost events (#366): the figure is the last context reading received, which a lost one could have
   * raised or lowered, so it is marked "?" and spelled "last reading (incomplete)", never "≥"
   */
  replayLoss = false,
): ColumnCell {
  if (usage.value === null || usage.status === 'unavailable') return emptyCell(tr(locale, 'cols.tokens.none'))
  if (replayLoss) {
    const v = usageText(locale, { ...usage, status: 'available' })
    return { text: `${usage.estimated ? '~' : ''}${formatTokens(usage.value)}?`, label: tr(locale, 'cols.tokens.valueLastReadingIncomplete', { value: v }), empty: false }
  }
  const mark = `${usage.status === 'partial' ? '≥' : ''}${usage.estimated ? '~' : ''}`
  return { text: `${mark}${formatTokens(usage.value)}`, label: tr(locale, 'cols.tokens.value', { value: usageText(locale, usage) }), empty: false }
}

/** Compact tokens of a session or branch total; the incomplete badge is spelled out. */
export function rollupTokensCell(total: RollupTotal | null | undefined, locale: Locale = 'en'): ColumnCell {
  if (!total || total.known === 0) return emptyCell(tr(locale, 'cols.tokens.none'))
  // A token sum under a replay loss adds absolute readings: incomplete ("?"), not a lower bound (#366)
  const lower = !total.complete && !total.replayLoss
  const mark = `${lower ? '≥' : ''}${total.estimated ? '~' : ''}`
  const v = formatTokens(total.tokens)
  const key = total.estimated
    ? (total.complete ? 'cols.tokens.rollupEstimated' : 'cols.tokens.rollupEstimatedIncomplete')
    : (total.complete ? 'cols.tokens.rollup' : 'cols.tokens.rollupIncomplete')
  return { text: `${mark}${v}${total.replayLoss ? '?' : ''}`, label: tr(locale, key, { v }), empty: false }
}

/** "42s", "3m 12s", "1h 05m", "3d 4h": at most 7 characters, so the column keeps its width. */
export function formatDurationCompact(ms: number, capped = false): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const text = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m.toString().padStart(2, '0')}m` : m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`
  return capped ? `${text}+` : text
}

/**
 * Active time of an agent (the same fields and rules as the detail card, issue #59): closed spans plus
 * the running span (`spanMs`, the live chrono) while the source is fresh. A running agent that is no
 * longer fresh, or one never observed working, has no honest figure: dash, "active time unknown".
 */
export function agentTimeCell(agent: ActiveTimeFields, freshness: Freshness, spanMs: number, locale: Locale = 'en'): ColumnCell {
  const unknown = locale === 'en' ? ACTIVE_UNKNOWN_TEXT : tr(locale, 'card.active.unknown')
  const closed = typeof agent.activeMs === 'number' && Number.isFinite(agent.activeMs) ? Math.max(0, agent.activeMs) : undefined
  if (typeof agent.activeSince === 'number') {
    if (freshness !== 'fresh') return emptyCell(unknown)
    const span = Math.min(Math.max(0, spanMs), CHRONO_CAP_MS)
    const text = formatDurationCompact((closed ?? 0) + span, spanMs >= CHRONO_CAP_MS)
    return { text, label: tr(locale, 'cols.time.active', { d: text }), empty: false }
  }
  if (closed === undefined) return emptyCell(unknown)
  const text = formatDurationCompact(closed)
  return { text, label: tr(locale, 'cols.time.active', { d: text }), empty: false }
}

/** The part of a session the duration needs. */
export interface SessionSpan {
  status: 'active' | 'completed'
  startTime: number
  lastActivityTime: number
  lastActivityUnknown?: boolean
  recordedStartTime?: number
  startTimeWatched?: boolean
}

/**
 * Duration of a session: elapsed since the start while it is active, start to last activity once it is
 * completed. The start is the one the transcript records (#365); when only the moment watching began is known,
 * the duration is a lower bound (≥) and its name says "watched for". Unknown (dash) when the end of a completed
 * session was never observed. While the relay is offline (`relayOffline`) an active session is not proven to
 * run: its duration stops at its last activity (#367).
 */
export function sessionTimeCell(s: SessionSpan, now: number, relayOffline = false, locale: Locale = 'en'): ColumnCell {
  const running = s.status === 'active' && !relayOffline
  const end = running ? now : s.lastActivityUnknown ? NaN : s.lastActivityTime
  const watched = s.recordedStartTime === undefined && s.startTimeWatched === true
  const ms = end - (s.recordedStartTime ?? s.startTime)
  if (!Number.isFinite(ms) || ms < 0) return emptyCell(tr(locale, 'cols.time.unknown'))
  const text = formatDurationCompact(ms)
  if (watched) {
    return { text: `≥${text}`, label: tr(locale, running ? 'cols.time.watchedRunning' : 'cols.time.watchedDone', { d: text }), empty: false }
  }
  const key = running ? 'cols.time.since' : s.status === 'active' ? 'cols.time.untilLast' : 'cols.time.long'
  return { text, label: tr(locale, key, { d: text }), empty: false }
}

/** Cost of an agent, session or branch total; a lower bound (≥), an estimate (~) or a replay loss (?) says so in words too. */
export function costCell(total: RollupTotal | null | undefined, locale: Locale = 'en'): ColumnCell {
  if (!total || total.known === 0) return emptyCell(tr(locale, 'cols.cost.none'))
  const money = formatCost(total.cost)
  // Always "~": the cost is the context priced at a blended rate, an estimate even on reported tokens (#364)
  // A cost is the context priced, as absolute as the tokens: under a replay loss "?" and "incomplete", never "≥" (#591)
  const mark = `${total.complete || total.replayLoss ? '' : '≥'}${COST_LABELS.mark}`
  // Same order as every other spoken cost: "context cost estimate $X", then what qualifies it
  const key = total.estimated
    ? (total.complete ? 'cols.cost.valueEstimated' : 'cols.cost.valueEstimatedIncomplete')
    : (total.complete ? 'cols.cost.value' : 'cols.cost.valueIncomplete')
  return { text: `${mark}${money}${total.replayLoss ? '?' : ''}`, label: tr(locale, key, { money }), empty: false }
}

/** Branch recorded at the start of the session; a dash when it was not recorded. */
export function branchCell(branch: string | undefined, locale: Locale = 'en'): ColumnCell {
  if (!branch) return emptyCell(tr(locale, 'cols.branch.none'))
  return { text: branch, label: tr(locale, 'cols.branch.value', { name: branch }), empty: false }
}

/** Runtime of the session, named like its badge (runtimeBadge); a dash when the source does not report it. */
export function runtimeCell(runtime: SessionInfo['runtime'], locale: Locale = 'en'): ColumnCell {
  const badge = runtimeBadge(runtime)
  if (!badge) return emptyCell(tr(locale, 'cols.runtime.none'))
  return { text: badge.label, label: tr(locale, 'cols.runtime.value', { name: badge.label }), empty: false }
}

/** Time since the last activity; a dash when the source only knows the start. */
export function activityCell(s: Pick<SessionInfo, 'lastActivityTime' | 'lastActivityUnknown'>, now: number, locale: Locale = 'en'): ColumnCell {
  if (s.lastActivityUnknown) return emptyCell(tr(locale, 'cols.activity.unknown'))
  // The same thresholds as formatRelativeTime, worded in the interface language (#501)
  const text = relativeTimeText(locale, s.lastActivityTime, now)
  return { text, label: tr(locale, 'cols.activity.value', { when: text }), empty: false }
}
