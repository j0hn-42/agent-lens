/**
 * Texts of the top bar in the interface language (#500, #501). Pure (no React). The English texts are the ones the bar
 * had before: only the language changes, never a figure or its qualification (at least / estimated / not reported).
 */
import type { TeamSummary } from './agent-types'
import { ALL_SESSIONS_ID, type ConnectionStatus, type SessionInfo } from './bridge-types'
import type { ConnectionTone } from './chrome-utils'
import { parseReconnectDetail } from './reconnect'
import { groupHeadingText } from './card-text'
import { translate, type Locale, type MessageKey } from './messages'
import { selectionLabel } from './session-tree'

type Params = Readonly<Record<string, string | number>>
const tr = (locale: Locale, key: MessageKey, params?: Params) => translate(locale, key, params)

/** The plural form of a message that exists as <base>.one / <base>.other (French: 0 and 1 are singular). */
export function plural(locale: Locale, base: string, n: number, params: Params = {}): string {
  const rule = new Intl.PluralRules(locale).select(n) === 'one' ? 'one' : 'other'
  return tr(locale, `${base}.${rule}` as MessageKey, { n, ...params })
}

// ─── Sessions button ─────────────────────────────────────────────────────────

/** "All sessions", a team or a workflow heading, a session label (data, as it came). */
export function selectionLabelText(
  locale: Locale,
  selectedId: string | null,
  sessions: ReadonlyArray<Pick<SessionInfo, 'id' | 'label' | 'projectId' | 'projectName'>>,
  teams?: ReadonlyMap<string, TeamSummary>,
): string {
  if (selectedId === null || selectedId === ALL_SESSIONS_ID) return tr(locale, 'sessions.allSessions')
  if (selectedId.startsWith('team:')) {
    const key = selectedId.slice('team:'.length)
    const team = teams?.get(key)
    return groupHeadingText(locale, team?.kind, team?.name ?? key)
  }
  return selectionLabel(selectedId, sessions, teams)
}

/** "2 sessions not observed": listed sessions nobody has heard from. */
export function unobservedSessionsText(locale: Locale, n: number): string {
  return plural(locale, 'topbar.sessions.unobserved', n)
}

// ─── Attention counter (#501) ────────────────────────────────────────────────

/**
 * What the counter draws: "2 agents waiting / 1 agent in error". Spelled out (never "2 waiting"): the number alone
 * does not say what is counted. Zero parts are left out; empty when nothing is blocked.
 */
export function attentionCounterText(locale: Locale, waiting: number, errors: number): string {
  const parts: string[] = []
  if (waiting > 0) parts.push(plural(locale, 'topbar.attention.waiting', waiting))
  if (errors > 0) parts.push(plural(locale, 'topbar.attention.error', errors))
  return parts.join(' / ')
}

/** Accessible name: starts with the visible text (WCAG 2.5.3), then says what a click does. */
export function attentionAriaLabel(locale: Locale, waiting: number, errors: number): string {
  const many = waiting + errors > 1
  return `${attentionCounterText(locale, waiting, errors)}. ${tr(locale, many ? 'topbar.attention.go.many' : 'topbar.attention.go.one')}`
}

/** Tooltip: what is counted and what a click does; outside VS Code, where a permission is answered. */
export function attentionTooltip(locale: Locale, waiting: number, errors: number, isVSCode: boolean): string {
  const many = waiting + errors > 1
  const what = tr(locale, many ? 'topbar.attention.title.many' : 'topbar.attention.title.one')
  return isVSCode ? what : `${what} ${tr(locale, 'topbar.attention.answerWhere')}`
}

// ─── Connection ──────────────────────────────────────────────────────────────

export interface ConnectionText {
  label: string
  tone: ConnectionTone
  /** Tooltip of the badge */
  description: string
  /** The reconnect detail written next to the badge, with its language; null when there is none */
  detail: { text: string; lang: string } | null
}

/**
 * The connection badge in the language: DEMO never masquerades as LIVE (same decision as connectionDisplay). The reconnect
 * detail comes from the link as an English sentence: its known form is translated, any other text keeps lang="en".
 */
export function connectionText(locale: Locale, status: ConnectionStatus, isDemo: boolean, detail?: string | null): ConnectionText {
  const parsed = detail ? parseReconnectDetail(detail) : null
  const detailText = !detail ? null
    : parsed ? { text: tr(locale, 'topbar.connection.reconnecting', { attempt: parsed.attempt, seconds: parsed.seconds }), lang: locale }
    : { text: detail, lang: 'en' }
  if (isDemo) return { label: tr(locale, 'topbar.connection.demo'), tone: 'demo', description: tr(locale, 'topbar.connection.demo.help'), detail: detailText }
  switch (status) {
    case 'watching': return { label: tr(locale, 'topbar.connection.watching'), tone: 'ok', description: tr(locale, 'topbar.connection.watching.help'), detail: detailText }
    case 'connected': return { label: tr(locale, 'topbar.connection.connected'), tone: 'ok', description: tr(locale, 'topbar.connection.connected.help'), detail: detailText }
    case 'connecting': return { label: tr(locale, 'topbar.connection.connecting'), tone: 'pending', description: tr(locale, 'topbar.connection.connecting.help'), detail: detailText }
    default: return {
      label: tr(locale, 'topbar.connection.offline'),
      tone: 'error',
      // A title attribute cannot declare its language (WCAG 3.1.2): a detail in another language stays beside the badge, out of the tooltip
      description: detailText && detailText.lang === locale ? tr(locale, 'topbar.connection.offline.detail', { detail: detailText.text }) : tr(locale, 'topbar.connection.offline.help'),
      detail: detailText,
    }
  }
}


// ─── More ────────────────────────────────────────────────────────────────────

export function moreText(locale: Locale) {
  return {
    more: tr(locale, 'topbar.more'),
    name: tr(locale, 'topbar.more.name'),
    help: tr(locale, 'topbar.more.help'),
    withFilters: (count: number) => plural(locale, 'topbar.more.withFilters', count),
    /** Its accessible name in two parts around the list of filters, so each filter keeps its own language */
    nameParts: (count: number) => ({ before: plural(locale, 'topbar.more.nameBefore', count), after: ')' }),
  }
}
