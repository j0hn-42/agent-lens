/**
 * Words of the Conversation, Context and Files panels in the active language (#373).
 *
 * Only the language of a text is decided here: every number, count and qualifier ("at least", "estimated",
 * "incomplete", "not reported") comes from the same inputs and the same conditions as the English helpers these
 * functions mirror (waste, file-conflicts, event-loss, pair-filter, session-work, comms-export, chrome-utils);
 * scripts/panel-text-i18n.test.ts checks that the English output is identical.
 * Pure: no React, no DOM; relative imports only so node:test can load it.
 */
import { translate, type Locale, type MessageKey } from './messages'
import { FILE_TIMELINE_MAX_STEPS } from './file-timeline'
import type { UsageTotal } from './usage'
import type { WasteItem, RepeatsDisclosure } from './waste'
import type { FileConflict } from './file-conflicts'
import type { ChecksSummary } from './session-work'
import type { PairState } from './pair-filter'
import type { CommKind, TeamChipGroup } from './feed-utils'
import type { ResumeUnavailableReason } from './resume-command'
import { formatTokens } from './utils'
import { replayLostText } from './card-text'

type Params = Readonly<Record<string, string | number>>

/** Attributes of a piece of data that reaches the panels as it came (file name, message or tool text): no language of ours. */
export const DATA_EN = { lang: 'en', 'data-i18n-exempt': '' } as const

/** `translate`, under a short name for the panels. */
export function t(locale: Locale, key: MessageKey, params?: Params): string {
  return translate(locale, key, params)
}

/** Plural form of a message that exists as <base>.one / <base>.other (French: 0 and 1 are singular). */
export function pluralText(locale: Locale, base: string, n: number, params: Params = {}): string {
  const rule = new Intl.PluralRules(locale).select(n) === 'one' ? 'one' : 'other'
  return translate(locale, `${base}.${rule}` as MessageKey, { n, ...params })
}

/** A message that embeds data (a path): the text before and after the slot, so the caller can mark the data lang="en". */
export function splitAround(locale: Locale, key: MessageKey, param: string): [string, string] {
  const [before = '', after = ''] = t(locale, key, { [param]: '\u0001' }).split('\u0001')
  return [before, after]
}

// ---- Conversation

export function messageCountText(locale: Locale, total: number, shown?: number): string {
  return shown === undefined ? pluralText(locale, 'conv.count', total) : pluralText(locale, 'conv.count.search', total, { shown, total })
}

/** "... 12 older messages dropped": null when nothing was dropped (the English helper is chrome-utils.formatDroppedMessages). */
export function droppedText(locale: Locale, dropped: number): string | null {
  return dropped > 0 ? pluralText(locale, 'conv.dropped', dropped) : null
}

export function newMessagesText(locale: Locale, n: number): string {
  return pluralText(locale, 'conv.new', n)
}

const RUNTIME_ROLE: Record<string, string> = { codex: 'CODEX', copilot: 'COPILOT', pi: 'PI', gemini: 'GEMINI', opencode: 'OPENCODE' }

/** Role label of a conversation message: the assistant is named after the runtime of the agent that spoke (product names stay). */
export function roleLabelText(locale: Locale, type: string, runtime: string | undefined): string {
  if (type === 'assistant' && runtime && RUNTIME_ROLE[runtime]) return RUNTIME_ROLE[runtime]
  if (type === 'thinking') return t(locale, 'conv.role.thinking')
  if (type === 'user') return t(locale, 'conv.role.user')
  if (type === 'compaction') return t(locale, 'conv.role.compaction')
  return 'CLAUDE'
}

const COMM_KEY: Record<CommKind, MessageKey> = {
  dispatch: 'conv.comm.dispatch', return: 'conv.comm.return', return_error: 'conv.comm.returnError', message: 'conv.comm.message',
}

export function commLabelText(locale: Locale, kind: CommKind): string {
  return t(locale, COMM_KEY[kind])
}

