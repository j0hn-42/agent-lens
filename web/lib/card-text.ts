/**
 * Words of the agent card and of the Sessions panel in the active language (#502).
 *
 * Only the language of a text is decided here: every number, count and qualifier ("at least", "estimated",
 * "not reported", "incomplete") comes from the same inputs and the same conditions as the English helpers
 * these functions mirror (loop-detection, delegation-report, usage, event-loss, freshness, git labels of
 * ui-glossary, session-tree); scripts/card-text.test.ts checks that the English output is identical.
 * Pure: no React, no DOM; relative imports only so node:test can load it.
 */
import { translate, type Locale, type MessageKey } from './messages'
import { formatCost, formatDuration, formatTokens } from './utils'
import { GIT_STRIP_MAX_COMMITS, GIT_STRIP_MAX_PRS } from './git-state'
import { CHRONO_CAP_MS, formatActiveSince, type ActiveTimeFields } from './active-time'
import type { UsageTotal } from './usage'
import { formatRollup, type RollupTotal } from './cost-rollup'
import { getActivityLabel } from './state-labels'
import { sessionHealthText } from './loop-detection'
import { SESSION_STATUS_TEXT, formatTeamSummary } from './chrome-utils'
import { SESSION_NOT_OBSERVED_HELP, SESSION_INDEXED_HELP, SESSION_IMPORTED_HELP, SESSION_OFFLINE_HELP } from './session-model'
import { tokensText } from './delegation-report'
import type { SessionAttention } from './attention'
import type { Freshness, Silence } from '../hooks/simulation/freshness'
import type { HealthVerdict, LoopFinding } from './loop-detection'
import type { DelegationDuration, DelegationResult, DelegationRow } from './delegation-report'
import type { IssueLink } from './issue-links'
import type { ModelBadgeKind } from './model-provenance'
import { COST_LABELS, GIT_STRIP_LABELS, type GroupKind } from './ui-glossary'

type Params = Readonly<Record<string, string | number>>
const tr = (locale: Locale, key: MessageKey, params?: Params) => translate(locale, key, params)

/** Noun phrases that have a "one" and an "other" form in the catalog (count.<noun>.one / .other) */
type CountNoun = 'tool' | 'toolError' | 'toolCall' | 'earlierEvent' | 'file' | 'subAgent' | 'member'

/** "1 tool", "3 tools" (French: 0 and 1 are singular, as the language does). */
function countText(locale: Locale, noun: CountNoun, n: number): string {
  const rule = new Intl.PluralRules(locale).select(n) === 'one' ? 'one' : 'other'
  return tr(locale, `count.${noun}.${rule}` as MessageKey, { n })
}

/** Same word in both languages ("session", "agent"): only the plural mark follows the count. */
export function sharedNounCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`
}

/** Plural form of a message that exists as <key>.one / <key>.other */
function pluralKey(locale: Locale, base: string, n: number, params: Params = {}): string {
  const rule = new Intl.PluralRules(locale).select(n) === 'one' ? 'one' : 'other'
  return tr(locale, `${base}.${rule}` as MessageKey, { n, ...params })
}

// ---- usage

/** A usage figure with its qualifier, as usage.qualify does: "at least 5k estimated", "not reported". */
export function usageText(locale: Locale, usage: UsageTotal): string {
  if (usage.value === null || usage.status === 'unavailable') return tr(locale, 'usage.unavailable')
  return qualifiedText(locale, usage, formatTokens(usage.value))
}

/** A cost figure with its qualifier, as formatCostUsage does ("at least ~$6.00 estimated"), in the language. */
export function costUsageText(locale: Locale, usage: UsageTotal): string {
  if (usage.value === null || usage.status === 'unavailable') return tr(locale, 'usage.unavailable')
  return qualifiedText(locale, usage, `${COST_LABELS.mark}${formatCost(usage.value)}`)
}

function qualifiedText(locale: Locale, usage: UsageTotal, v: string): string {
  if (usage.incomplete) return tr(locale, usage.estimated ? 'usage.incompleteEstimated' : 'usage.incomplete', { v })
  if (usage.status === 'partial') return tr(locale, usage.estimated ? 'usage.partialEstimated' : 'usage.partial', { v })
  return usage.estimated ? tr(locale, 'usage.estimated', { v }) : v
}

/** The Σ total of the Sessions panel (#501): same figures, same qualifiers, the words follow the language. */
export function rollupText(total: RollupTotal, locale: Locale): string {
  return formatRollup(total, {
    unknown: tr(locale, 'rollup.unknown'),
    incomplete: tr(locale, 'rollup.incomplete'),
    estimated: tr(locale, 'rollup.estimated'),
  })
}

/** What the incomplete badge of a total means, in the interface language. */
export function rollupIncompleteHelp(locale: Locale): string {
  return tr(locale, 'rollup.incompleteHelp')
}

// ---- states

const STATE_KEYS = ['idle', 'thinking', 'tool_calling', 'complete', 'error', 'paused', 'waiting_permission'] as const
const ACTIVITY_KEYS = ['working', 'idle', 'done'] as const

export function stateText(locale: Locale, state: string): string {
  return (STATE_KEYS as readonly string[]).includes(state) ? tr(locale, `state.${state}` as MessageKey) : state.replace(/_/g, ' ')
}

export function activityText(locale: Locale, activity: string): string {
  // English keeps its original helper: nothing about it can drift
  if (locale === 'en') return getActivityLabel(activity)
  return (ACTIVITY_KEYS as readonly string[]).includes(activity) ? tr(locale, `activity.${activity}` as MessageKey) : activity.replace(/_/g, ' ')
}

export function lastKnownStateText(locale: Locale, state: string): string {
  return tr(locale, 'card.lastKnownState', { state: stateText(locale, state) })
}

export function freshnessText(locale: Locale, f: Freshness, fromHistory = false): string {
  if (f === 'stale' && fromHistory) return tr(locale, 'card.freshness.history')
  const key: Record<Freshness, MessageKey> = {
    fresh: 'card.freshness.fresh', stale: 'card.freshness.stale', interrupted: 'card.freshness.interrupted',
    error: 'card.freshness.error', closed: 'card.freshness.closed', 'never-observed': 'card.freshness.neverObserved',
  }
  return tr(locale, key[f])
}

function silentFor(ms: number): string {
  const total = Math.floor(ms / 60_000)
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h} h ${m} min` : `${m} min`
}

