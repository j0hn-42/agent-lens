"use client"

import { COLORS } from "@/lib/colors"
import { FOCUS_RING } from "@/lib/focus-ring"
import { TOUCH_TARGET } from "@/lib/mobile-view"
import type { SessionInfo } from "@/lib/bridge-types"
import { parseScopeValue, scopeNotices, scopeOptions, scopeSummary, scopeValue, type RelayScopeState, type ScopeChoice } from "@/lib/relay-scope"
import { projectOptions } from "@/lib/session-filter"

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
}

/**
 * Scope of the session discovery: this workspace, one project, or all workspaces. A native select (keyboard
 * operable, announced with its name and value), always visible with a sentence that says what is scanned and,
 * in a polite live region, the discovery ceilings that were hit. Colours come from the theme tokens; nothing moves.
 */
export function ScopeSelector({ state, sessions, projectId, pending, error, onChoose }: ScopeSelectorProps) {
  if (!state) return null
  const options = scopeOptions(sessions)
  // A project that no session belongs to any more is not offered, so it is not shown as selected either
  const known = projectId !== null && projectOptions(sessions).some(p => p.projectId === projectId)
  const value = scopeValue(state.scope, known ? projectId : null)
  const summary = scopeSummary(state)
  const notices = scopeNotices(state)
  const live = [...(error ? [error] : []), ...notices]
  return (
    <div role="group" aria-label="Scope" className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0" data-scope-selector>
      <select
        aria-label="Session scope"
        aria-busy={pending}
        title="Scope of the sessions: this workspace, one project, or all workspaces"
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
      <span role="status" data-scope-notices className="min-w-0" style={{ color: error ? COLORS.error : COLORS.textMuted }}>
        {live.join(' ')}
      </span>
    </div>
  )
}