/** Hierarchy term of an agent (Main, Agent, Subagent, Teammate). */
export function hierarchyTermText(locale: Locale, agent: { kind?: string; isMain?: boolean }): string {
  if (agent.kind === 'teammate') return t(locale, 'conv.hier.teammate')
  if (agent.kind === 'subagent') return t(locale, 'conv.hier.subagent')
  return t(locale, agent.isMain ? 'conv.hier.main' : 'conv.hier.agent')
}

/** Visible heading and accessible name of a team / workflow chip group, in the language of the panel. */
export function teamChipTexts<T>(locale: Locale, g: Pick<TeamChipGroup<T>, 'kind' | 'name' | 'items' | 'sessionHint'>): { heading: string; label: string } {
  const base = g.kind === 'workflow' ? `Workflow ${g.name}` : t(locale, 'card.group.team', { title: g.name })
  const heading = g.sessionHint ? `${base} ${t(locale, 'conv.team.sessionHint', { id: g.sessionHint })}` : base
  const n = g.items.length
  const noun = g.kind === 'workflow' ? pluralText(locale, 'count.agent', n) : pluralText(locale, 'count.member', n)
  return { heading, label: `${heading}, ${noun}` }
}

export function copiedText(locale: Locale, label: string, truncatedChars: number, redactions: number): string {
  const masked = redactions > 0 ? pluralText(locale, 'conv.copied.redacted', redactions) : ''
  const cut = truncatedChars > 0 ? t(locale, 'conv.copied.cut', { n: truncatedChars }) : ''
  return `${t(locale, 'conv.copied', { label })}${masked}${cut}`
}

export function exportSavedText(locale: Locale, redactions: number): string {
  const masked = redactions > 0 ? pluralText(locale, 'conv.copied.redacted', redactions) : ''
  return `${t(locale, 'conv.exported')}${masked}`
}

// ---- Pair filter

/** Chip text: names joined by a double arrow, "..." for a slot not chosen yet (the same in both languages). */
export function pairChipLabelText(p: PairState, nameOf: (key: string) => string): string {
  const first = p.a !== '' ? nameOf(p.a) : '...'
  const second = p.b !== '' ? nameOf(p.b) : '...'
  return `${first} ↔ ${second}`
}

export function pairSpokenText(locale: Locale, p: PairState, nameOf: (key: string) => string): string {
  const none = t(locale, 'pair.noAgent')
  return t(locale, 'pair.and', { a: p.a !== '' ? nameOf(p.a) : none, b: p.b !== '' ? nameOf(p.b) : none })
}

const pairSet = (p: PairState) => p.a !== '' || p.b !== ''
const pairComplete = (p: PairState) => p.a !== '' && p.b !== '' && p.a !== p.b

export function pairAnnouncementText(locale: Locale, p: PairState, nameOf: (key: string) => string, count: number): string {
  if (!pairSet(p)) return t(locale, 'pair.cleared')
  if (p.a !== '' && p.a === p.b) return t(locale, 'pair.different')
  if (!pairComplete(p)) return t(locale, 'pair.started', { name: nameOf(p.a || p.b) })
  const who = pairSpokenText(locale, p, nameOf)
  return count === 0 ? t(locale, 'pair.none', { who }) : pluralText(locale, 'pair.showing', count, { who })
}

export function pairEmptyTextT(locale: Locale, p: PairState, nameOf: (key: string) => string): string {
  return t(locale, 'pair.none', { who: pairSpokenText(locale, p, nameOf) })
}

// ---- Tokens

/** "at least 5k estimated tokens": the figure of qualify() + the word "tokens", in the language of the panel. Callers handle an unavailable figure. */
export function tokensSpoken(locale: Locale, usage: UsageTotal): string {
  if (usage.value === null || usage.status === 'unavailable') return t(locale, 'tok.unavailable')
  const v = formatTokens(usage.value, locale)
  if (usage.status === 'partial') return t(locale, usage.estimated ? 'tok.partialEstimated' : 'tok.partial', { v })
  return t(locale, usage.estimated ? 'tok.estimated' : 'tok.plain', { v })
}

// ---- Files panel