export function silenceText(locale: Locale, silence: Silence, state: string): string {
  const duration = silentFor(silence.ms)
  return silence.kind === 'permission'
    ? tr(locale, 'card.silence.permission', { duration })
    : tr(locale, 'card.silence.silent', { state: stateText(locale, state), duration })
}

export function lastEventText(locale: Locale, at: number | undefined, source: 'live' | 'history' | 'imported' | undefined, clock: (ms: number) => string): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return tr(locale, 'card.noEvent')
  if (source === 'history') return tr(locale, 'card.historyReceived', { time: clock(at) })
  return tr(locale, source === 'imported' ? 'card.lastEventImported' : 'card.lastEvent', { time: clock(at) })
}

export function goneText(locale: Locale, name: string | null): string {
  return name === null ? tr(locale, 'card.gone.unnamed') : tr(locale, 'card.gone', { name })
}

// ---- counts that become a lower bound when events were lost (#366)

/** "3 tools", "at least 3 tools", "no tool observed (incomplete)" */
export function boundedCountText(locale: Locale, n: number, lost: number, noun: 'tool' | 'toolError'): string {
  if (!(lost > 0)) return countText(locale, noun, n)
  if (n === 0) return tr(locale, noun === 'tool' ? 'count.noToolObserved' : 'count.noToolErrorObserved')
  return tr(locale, 'count.atLeast', { count: countText(locale, noun, n) })
}

export function replayLostText(locale: Locale, lost: number): string {
  if (!(lost > 0)) return ''
  return lost === 1 ? tr(locale, 'card.replayLost.one') : tr(locale, 'card.replayLost.other', { n: lost })
}

// ---- active time

export function activeSummaryText(locale: Locale, agent: ActiveTimeFields, freshness: Freshness, spanMs: number): string {
  const closed = typeof agent.activeMs === 'number' && Number.isFinite(agent.activeMs) ? agent.activeMs : undefined
  if (typeof agent.activeSince === 'number') {
    if (freshness !== 'fresh') return tr(locale, 'card.active.unknown')
    const span = Math.min(Math.max(0, spanMs), CHRONO_CAP_MS)
    const head = formatActiveSince(span, spanMs >= CHRONO_CAP_MS)
    return closed
      ? tr(locale, 'card.active.runningTotal', { span: head, total: formatActiveSince(closed + span) })
      : tr(locale, 'card.active.running', { span: head })
  }
  return closed === undefined ? tr(locale, 'card.active.unknown') : tr(locale, 'card.active.closed', { total: formatActiveSince(closed) })
}

// ---- loop health (#230)

export function healthText(locale: Locale, v: HealthVerdict): string {
  switch (v.status) {
    case 'loop': return tr(locale, 'card.health.loop')
    case 'unknown': return tr(locale, 'card.health.unknown')
    case 'clear': return tr(locale, 'card.health.clear', { calls: countText(locale, 'toolCall', v.calls) })
    case 'incomplete': {
      const calls = countText(locale, 'toolCall', v.calls)
      const parts = [v.comparable < v.calls ? tr(locale, 'card.health.comparable', { comparable: v.comparable, calls }) : calls]
      if (v.dropped > 0) parts.push(tr(locale, 'card.health.dropped'))
      if (v.lostEvents > 0) parts.push(tr(locale, 'card.health.lostEvents', { events: tr(locale, 'count.atLeast', { count: countText(locale, 'earlierEvent', v.lostEvents) }) }))
      return tr(locale, 'card.health.incomplete', { parts: parts.join('; ') })
    }
  }
}

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(i + 1) : path
}

