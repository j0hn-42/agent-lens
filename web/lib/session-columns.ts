/**
 * Cells of the Sessions panel columns (Name / Model / Tokens / Time). Pure (no React, no DOM, no
 * clock of its own): the figures come from the existing helpers (usage, cost-rollup, active-time,
 * model names) and are only given their compact, honest display form here.
 *
 * Principle: a column without data shows a dash AND an accessible name saying why (never a 0 or an
 * empty cell), and a figure that is a lower bound or an estimate says so in words for assistive tech.
 */
import { CHRONO_CAP_MS, ACTIVE_UNKNOWN_TEXT, type ActiveTimeFields } from './active-time'
import { isPseudoModel } from './model-provenance'
import { ROLLUP_INCOMPLETE_TEXT, type RollupTotal } from './cost-rollup'
import { USAGE_LABELS, formatTokenUsage, type UsageTotal } from './usage'
import { formatCost, formatModelName, formatTokens } from './utils'
import { formatRelativeTime } from './session-tree'
import type { SessionInfo } from './bridge-types'
import type { Freshness } from '../hooks/simulation/freshness'

/** Header labels, in column order. */
export const COLUMN_LABELS = {
  name: 'Name', model: 'Model', runtime: 'Runtime', branch: 'Branch', tokens: 'Tokens', cost: 'Cost', time: 'Time', activity: 'Activity',
} as const

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
export function modelCell(modelId: string | null | undefined): ColumnCell {
  if (!modelId || isPseudoModel(modelId)) return emptyCell('model not reported')
  const short = formatModelName(modelId)
  return { text: short, label: `model ${short}`, empty: false }
}

/** Compact tokens of one agent: "12k", with a lower-bound mark (≥) or an estimate mark (~) that is also spelled out. */
export function tokensCell(usage: UsageTotal): ColumnCell {
  if (usage.value === null || usage.status === 'unavailable') return emptyCell(`tokens ${USAGE_LABELS.unavailable}`)
  const mark = `${usage.status === 'partial' ? '≥' : ''}${usage.estimated ? '~' : ''}`
  return { text: `${mark}${formatTokens(usage.value)}`, label: `${formatTokenUsage(usage)} tokens`, empty: false }
}

/** Compact tokens of a session or branch total; the incomplete badge is spelled out. */
export function rollupTokensCell(total: RollupTotal | null | undefined): ColumnCell {
  if (!total || total.known === 0) return emptyCell(`tokens ${USAGE_LABELS.unavailable}`)
  const mark = `${total.complete ? '' : '≥'}${total.estimated ? '~' : ''}`
  const words = [`${formatTokens(total.tokens)} tokens`, total.estimated ? USAGE_LABELS.estimated : '', total.complete ? '' : ROLLUP_INCOMPLETE_TEXT.replace(/[()]/g, '')]
  return { text: `${mark}${formatTokens(total.tokens)}`, label: words.filter(Boolean).join(' '), empty: false }
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
export function agentTimeCell(agent: ActiveTimeFields, freshness: Freshness, spanMs: number): ColumnCell {
  const closed = typeof agent.activeMs === 'number' && Number.isFinite(agent.activeMs) ? Math.max(0, agent.activeMs) : undefined
  if (typeof agent.activeSince === 'number') {
    if (freshness !== 'fresh') return emptyCell(ACTIVE_UNKNOWN_TEXT)
    const span = Math.min(Math.max(0, spanMs), CHRONO_CAP_MS)
    const text = formatDurationCompact((closed ?? 0) + span, spanMs >= CHRONO_CAP_MS)
    return { text, label: `${text} active`, empty: false }
  }
  if (closed === undefined) return emptyCell(ACTIVE_UNKNOWN_TEXT)
  const text = formatDurationCompact(closed)
  return { text, label: `${text} active`, empty: false }
}

/** The part of a session the duration needs. */
export interface SessionSpan {
  status: 'active' | 'completed'
  startTime: number
  lastActivityTime: number
  lastActivityUnknown?: boolean
}

/**
 * Duration of a session: elapsed since the start while it is active, start to last activity once it is
 * completed. Unknown (dash) when the end of a completed session was never observed.
 */
export function sessionTimeCell(s: SessionSpan, now: number): ColumnCell {
  const end = s.status === 'active' ? now : s.lastActivityUnknown ? NaN : s.lastActivityTime
  const ms = end - s.startTime
  if (!Number.isFinite(ms) || ms < 0) return emptyCell('duration unknown')
  const text = formatDurationCompact(ms)
  return { text, label: `${text} ${s.status === 'active' ? 'since start' : 'long'}`, empty: false }
}

/** Cost of an agent, session or branch total; a lower bound (≥) or an estimate (~) says so in words too. */
export function costCell(total: RollupTotal | null | undefined): ColumnCell {
  if (!total || total.known === 0) return emptyCell('cost unknown')
  const money = formatCost(total.cost)
  const mark = `${total.complete ? '' : '≥'}${total.estimated ? '~' : ''}`
  const words = [`${money} cost`, total.estimated ? USAGE_LABELS.estimated : '', total.complete ? '' : ROLLUP_INCOMPLETE_TEXT.replace(/[()]/g, '')]
  return { text: `${mark}${money}`, label: words.filter(Boolean).join(' '), empty: false }
}

/** Branch recorded at the start of the session; a dash when it was not recorded. */
export function branchCell(branch: string | undefined): ColumnCell {
  if (!branch) return emptyCell('branch not recorded')
  return { text: branch, label: `branch ${branch}`, empty: false }
}

/** Runtime of the session (Claude Code or Codex); a dash when the source does not report it. */
export function runtimeCell(runtime: SessionInfo['runtime']): ColumnCell {
  if (!runtime) return emptyCell('runtime not reported')
  const text = runtime === 'codex' ? 'Codex' : 'Claude'
  return { text, label: `runtime ${runtime === 'codex' ? 'Codex' : 'Claude Code'}`, empty: false }
}

/** Time since the last activity; a dash when the source only knows the start. */
export function activityCell(s: Pick<SessionInfo, 'lastActivityTime' | 'lastActivityUnknown'>, now: number): ColumnCell {
  if (s.lastActivityUnknown) return emptyCell('activity unknown')
  const text = formatRelativeTime(s.lastActivityTime, now)
  return { text, label: `last activity ${text}`, empty: false }
}