/** "at least 3 conflicts" / "2 conflicts" / "No conflict in the observed part" / null (nothing to say). */
export function conflictHeadingText(locale: Locale, count: number, lost: number): string | null {
  if (count > 0) {
    const text = pluralText(locale, 'files.conflicts.count', count)
    return lost > 0 ? t(locale, 'count.atLeast', { count: text }) : text
  }
  return lost > 0 ? t(locale, 'files.conflicts.noneObserved') : null
}

/** "edited by alpha (session Main): 2 successful edits; beta ...: 1 successful edit" */
export function conflictEditorsText(locale: Locale, conflict: FileConflict, label: (agentKey: string) => string): string {
  const parts = conflict.editors.map(e => pluralText(locale, 'files.editor', e.edits, { agent: label(e.agent) }))
  return t(locale, 'files.editedBy', { parts: parts.join(locale === 'fr' ? ' ; ' : '; ') })
}

/** A count of files over a graph that may be incomplete: "at least 3 files", "no file observed (incomplete)". */
export function boundedFilesText(locale: Locale, n: number, lost: number): string {
  if (!(lost > 0)) return pluralText(locale, 'count.file', n)
  if (n === 0) return t(locale, 'files.noneObserved')
  return t(locale, 'count.atLeast', { count: pluralText(locale, 'count.file', n) })
}

/** What is missing, as a lower bound; empty when nothing is. */
export function lostSentence(locale: Locale, lost: number): string {
  return replayLostText(locale, lost)
}

export function succeededNoteText(locale: Locale, started: number, perAgent: readonly { succeeded: number }[] | undefined): string {
  if (!perAgent) return ''
  const succeeded = perAgent.reduce((s, a) => s + a.succeeded, 0)
  return succeeded < started ? pluralText(locale, 'files.succeeded', succeeded) : ''
}

export function fileTimelineText(locale: Locale) {
  return {
    kinds: { read: t(locale, 'files.tl.read'), edited: t(locale, 'files.tl.edited'), written: t(locale, 'files.tl.written') } as const,
    noCallId: t(locale, 'files.tl.noCallId'),
    noCommits: t(locale, 'files.tl.noCommits'),
    summary: (n: number, incomplete: boolean) => pluralText(locale, incomplete ? 'files.tl.summaryLost' : 'files.tl.summary', n),
    summaryOf: (path: string) => ` ${t(locale, 'files.tl.summaryOf', { path })}`,
    summaryOfParts: () => splitAround(locale, 'files.tl.summaryOf', 'path'),
    omitted: (n: number) => pluralText(locale, 'files.tl.omitted', n, { max: FILE_TIMELINE_MAX_STEPS }),
    list: (path: string) => t(locale, 'files.tl.list', { path }),
    by: (agent: string) => t(locale, 'files.tl.by', { agent }),
    call: (id: string) => t(locale, 'files.tl.call', { id }),
  }
}

// ---- Waste section

function wasteTimes(locale: Locale, repeats: number, lost: number): string {
  return pluralText(locale, lost > 0 ? 'waste.timesLost' : 'waste.times', repeats)
}

/** What was observed, as a fact (no verdict: a repeat may be intended). */
export function wasteDescribeText(locale: Locale, item: WasteItem, lost = 0): string {
  const times = wasteTimes(locale, item.repeats, lost)
  if (item.kind === 'reread') return t(locale, 'waste.reread', { times })
  if (item.toolName === 'Glob') return t(locale, 'waste.glob', { times })
  return t(locale, 'waste.command', { tool: item.toolName, times })
}

/** Tokens of the repeats of one finding, qualified ("at least 400 tokens", "tokens not reported"). */
export function wasteTokensText(locale: Locale, item: WasteItem): string {
  if (item.costsKnown === 0) return t(locale, 'tok.unavailable')
  return tokensSpoken(locale, { value: item.tokens, status: item.costsUnknown > 0 ? 'partial' : 'available', estimated: item.estimated })
}