export function findingText(locale: Locale, f: LoopFinding): string {
  const times = f.atLeast ? tr(locale, 'card.finding.timesAtLeast', { count: f.count }) : `${f.count}×`
  return f.kind === 'repeat'
    ? tr(locale, 'card.finding.repeat', { tool: f.toolName, times })
    : tr(locale, 'card.finding.editCycle', { times, file: baseName(f.path) })
}

export function sessionLoopText(locale: Locale, v: HealthVerdict | undefined): string | null {
  if (locale === 'en') return sessionHealthText(v)
  return v?.status === 'loop' ? tr(locale, 'sessions.health.loop') : null
}

// ---- git strip (#386)

export function gitLabels(locale: Locale) {
  return {
    title: tr(locale, 'card.git.title'),
    lost: tr(locale, 'card.git.lost'),
    newTab: tr(locale, 'card.git.newTab'),
    branch: tr(locale, 'card.git.branch'),
    detached: tr(locale, 'card.git.detached'),
    /** Names of git commands: identifiers, not translated */
    sources: GIT_STRIP_LABELS.sources,
    seen: (elapsed: string) => tr(locale, 'card.git.seen', { elapsed }),
    commits: (n: number, incomplete: boolean) => pluralKey(locale, incomplete ? 'card.git.commitsIncomplete' : 'card.git.commits', n),
    commitsList: tr(locale, 'card.git.commitsList'),
    amended: tr(locale, 'card.git.amended'),
    omittedCommits: (n: number) => pluralKey(locale, 'card.git.omittedCommits', n, { max: GIT_STRIP_MAX_COMMITS }),
    prsList: tr(locale, 'card.git.prsList'),
    pr: (n: number, repo: string | null) => (repo === null ? tr(locale, 'card.git.prNoRepo', { n }) : `PR #${n} (${repo})`),
    prStates: {
      created: tr(locale, 'card.git.pr.created'), open: tr(locale, 'card.git.pr.open'), draft: tr(locale, 'card.git.pr.draft'),
      merged: tr(locale, 'card.git.pr.merged'), closed: tr(locale, 'card.git.pr.closed'),
    },
    omittedPrs: (n: number) => pluralKey(locale, 'card.git.omittedPrs', n, { max: GIT_STRIP_MAX_PRS }),
  } as const
}

// ---- delegation report (#233)

export function delegationCountText(locale: Locale, n: number, lost = 0): string {
  const count = countText(locale, 'subAgent', n)
  return lost > 0 ? tr(locale, 'count.atLeast', { count }) : count
}

export function filesReadText(locale: Locale, row: Pick<DelegationRow, 'filesReadCount' | 'readsNotConfirmed'>, lost = 0): string {
  const bounded = lost > 0
  if (row.filesReadCount === 0 && row.readsNotConfirmed === 0) return tr(locale, bounded ? 'card.files.noneIncomplete' : 'card.files.none')
  const files = countText(locale, 'file', row.filesReadCount)
  const read = row.filesReadCount > 0
    ? (bounded ? tr(locale, 'count.atLeast', { count: files }) : files)
    : tr(locale, bounded ? 'card.files.noneConfirmedIncomplete' : 'card.files.noneConfirmed')
  return row.readsNotConfirmed > 0
    ? tr(locale, bounded ? 'card.files.notConfirmedAtLeast' : 'card.files.notConfirmed', { read, n: row.readsNotConfirmed })
    : read
}

/** Tokens of a delegation row, qualified ("at least 1.2k estimated", "not reported"). */
export function delegationTokensText(locale: Locale, row: Pick<DelegationRow, 'tokens'>): string {
  return locale === 'en' ? tokensText(row) : usageText(locale, row.tokens)
}

export function durationText(locale: Locale, d: DelegationDuration, lost = 0): string {
  switch (d.kind) {
    case 'measured': return tr(locale, 'card.duration.measured', { duration: formatDuration(d.seconds) })
    case 'recorded': return tr(locale, 'card.duration.recorded', { duration: formatDuration(d.seconds) })
    case 'not-reported': return tr(locale, 'usage.unavailable')
    case 'not-returned': return tr(locale, lost > 0 ? 'card.duration.noReturnIncomplete' : 'card.duration.noReturn')
  }
}

