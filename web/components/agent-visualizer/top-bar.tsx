"use client"

import { memo, useLayoutEffect, useRef } from "react"
import { Z, type TeamSummary } from "@/lib/agent-types"
import { COLORS, themed } from "@/lib/colors"
import { formatTokens, formatCost } from "@/lib/utils"
import { formatTokenUsage, formatCostUsage, spokenCostUsage, type UsageTotal } from "@/lib/usage"
import { INSPECTOR_KEEP_ATTR } from "./shared-ui"
import { useThemeVersion } from "@/lib/theme"
import { observeTopbarHeight, connectionDisplay, formatAgentCounts, formatAllSummary, spokenAllSummary, type ConnectionTone } from "@/lib/chrome-utils"
import { FOCUS_RING } from "@/lib/focus-ring"
import { finishedToggleLabel } from "@/hooks/simulation/session-visibility"
import { selectionLabel } from "@/lib/session-tree"
import { CONVERSATION_LABELS, COST_LABELS, PANEL_NAMES, openPanelLabel } from "@/lib/ui-glossary"
import { SESSION_NOT_OBSERVED_HELP } from "@/lib/session-model"
import { useUnobservedSessionCount } from "@/hooks/use-unobserved-sessions"
import { ALL_SESSIONS_ID, type SessionInfo, type ConnectionStatus } from "@/lib/bridge-types"
import { formatAttention } from "@/lib/attention"
import type { NotifyState } from "@/hooks/use-attention-alerts"
import { ScopeSelector, type ScopeSelectorProps } from "./scope-selector"

/** DOM id of the Enter full screen button: focus returns here on exit (#196) */
export const FULLSCREEN_BUTTON_ID = 'topbar-enter-fullscreen'

/** DOM ids of the top-bar buttons that toggle a panel (focus returns there when a panel opened by shortcut closes). */
export const PANEL_BUTTON_IDS = {
  sessions: 'topbar-toggle-sessions',
  files: 'topbar-toggle-files',
  conversation: 'topbar-toggle-conversation',
  cost: 'topbar-toggle-cost',
  timeline: 'topbar-toggle-timeline',
  context: 'topbar-toggle-context',
  stats: 'topbar-toggle-stats',
  system: 'topbar-toggle-system',
} as const

// ─── Mute/Unmute SVG Icons ───────────────────────────────────────────────────

function MutedIcon() {
  return (
    <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  )
}

function UnmutedIcon() {
  return (
    <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  )
}

export function FullscreenIcon({ exit = false }: { exit?: boolean }) {
  return (
    <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {exit
        ? <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
        : <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />}
    </svg>
  )
}