/** Summary of the folded section: "Repeated reads and calls: at least 5 observed, 2 calls not compared"; never a bare 0. */
export function wasteDisclosureText(locale: Locale, d: RepeatsDisclosure): string {
  const heading = t(locale, 'waste.heading')
  const base = d.count > 0
    ? pluralText(locale, d.lowerBound ? 'waste.summary.atLeast' : 'waste.summary.count', d.count, { heading })
    : t(locale, d.lowerBound ? 'waste.summary.noneIncomplete' : 'waste.summary.none', { heading })
  return d.uncompared > 0 ? pluralText(locale, 'waste.summary.uncompared', d.uncompared, { text: base }) : base
}

// ---- Context panel

export function resumeUnavailableText(locale: Locale, reason: ResumeUnavailableReason): string {
  return t(locale, `resume.no.${reason}` as MessageKey)
}

export function checksText(locale: Locale, c: ChecksSummary): string {
  switch (c.state) {
    case 'passing': return pluralText(locale, 'sw.checks.passing', c.total, { total: c.total })
    case 'failing': return c.pending > 0
      ? t(locale, 'sw.checks.failingPending', { failing: c.failing, pending: c.pending, total: c.total })
      : t(locale, 'sw.checks.failing', { failing: c.failing, total: c.total })
    case 'pending': return t(locale, 'sw.checks.pending', { pending: c.pending, total: c.total })
    case 'none': return t(locale, 'sw.checks.none')
    default: return c.total > 0 ? pluralText(locale, 'sw.checks.unknownTotal', c.total, { total: c.total }) : t(locale, 'sw.checks.unknown')
  }
}

/** "3 times" / "at least 3 times" (skills), "2 calls" / "at least 2 tool calls" (MCP). */
export function capTimesText(locale: Locale, n: number, lowerBound: boolean): string {
  const text = pluralText(locale, 'cap.times', n)
  return lowerBound ? t(locale, 'count.atLeast', { count: text }) : text
}

export function capCallsText(locale: Locale, n: number, lowerBound: boolean, tool = false): string {
  const text = pluralText(locale, tool ? 'cap.toolCalls' : 'cap.calls', n)
  return lowerBound ? t(locale, 'count.atLeast', { count: text }) : text
}

// ---- Tool content

export interface EditStatsLike { added: number; removed: number; blocks: number | null }
export interface EditPairLike { old: string; next: string }
export type UnappliedOutcomeLike = 'error' | 'cancelled' | 'expired'

const lines = (locale: Locale, n: number) => pluralText(locale, 'tool.lines', n)

const pairKind = ({ old, next }: EditPairLike) =>
  old === '' ? (next === '' ? 'none' : 'insert') : next === '' ? 'delete' : 'replace'

/**
 * What an Edit / MultiEdit asks for, in words: the figures are the line counts of old_string and new_string, not a
 * diff. A verb only when every block is of one kind; a call that proved no change says only what it asked for.
 * Null when both strings are empty everywhere.
 */
export function editSentenceText(locale: Locale, stats: EditStatsLike, pairs: readonly EditPairLike[], outcome: UnappliedOutcomeLike | undefined): string | null {
  const { added, removed } = stats
  if (added === 0 && removed === 0) return null
  if (outcome) {
    return t(locale, 'tool.edit.asked', { lead: t(locale, `tool.edit.unapplied.${outcome}` as MessageKey), removed: lines(locale, removed), added: lines(locale, added) })
  }
  const kinds = new Set(pairs.map(pairKind).filter(k => k !== 'none'))
  const kind = kinds.size === 1 ? [...kinds][0] : null
  if (kind === 'insert') return pluralText(locale, 'tool.edit.inserted', added, { lines: lines(locale, added) })
  if (kind === 'delete') return t(locale, 'tool.edit.deleted', { lines: lines(locale, removed) })
  if (kind === 'replace') return pluralText(locale, 'tool.edit.replaced', removed, { removed: lines(locale, removed), added })
  return t(locale, 'tool.edit.mixed', { removed: lines(locale, removed), added: lines(locale, added) })
}

export { lines as toolLinesText }
