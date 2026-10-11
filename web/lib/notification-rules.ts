/**
 * Configurable notification triggers (#225). Pure (no React, no browser API).
 *
 * Four rules the user switches on or off: an agent waits for a permission, an agent is in error, a session finished,
 * the session cost reached a threshold. `evaluateTriggers` compares two snapshots and returns what is new; nothing is
 * announced for a state that was already there (the first snapshot is only a baseline). Every sentence is built from a
 * figure or a status the app already proves: a cost keeps its qualification ("at least", "estimated"), an unknown cost
 * never triggers, a session first seen as completed (history) is never announced as finished.
 */
import { formatAttention } from './attention'
import { formatCostUsage, type UsageTotal } from './usage'
import { formatCost } from './utils'

/** localStorage key of the rules (per browser; the master opt-in keeps its own key in use-attention-alerts) */
export const NOTIFY_RULES_STORAGE_KEY = 'agent-lens:notify-rules'

/** Largest threshold accepted, in USD: a typo like 1e9 must not silently disable the rule */
export const COST_THRESHOLD_MAX = 10_000

export interface NotificationRules {
  /** An agent starts waiting for a permission */
  permission: boolean
  /** An agent goes into error */
  error: boolean
  /** A session goes from active to completed */
  complete: boolean
  /** The session cost reaches `costThresholdUsd` */
  cost: boolean
  costThresholdUsd: number
}

/** Permission and error on: what the opt-in notification already announced (#126). */
export const DEFAULT_RULES: NotificationRules = Object.freeze({
  permission: true, error: true, complete: false, cost: false, costThresholdUsd: 5,
})

function isThreshold(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= COST_THRESHOLD_MAX
}

/** Reads the stored rules: any missing, mistyped or out-of-range field falls back to its default. */
export function parseRules(raw: unknown): NotificationRules {
  let data: unknown = raw
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw) } catch { return { ...DEFAULT_RULES } }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ...DEFAULT_RULES }
  const o = data as Record<string, unknown>
  const flag = (k: 'permission' | 'error' | 'complete' | 'cost') => (typeof o[k] === 'boolean' ? (o[k] as boolean) : DEFAULT_RULES[k])
  return {
    permission: flag('permission'),
    error: flag('error'),
    complete: flag('complete'),
    cost: flag('cost'),
    costThresholdUsd: isThreshold(o.costThresholdUsd) ? o.costThresholdUsd : DEFAULT_RULES.costThresholdUsd,
  }
}

export function serializeRules(rules: NotificationRules): string {
  return JSON.stringify(rules)
}

/** Text typed in the threshold field: a positive amount up to the cap, otherwise null (refused, never clamped). */
export function parseCostThreshold(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return isThreshold(n) ? n : null
}

export interface SessionStatusEntry { label: string; status: 'active' | 'completed' }

/** What the evaluation looks at, taken at one instant. */
export interface NotifySnapshot {
  waitingIds: ReadonlySet<string>
  errorIds: ReadonlySet<string>
  sessions: ReadonlyMap<string, SessionStatusEntry>
  cost: UsageTotal
}

export function emptySnapshot(): NotifySnapshot {
  return { waitingIds: new Set(), errorIds: new Set(), sessions: new Map(), cost: { value: null, status: 'unavailable', estimated: false } }
}

/** `attention` covers the permission and error rules (one message), the others are one trigger each. */
export type NotifyTrigger = 'attention' | 'complete' | 'cost'

export interface NotifyItem {
  trigger: NotifyTrigger
  title: string
  body: string
}

export const NOTIFY_TITLE = 'Agent Lens'

const hasNew = (before: ReadonlySet<string>, now: ReadonlySet<string>): boolean => {
  for (const id of now) if (!before.has(id)) return true
  return false
}

/** What is new between two snapshots, for the enabled rules. `prev` null is the baseline: nothing is announced. */
export function evaluateTriggers(prev: NotifySnapshot | null, cur: NotifySnapshot, rules: NotificationRules): NotifyItem[] {
  if (!prev) return []
  const items: NotifyItem[] = []

  const freshWaiting = rules.permission && hasNew(prev.waitingIds, cur.waitingIds)
  const freshError = rules.error && hasNew(prev.errorIds, cur.errorIds)
  if (freshWaiting || freshError) {
    const body = formatAttention(rules.permission ? cur.waitingIds.size : 0, rules.error ? cur.errorIds.size : 0)
    if (body) items.push({ trigger: 'attention', title: NOTIFY_TITLE, body })
  }

  if (rules.complete) {
    const finished: string[] = []
    for (const [id, entry] of cur.sessions) {
      if (entry.status === 'completed' && prev.sessions.get(id)?.status === 'active') finished.push(entry.label)
    }
    if (finished.length === 1) items.push({ trigger: 'complete', title: NOTIFY_TITLE, body: `Session finished: ${finished[0]}` })
    else if (finished.length > 1) items.push({ trigger: 'complete', title: NOTIFY_TITLE, body: `${finished.length} sessions finished` })
  }

  if (rules.cost && cur.cost.value !== null && cur.cost.status !== 'unavailable') {
    const before = prev.cost.value ?? 0
    if (before < rules.costThresholdUsd && cur.cost.value >= rules.costThresholdUsd) {
      items.push({
        trigger: 'cost',
        title: NOTIFY_TITLE,
        body: `Cost reached ${formatCostUsage(cur.cost)} (threshold ${formatCost(rules.costThresholdUsd)})`,
      })
    }
  }
  return items
}
