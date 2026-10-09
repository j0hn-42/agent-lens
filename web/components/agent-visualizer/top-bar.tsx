"use client"

import { memo, useLayoutEffect, useRef } from "react"
import { Z, type TeamSummary } from "@/lib/agent-types"
import { COLORS, themed } from "@/lib/colors"
import { formatTokens, formatCost } from "@/lib/utils"
import { formatTokenUsage, formatCostUsage, type UsageTotal } from "@/lib/usage"
import { INSPECTOR_KEEP_ATTR } from "./shared-ui"
import { ThemeSelect } from "./theme-select"
import { useThemeVersion } from "@/lib/theme"
import { FOCUS_RING, observeTopbarHeight, connectionDisplay, formatAgentCounts, formatAllSummary, type ConnectionTone } from "@/lib/chrome-utils"
import { finishedToggleLabel } from "@/hooks/simulation/session-visibility"
import { selectionLabel } from "@/lib/session-tree"
import { CONVERSATION_LABELS, PANEL_NAMES, openPanelLabel } from "@/lib/ui-glossary"
import { SESSION_NOT_OBSERVED_HELP } from "@/lib/session-model"
import { useUnobservedSessionCount } from "@/hooks/use-unobserved-sessions"
import { ALL_SESSIONS_ID, type SessionInfo, type ConnectionStatus } from "@/lib/bridge-types"
import { formatAttention } from "@/lib/attention"
import type { NotifyState } from "@/hooks/use-attention-alerts"

/** DOM ids of the top-bar buttons that toggle a panel (focus returns there when a panel opened by shortcut closes). */
export const PANEL_BUTTON_IDS = {
  sessions: 'topbar-toggle-sessions',
  files: 'topbar-toggle-files',
  conversation: 'topbar-toggle-conversation',
  cost: 'topbar-toggle-cost',
  timeline: 'topbar-toggle-timeline',
  context: 'topbar-toggle-context',
  stats: 'topbar-toggle-stats',
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

function GearIcon() {
  return (
    <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

// ─── Toggle Button ──────────────────────────────────────────────────────────

function ToggleButton({ id, active, pressed, onClick, children, style, activeColor, title, shortcut, ariaLabel, hasDialog, keepsInspector }: {
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
}) {
  return (
    <button
      id={id}
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={ariaLabel}
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
  showTimeline: boolean
  /** Stats overlay open */
  showStats: boolean
  isMuted: boolean
  onTogglePanel: (panel: 'files' | 'conversation' | 'cost' | 'context') => void
  onToggleTimeline: () => void
  onToggleStats: () => void
  onToggleMute: () => void
  /** Open the keyboard shortcuts dialog (also bound to `?`) */
  onOpenShortcuts: () => void
  /** Opens the Settings dialog; the gear button is hidden when omitted */
  onOpenSettings?: () => void
  /** Agents of the view waiting for a permission or in error (#126); the counter shows when any */
  attention?: { waiting: number; errors: number }
  /** Select the first blocked agent */
  onJumpToAttention?: () => void
  /** Browser notifications opt-in; absent or 'unsupported' = no control */
  notifyState?: NotifyState
  onToggleNotify?: () => void
}

export const TopBar = memo(function TopBar({
  sessions, teams, selectedSessionId, sessionsWithActivity,
  showSessions, onToggleSessions,
  allSessionCount, showFinished = false, finishedSessionCount = 0, onToggleShowFinished,
  hideInactive = false, onToggleHideInactive,
  connectionStatus, isDemo = false,
  activeAgentCount, staleAgentCount = 0, doneAgentCount, totalTokens, totalCost, tokenUsage, costUsage, unattributedCost = 0,
  showFileAttention, showConversation, showContext = false, showCostOverlay, showTimeline, showStats, isMuted,
  onTogglePanel, onToggleTimeline, onToggleStats, onToggleMute, onOpenShortcuts, onOpenSettings,
  attention, onJumpToAttention, notifyState = 'unsupported', onToggleNotify,
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
        <span className="truncate">Sessions: {selectionLabel(selectedSessionId, sessions, teams)}</span>
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
              : 'Notify when an agent waits for a permission or fails while this tab is hidden'}
          >
            {notifyState === 'denied' ? 'Notifications blocked' : 'Notify when blocked'}
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
          <span>{formatAllSummary(allSessionCount ?? sessions.length, activeAgentCount + staleAgentCount + doneAgentCount, costUsage ?? totalCost)}</span>
        ) : (
          <span>{formatAgentCounts(activeAgentCount, doneAgentCount, staleAgentCount)}</span>
        )}
        <span>
          {tokenUsage ? formatTokenUsage(tokenUsage) : formatTokens(totalTokens)}{tokenUsage?.status === 'unavailable' ? '' : ' tokens'}
          {!isAllMode && (
            <span style={{ color: COLORS.complete, marginLeft: 4 }}>
              <span aria-hidden="true">{'\u00b7 '}</span>
              {costUsage ? formatCostUsage(costUsage) : `~${formatCost(totalCost)}`}
              {unattributedCost > 0 && (
                <span data-testid="unattributed-cost" title="Usage that cannot be tied to a single agent (orphan or ambiguous), priced at the default rate">
                  {' '}(incl. {formatCost(unattributedCost)} unattributed)
                </span>
              )}
            </span>
          )}
        </span>

        <div role="toolbar" aria-label="View controls" className="flex flex-wrap items-center gap-1">
          {/* Mutually exclusive panel group */}
          <div role="group" aria-label="Side panels" className="flex items-center gap-1 px-1 py-0.5 rounded" style={{
            background: COLORS.holoBg03,
            border: `1px solid ${COLORS.holoBorder06}`,
          }}>
            <ToggleButton id={PANEL_BUTTON_IDS.files} active={showFileAttention} pressed={showFileAttention} onClick={() => onTogglePanel('files')} title={openPanelLabel('files', 'F')} shortcut="f" style={{ background: showFileAttention ? undefined : 'transparent', border: 'none' }}>{PANEL_NAMES.files}</ToggleButton>
            <ToggleButton id={PANEL_BUTTON_IDS.conversation} active={showConversation} pressed={showConversation} onClick={() => onTogglePanel('conversation')} ariaLabel={CONVERSATION_LABELS.buttonLabel} title={CONVERSATION_LABELS.buttonLabel} shortcut="c" style={{ background: showConversation ? undefined : 'transparent', border: 'none' }}>{CONVERSATION_LABELS.buttonText}</ToggleButton>
            <ToggleButton id={PANEL_BUTTON_IDS.context} active={showContext} pressed={showContext} onClick={() => onTogglePanel('context')} ariaLabel={openPanelLabel('context', 'P')} title={`${PANEL_NAMES.context}: project CLAUDE.md, memory, issues (P)`} shortcut="p" style={{ background: showContext ? undefined : 'transparent', border: 'none' }}>{PANEL_NAMES.context}</ToggleButton>
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
          <ThemeSelect />
          <ToggleButton
            active={!isMuted}
            onClick={onToggleMute}
            ariaLabel={isMuted ? 'Unmute sound effects' : 'Mute sound effects'}
            title={isMuted ? 'Unmute (M)' : 'Mute (M)'}
            shortcut="m"
          >
            {isMuted ? <MutedIcon /> : <UnmutedIcon />}
          </ToggleButton>
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
