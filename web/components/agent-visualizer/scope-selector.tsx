"use client"

import { COLORS } from "@/lib/colors"
import { FOCUS_RING } from "@/lib/focus-ring"
import { TOUCH_TARGET } from "@/lib/mobile-view"
import type { SessionInfo } from "@/lib/bridge-types"
import { parseScopeValue, scopeLossNotices, scopeNotices, scopeOptions, scopeSummary, scopeValue, type RelayScopeState, type ScopeChoice } from "@/lib/relay-scope"
import { projectOptions } from "@/lib/session-filter"
import { useLocale } from "@/lib/locale"
import { translate } from "@/lib/messages"

export interface ScopeSelectorProps {
  /** What the relay reports it scans (GET /status); null = no relay, nothing to choose and nothing to claim */
  state: RelayScopeState | null
  sessions: ReadonlyArray<SessionInfo>
  /** Project filter in force (projectId), null = every project */
  projectId: string | null
  /** A change is being applied: the shown value stays the relay's until it confirms */
  pending: boolean
  /** Why the last change failed; the shown scope is still the scanned one */
  error: string | null
  onChoose: (choice: ScopeChoice) => void
  /**
   * The ceilings and failures are a polite live region (default). The top bar passes false: it announces them from its own
   * region, in the DOM from its first render, because the selector is mounted with More, its text already in it, and a
   * region inserted already filled is not announced by NVDA, JAWS and often VoiceOver (review of PR 631)
   */
  announce?: boolean
}

/**
 * Scope of the session discovery: this workspace, one project, or all workspaces. A native select (keyboard
 * operable, announced with its name and value), always visible with a sentence that says what is scanned and,
 * in a polite live region, the discovery ceilings that were hit. Colours come from the theme tokens; nothing moves.
 */
export function ScopeSelector({ state, sessions, projectId, pending, error, onChoose, announce = true }: ScopeSelectorProps) {
  const { locale } = useLocale()
  if (!state) return null
  const options = scopeOptions(sessions, locale)
  // A project that no session belongs to any more is not offered, so it is not shown as selected either
  const known = projectId !== null && projectOptions(sessions).some(p => p.projectId === projectId)
  const value = scopeValue(state.scope, known ? projectId : null)
  const summary = scopeSummary(state, locale)
  // The ceilings are worded here, in the language. What the relay or the link wrote (a runtime problem, a failed change) is
  // English data: it keeps its own lang instead of passing for the page language (WCAG 3.1.2).
  const notices = scopeNotices({ ...state, runtimeProblems: [] }, locale)
  const relayTexts = [...(error ? [error] : []), ...(state.runtimeProblems ?? []).map(p => p.message)]
  // Counts that only grow and are re-read every few seconds (issue 420): written, but outside the live region, which would
  // otherwise announce its whole content (role=status is atomic) again at each rise
  const losses = scopeLossNotices(state, locale)
  return (
    <div role="group" aria-label={translate(locale, 'scope.group')} lang={locale} className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0" data-scope-selector>
      <select
        aria-label={translate(locale, 'scope.select')}
        aria-busy={pending}
        title={translate(locale, 'scope.title')}
        value={value}
        onChange={e => { const choice = parseScopeValue(e.target.value); if (choice) onChoose(choice) }}
        className={`min-h-6 ${TOUCH_TARGET} px-1.5 py-0.5 rounded text-[11px] font-mono cursor-pointer max-w-[14rem] ${FOCUS_RING}`}
        style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary, colorScheme: "inherit" }}
      >
        {options.map(o => (
          <option key={o.value} value={o.value} style={{ background: COLORS.surface, color: COLORS.ink }}>{o.label}</option>
        ))}
      </select>
      {summary && <span style={{ color: COLORS.textMuted }}>{summary}</span>}
      <span role={announce ? "status" : undefined} data-scope-notices className="min-w-0" style={{ color: error ? COLORS.error : COLORS.textMuted }}>
        {relayTexts.map((text, i) => <span key={`relay-${i}`} lang="en" data-i18n-exempt="">{i > 0 && ' '}{text}</span>)}
        {notices.length > 0 && `${relayTexts.length > 0 ? ' ' : ''}${notices.join(' ')}`}
      </span>
      {losses.length > 0 && <span data-scope-losses className="min-w-0" style={{ color: COLORS.textMuted }}>{losses.join(' ')}</span>}
    </div>
  )
}