export function resultText(locale: Locale, r: DelegationResult, lost = 0): string {
  if (r.kind === 'not-returned') {
    if (lost > 0) return tr(locale, r.finished ? 'card.result.finishedNoReturnIncomplete' : 'card.result.noReturnIncomplete')
    return tr(locale, r.finished ? 'card.result.finishedNoReturn' : 'card.result.noReturn')
  }
  const text = r.excerpt.trim() ? `${r.excerpt}${r.truncated ? '…' : ''}` : tr(locale, 'card.result.emptyError')
  return r.kind === 'error' ? tr(locale, 'card.result.error', { text }) : r.excerpt.trim() ? text : tr(locale, 'card.result.emptyReturned')
}

// ---- model, group, issue links

export function modelBadgeText(locale: Locale, kind: ModelBadgeKind): string {
  return tr(locale, `card.badge.${kind === 'mismatch' ? 'mismatch' : kind}` as MessageKey)
}

/** "Team alpha" / "Workflow tempo": Workflow is the name of the Claude Code tool and stays as it is. */
export function groupHeadingText(locale: Locale, kind: GroupKind | undefined, title: string): string {
  return kind === 'workflow' ? `Workflow ${title}` : tr(locale, 'card.group.team', { title })
}

export function issueLinkText(locale: Locale, link: IssueLink): string {
  const prefix = link.kind === 'pr' ? 'PR' : 'Issue'
  const draft = link.draft ? ` ${locale === 'fr' ? '(brouillon)' : '(draft)'}` : ''
  return `${prefix} #${link.number}${draft}${link.title ? ` ${link.title}` : ''}`
}

// ---- Sessions panel

export function teamSummaryText(locale: Locale, teamName: string, members: number, working: number, kind?: GroupKind): string {
  if (locale === 'en') return formatTeamSummary(teamName, members, working, kind)
  const noun = kind === 'workflow' ? sharedNounCount(members, 'agent') : countText(locale, 'member', members)
  return tr(locale, 'sessions.team.summary', { heading: groupHeadingText(locale, kind, teamName), members: noun, working })
}

/** The attention count of a session ("2 agents waiting / 1 agent in error", the words of the top bar); null when nothing is waiting and nothing failed. */
export function sessionAttentionLabel(locale: Locale, a: SessionAttention | undefined): string | null {
  if (!a) return null
  return attentionCounterText(locale, a.waiting, a.errors) || null
}

/**
 * What the attention counter of the top bar draws: "2 agents waiting / 1 agent in error". Spelled out (never "2 waiting"):
 * the number alone does not say what is counted. Zero parts are left out; empty when nothing is blocked. The one
 * composition of this text: the top bar re-exports it (top-bar-text.ts), the Sessions panel uses it per session.
 */
export function attentionCounterText(locale: Locale, waiting: number, errors: number): string {
  const parts: string[] = []
  if (waiting > 0) parts.push(pluralKey(locale, 'topbar.attention.waiting', waiting))
  if (errors > 0) parts.push(pluralKey(locale, 'topbar.attention.error', errors))
  return parts.join(' / ')
}

/** Same thresholds as session-tree.formatRelativeTime. */
export function relativeTimeText(locale: Locale, timestamp: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (!Number.isFinite(sec) || sec < 5) return tr(locale, 'sessions.relative.now')
  if (sec < 60) return tr(locale, 'sessions.relative.sec', { n: sec })
  if (sec < 3600) return tr(locale, 'sessions.relative.min', { n: Math.floor(sec / 60) })
  if (sec < 86400) return tr(locale, 'sessions.relative.hour', { n: Math.floor(sec / 3600) })
  return tr(locale, 'sessions.relative.day', { n: Math.floor(sec / 86400) })
}

export type SessionStatusKey = 'new-activity' | 'active' | 'completed' | 'unobserved' | 'indexed' | 'imported' | 'offline'

export function sessionStatusText(locale: Locale, kind: SessionStatusKey): string {
  if (locale === 'en') return SESSION_STATUS_TEXT[kind]
  return tr(locale, `sessions.status.${kind}` as MessageKey)
}

export function sessionStatusHelp(locale: Locale, kind: 'unobserved' | 'indexed' | 'imported' | 'offline'): string {
  if (locale === 'en') return { unobserved: SESSION_NOT_OBSERVED_HELP, indexed: SESSION_INDEXED_HELP, imported: SESSION_IMPORTED_HELP, offline: SESSION_OFFLINE_HELP }[kind]
  return tr(locale, `sessions.help.${kind}` as MessageKey)
}

/** "3 sessions shown": what a search or a filter announces to a screen reader */
export function sessionsShownText(locale: Locale, n: number): string {
  return pluralKey(locale, 'sessions.announce.shown', n)
}

/** "Filter cleared: 3 sessions shown" */
export function filterClearedText(locale: Locale, n: number): string {
  return pluralKey(locale, 'sessions.announce.cleared', n)
}