function GearIcon() {
  return (
    <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

/** #180: project context is read through the standalone relay, which the VS Code extension does not run. */
const CONTEXT_UNAVAILABLE_IN_VSCODE = 'Context: project CLAUDE.md, memory and issues come from the standalone relay, not available in VS Code'
const CONTEXT_UNAVAILABLE_ID = 'topbar-context-unavailable'

// ─── Toggle Button ──────────────────────────────────────────────────────────

function ToggleButton({ id, active, pressed, onClick, children, style, activeColor, title, shortcut, ariaLabel, hasDialog, keepsInspector, describedBy }: {
  /** DOM id, used as the focus fallback of the panel this button toggles */
  id?: string
  /** Visual active state */
  active: boolean
  /** aria-pressed value; omit for buttons whose accessible name already changes with state */
  pressed?: boolean
  onClick: () => void
  children: React.ReactNode
  style?: React.CSSProperties
  activeColor?: { bg: string; text: string }
  title?: string
  /** aria-keyshortcuts value */
  shortcut?: string
  ariaLabel?: string
  /** True when the button opens a modal dialog */
  hasDialog?: boolean
  /** Moving focus here keeps the agent inspector open (see INSPECTOR_KEEP_ATTR) */
  keepsInspector?: boolean
  /** id of an element describing the button (read after its name) */
  describedBy?: string
}) {
  return (
    <button
      id={id}
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      aria-keyshortcuts={shortcut}
      aria-haspopup={hasDialog ? 'dialog' : undefined}
      title={title}
      {...(keepsInspector ? { [INSPECTOR_KEEP_ATTR]: '' } : {})}
      // Underline + bold is the non-colour cue for the active state
      className={`min-h-6 min-w-6 px-2 py-1 rounded transition-all inline-flex items-center justify-center text-[11px] ${active ? 'font-bold underline underline-offset-4 decoration-2' : ''} ${FOCUS_RING}`}
      style={{
        background: active ? (activeColor?.bg ?? COLORS.toggleActive) : COLORS.toggleInactive,
        border: `1px solid ${COLORS.controlBorder}`,
        color: active ? (activeColor?.text ?? COLORS.holoBright) : COLORS.textMuted,
        ...style,
      }}
    >
      {children}
    </button>
  )
}

// ─── Connection Status Indicator ────────────────────────────────────────────

const TONE_COLOR: Record<ConnectionTone, string> = themed(() => ({
  ok: COLORS.complete,
  pending: COLORS.idle,
  error: COLORS.error,
  demo: COLORS.holoBright,
}))

/** Shown in every mode. The text label (never colour alone) carries the state. */
function ConnectionIndicator({ status, isDemo }: { status: ConnectionStatus; isDemo: boolean }) {
  const display = connectionDisplay(status, isDemo)
  const color = TONE_COLOR[display.tone]
  return (
    <span title={display.description} className="flex items-center gap-1.5 font-semibold" style={{ color }}>
      <span
        aria-hidden="true"
        className={`w-2 h-2 rounded-full ${display.tone === 'pending' ? 'motion-safe:animate-pulse' : ''}`}
        style={{ background: display.tone === 'error' ? 'transparent' : color, border: `2px solid ${color}`, boxShadow: `0 0 4px ${color}` }}
      />
      {display.label}
    </span>
  )
}

// ─── Top Bar ────────────────────────────────────────────────────────────────

export interface TopBarProps {
  // Sessions panel button
  sessions: SessionInfo[]
  /** Teams and workflows by key: names the selected group in the Sessions button */
  teams?: ReadonlyMap<string, TeamSummary>
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  /** The sessions panel (list of sessions and agents) is open */
  showSessions: boolean
  onToggleSessions: () => void
  /** Sessions the 'All' view counts (defaults to every session) */
  allSessionCount?: number
  /** 'All' also shows finished sessions */
  showFinished?: boolean
  /** Sessions currently counted as finished (not active) */
  finishedSessionCount?: number
  onToggleShowFinished?: (show: boolean) => void
  /** Idle / complete agents are hidden from the canvas */
  hideInactive?: boolean
  onToggleHideInactive?: (hide: boolean) => void
  // Connection
  isVSCode: boolean
  connectionStatus: ConnectionStatus
  /** True when the visualizer shows the built-in demo scenario instead of live data */
  isDemo?: boolean
  // Stats
  activeAgentCount: number
  /** Agents whose status is older than the freshness limit (not counted as active) */
  staleAgentCount?: number
  idleAgentCount?: number
  errorAgentCount?: number
  doneAgentCount: number
  totalTokens: number
  /** Qualified token total (partial = lower bound, estimated = badge); overrides `totalTokens` when given */
  tokenUsage?: UsageTotal
  /** Sum of per-agent costs, each priced with its own model */
  totalCost: number
  /** Qualified cost total; overrides `totalCost` when given */
  costUsage?: UsageTotal
  /** Part of totalCost (and of totalTokens) that belongs to no single agent; shown apart when above zero */
  unattributedCost?: number
  // Panel toggles
  showFileAttention: boolean
  showConversation: boolean
  showCostOverlay: boolean
  /** Project context panel open (optional: absent = closed) */
  showContext?: boolean
  /** System (machine health) panel open (optional: absent = closed) */
  showSystem?: boolean
  showTimeline: boolean
  /** Stats overlay open */
  showStats: boolean
  isMuted: boolean
  onTogglePanel: (panel: 'files' | 'conversation' | 'cost' | 'context' | 'system') => void
  onToggleTimeline: () => void
  onToggleStats: () => void
  onToggleMute: () => void
  /** Open the keyboard shortcuts dialog (also bound to `?`) */
  onOpenShortcuts: () => void
  /** Opens the Settings dialog; the gear button is hidden when omitted */
  onOpenSettings?: () => void
  /** Enter immersive full screen (Z) */
  onToggleFullscreen?: () => void
  /** Agents of the view waiting for a permission or in error (#126); the counter shows when any */
  attention?: { waiting: number; errors: number }
  /** Select the first blocked agent */
  onJumpToAttention?: () => void
  /** Browser notifications opt-in; absent or 'unsupported' = no control */
  notifyState?: NotifyState
  onToggleNotify?: () => void
  /** Scope of the session discovery (#291): shown permanently when a relay reports its scope */
  scope?: ScopeSelectorProps
}

export const TopBar = memo(function TopBar({
  sessions, teams, selectedSessionId, sessionsWithActivity,
  showSessions, onToggleSessions,
  allSessionCount, showFinished = false, finishedSessionCount = 0, onToggleShowFinished,
  hideInactive = false, onToggleHideInactive,
  isVSCode, connectionStatus, isDemo = false,
  activeAgentCount, staleAgentCount = 0, idleAgentCount = 0, errorAgentCount = 0, doneAgentCount, totalTokens, totalCost, tokenUsage, costUsage, unattributedCost = 0,
  showFileAttention, showConversation, showContext = false, showSystem = false, showCostOverlay, showTimeline, showStats, isMuted,
  onTogglePanel, onToggleTimeline, onToggleStats, onToggleMute, onOpenShortcuts, onOpenSettings, onToggleFullscreen,
  attention, onJumpToAttention, notifyState = 'unsupported', onToggleNotify, scope,
}: TopBarProps) {
  useThemeVersion() // the bar is memoized: repaint its COLORS-based styles on a theme switch
  const attentionText = attention ? formatAttention(attention.waiting, attention.errors) : ''
  const rootRef = useRef<HTMLElement>(null)
  const isAllMode = selectedSessionId === ALL_SESSIONS_ID
  // Listed sessions nobody has heard from: their status is unknown, never "idle" or "working" (issue #52)
  const unobservedCount = useUnobservedSessionCount(sessions, sessionsWithActivity)

  // Publish the measured height so panels can offset themselves below the (wrapping) bar.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    return observeTopbarHeight(el, document.documentElement, typeof ResizeObserver === 'undefined' ? undefined : ResizeObserver)
  }, [])

  return (
    <header
      ref={rootRef}
      className="absolute top-3 left-3 right-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md font-mono text-[11px]"
      style={{ zIndex: Z.info, background: 'var(--lens-bar-bg)', boxShadow: 'var(--lens-bar-shadow)', padding: 'var(--lens-bar-pad)' }}
    >
      {/* Sessions button: opens the list of sessions and agents (always shown, even with one session) */}
      <ToggleButton
        id={PANEL_BUTTON_IDS.sessions}
        active={showSessions}
        pressed={showSessions}
        onClick={onToggleSessions}
        title="Sessions and agents (L)"
        shortcut="l"
        keepsInspector
        style={{ maxWidth: 'min(320px, 100%)' }}
      >
        <span className="truncate" data-sensitive="">Sessions: {selectionLabel(selectedSessionId, sessions, teams)}</span>
        <span className="ml-1.5 shrink-0" style={{ color: COLORS.textDim }}>({sessions.length})</span>
        {unobservedCount > 0 && (
          <span className="ml-1.5 shrink-0" style={{ color: COLORS.textMuted }} title={SESSION_NOT_OBSERVED_HELP}>
            {unobservedCount} {unobservedCount === 1 ? 'session' : 'sessions'} not observed
          </span>
        )}
        {sessionsWithActivity.size > 0 && (
          <>
            <span aria-hidden="true" className="ml-1.5 inline-block w-2 h-2 shrink-0 rounded-full motion-safe:animate-pulse" style={{ border: `2px solid ${COLORS.complete}` }} />
            <span className="sr-only">, new activity in another session</span>
          </>
        )}
      </ToggleButton>

      {scope && <ScopeSelector {...scope} />}

      {/* Spacer pushes info to the right */}
      <div className="flex-1" />

      {/* Right-side info/controls */}
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1.5 min-w-0 max-w-full" style={{ color: COLORS.textMuted }}>
        <ConnectionIndicator status={connectionStatus} isDemo={isDemo} />
        {attentionText && onJumpToAttention && (
          <button
            type="button"
            data-testid="attention-counter"
            onClick={onJumpToAttention}
            aria-label={`${attentionText}. Go to the first agent that needs you`}
            title="Agents of this view that wait for a permission or failed. Click to select the first one."
            className={`min-h-6 px-2 rounded font-bold ${FOCUS_RING}`}
            style={{
              background: COLORS.toggleInactive,
              border: `1px solid ${attention!.waiting > 0 ? COLORS.waiting_permission : COLORS.error}`,
              color: attention!.waiting > 0 ? COLORS.waiting_permission : COLORS.error,
            }}
          >
            <span aria-hidden="true">! </span>{attentionText}
          </button>
        )}
        {notifyState !== 'unsupported' && onToggleNotify && (
          <ToggleButton
            active={notifyState === 'on'}
            pressed={notifyState === 'on'}
            onClick={onToggleNotify}
            title={notifyState === 'denied'
              ? 'Notifications are blocked in the browser settings'
              : 'Notify for the triggers chosen in Settings (permission, error, finished session, cost threshold)'}
          >
            {notifyState === 'denied' ? 'Notifications blocked' : 'Notifications'}
          </ToggleButton>
        )}
        {isAllMode && onToggleShowFinished && (finishedSessionCount > 0 || showFinished) && (
          <ToggleButton
            active={showFinished}
            pressed={showFinished}
            onClick={() => onToggleShowFinished(!showFinished)}
            title="Also show sessions that finished more than 10 minutes ago"
          >
            {finishedToggleLabel(finishedSessionCount)}
          </ToggleButton>
        )}
        {onToggleHideInactive && (
          <ToggleButton
            active={hideInactive}
            pressed={hideInactive}
            onClick={() => onToggleHideInactive(!hideInactive)}
            title="Hide agents that are idle or done"
          >
            Hide inactive agents
          </ToggleButton>
        )}
        {isAllMode ? (
          // Union of every session: sessions - agents - cost (each agent priced with its own model)
          <span data-testid="topbar-all-summary">
            {/* "~$1.23" on screen; screen readers skip "~" and "-", so they get the estimate in words (#364) */}
            <span aria-hidden="true">{formatAllSummary(allSessionCount ?? sessions.length, activeAgentCount + staleAgentCount + idleAgentCount + errorAgentCount + doneAgentCount, costUsage ?? totalCost)}</span>
            <span className="sr-only">{spokenAllSummary(allSessionCount ?? sessions.length, activeAgentCount + staleAgentCount + idleAgentCount + errorAgentCount + doneAgentCount, costUsage ?? totalCost)}</span>
          </span>
        ) : (
          <span>{formatAgentCounts(activeAgentCount, doneAgentCount, staleAgentCount, idleAgentCount, errorAgentCount)}</span>
        )}
        <span>
          {/* A sum of what each context holds now, not of what was consumed (#364) */}
          {tokenUsage ? formatTokenUsage(tokenUsage) : formatTokens(totalTokens)}{tokenUsage?.status === 'unavailable' ? '' : ' tokens in context'}
          {!isAllMode && (
            <span data-testid="topbar-cost" title={COST_LABELS.method} style={{ color: COLORS.complete, marginLeft: 4 }}>
              <span aria-hidden="true">{'\u00b7 '}</span>
              {/* "~$2.10" on screen, "context cost estimate $2.10" for assistive technology (#364) */}
              <span aria-hidden="true">{costUsage ? formatCostUsage(costUsage) : `${COST_LABELS.mark}${formatCost(totalCost)}`}</span>
              <span className="sr-only">, {costUsage ? spokenCostUsage(costUsage) : `${COST_LABELS.name} ${formatCost(totalCost)}`}</span>
              {unattributedCost > 0 && (
                <span data-testid="unattributed-cost" title="Usage that cannot be tied to a single agent (orphan or ambiguous), priced at the default rate">
                  {' '}(incl. <span aria-hidden="true">{COST_LABELS.mark}</span>{formatCost(unattributedCost)} unattributed)
                </span>
              )}
            </span>
          )}
        </span>

        <div role="toolbar" aria-label="View controls" className="flex flex-wrap items-center gap-1">
          {/* Side panels: Files, Conversation and Context are mutually exclusive; System and Cost open beside them */}
          {/* Wraps like the toolbar: at 320 px the five toggles do not fit on one line (WCAG 1.4.10) */}
          <div role="group" aria-label="Side panels" className="flex flex-wrap items-center gap-1 px-1 py-0.5 rounded" style={{
            background: COLORS.holoBg03,
            border: `1px solid ${COLORS.holoBorder06}`,
          }}>
            <ToggleButton id={PANEL_BUTTON_IDS.files} active={showFileAttention} pressed={showFileAttention} onClick={() => onTogglePanel('files')} title={openPanelLabel('files', 'F')} shortcut="f" style={{ background: showFileAttention ? undefined : 'transparent', border: 'none' }}>{PANEL_NAMES.files}</ToggleButton>
            <ToggleButton id={PANEL_BUTTON_IDS.conversation} active={showConversation} pressed={showConversation} onClick={() => onTogglePanel('conversation')} ariaLabel={CONVERSATION_LABELS.buttonLabel} title={CONVERSATION_LABELS.buttonLabel} shortcut="c" style={{ background: showConversation ? undefined : 'transparent', border: 'none' }}>{CONVERSATION_LABELS.buttonText}</ToggleButton>
            <ToggleButton id={PANEL_BUTTON_IDS.context} active={showContext} pressed={showContext} onClick={() => onTogglePanel('context')} ariaLabel={openPanelLabel('context', 'P')} title={isVSCode ? CONTEXT_UNAVAILABLE_IN_VSCODE : `${PANEL_NAMES.context}: project CLAUDE.md, memory, issues (P)`} describedBy={isVSCode ? CONTEXT_UNAVAILABLE_ID : undefined} shortcut="p" style={{ background: showContext ? undefined : 'transparent', border: 'none' }}>{PANEL_NAMES.context}</ToggleButton>
            <ToggleButton id={PANEL_BUTTON_IDS.system} active={showSystem} pressed={showSystem} onClick={() => onTogglePanel('system')} ariaLabel={openPanelLabel('system', 'Y')} title={`${PANEL_NAMES.system}: CPU, memory, disk (Y)`} shortcut="y" style={{ background: showSystem ? undefined : 'transparent', border: 'none' }}>{PANEL_NAMES.system}</ToggleButton>
            {isVSCode && <span id={CONTEXT_UNAVAILABLE_ID} className="sr-only">{CONTEXT_UNAVAILABLE_IN_VSCODE}</span>}
            <ToggleButton
              id={PANEL_BUTTON_IDS.cost}
              active={showCostOverlay}
              pressed={showCostOverlay}
              onClick={() => onTogglePanel('cost')}
              title={`${PANEL_NAMES.cost} overlay ($)`}
              shortcut="$"
              activeColor={{ bg: COLORS.costActiveBg, text: COLORS.complete }}
              style={{ background: showCostOverlay ? undefined : 'transparent', border: 'none' }}
            >
              ${PANEL_NAMES.cost}
            </ToggleButton>
          </div>

          {/* Independent toggles */}
          <ToggleButton id={PANEL_BUTTON_IDS.timeline} active={showTimeline} pressed={showTimeline} onClick={onToggleTimeline} title={openPanelLabel('timeline', 'T')} shortcut="t">{PANEL_NAMES.timeline}</ToggleButton>
          <ToggleButton id={PANEL_BUTTON_IDS.stats} active={showStats} pressed={showStats} onClick={onToggleStats} title={openPanelLabel('stats', 'S')} shortcut="s">{PANEL_NAMES.stats}</ToggleButton>
          <ToggleButton
            active={!isMuted}
            onClick={onToggleMute}
            ariaLabel={isMuted ? 'Unmute sound effects' : 'Mute sound effects'}
            title={isMuted ? 'Unmute (M)' : 'Mute (M)'}
            shortcut="m"
          >
            {isMuted ? <MutedIcon /> : <UnmutedIcon />}
          </ToggleButton>
          {onToggleFullscreen && (
            <ToggleButton
              id={FULLSCREEN_BUTTON_ID}
              active={false}
              onClick={onToggleFullscreen}
              ariaLabel="Enter full screen"
              title="Full screen (Z)"
              shortcut="z"
            >
              <FullscreenIcon />
            </ToggleButton>
          )}
          {onOpenSettings && (
            <ToggleButton
              active={false}
              onClick={onOpenSettings}
              ariaLabel="Settings"
              title="Settings"
              hasDialog
            >
              <GearIcon />
            </ToggleButton>
          )}
          <ToggleButton
            active={false}
            onClick={onOpenShortcuts}
            ariaLabel="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            shortcut="?"
            hasDialog
          >
            <span aria-hidden="true">?</span>
            <span aria-hidden="true" className="ml-1 hidden sm:inline">Shortcuts</span>
          </ToggleButton>
        </div>
      </div>
    </header>
  )
})
