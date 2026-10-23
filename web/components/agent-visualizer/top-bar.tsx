"use client"

import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import { Z, type TeamSummary } from "@/lib/agent-types"
import { COLORS, themed } from "@/lib/colors"
import type { UsageTotal } from "@/lib/usage"
import { INSPECTOR_KEEP_ATTR } from "./shared-ui"
import { useThemeVersion } from "@/lib/theme"
import { observeTopbarHeight, viewCountsText, topBarContextText, unattributedRestText, type ConnectionTone } from "@/lib/chrome-utils"
import { FOCUS_RING } from "@/lib/focus-ring"
import { sessionStatusHelp } from "@/lib/card-text"
import {
  attentionAriaLabel, attentionCounterText, attentionTooltip, connectionText,
  moreText, selectionLabelText, unobservedSessionsShortText, unobservedSessionsText, type ConnectionText,
} from "@/lib/top-bar-text"
import { ACTIVE_WINDOW_MINUTES, type ShowMode } from "@/lib/show-mode"
import { useUnobservedSessionCount } from "@/hooks/use-unobserved-sessions"
import { ALL_SESSIONS_ID, type SessionInfo, type ConnectionStatus } from "@/lib/bridge-types"
import { useLocale } from "@/lib/locale"
import { translate, type Locale, type MessageKey } from "@/lib/messages"
import type { NotifyState } from "@/hooks/use-attention-alerts"
import { ScopeSelector, type ScopeSelectorProps } from "./scope-selector"
import { QuotaGauges, quotaSummary } from "./quota-gauges"
import { quotaGaugeState, type QuotaSnapshotView } from "@/lib/quota"
import { useMinuteClock } from "@/hooks/use-minute-clock"
import { TOUCH_TARGET } from "@/lib/mobile-view"
import { getAttentionShort, getTopbarTier, subscribeAttentionShort, subscribeTopbarTier } from "@/hooks/use-mobile-view"
import { scopeLossNotices, scopeNotices, scopeSummary } from "@/lib/relay-scope"
import { TopBarTooltip } from "./topbar-tooltip"
import { PanelIcon, type TopBarPanelId } from "./panel-icons"

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

/** Width (px) the Sessions button keeps before the filters leave the bar for More */
const FILTERS_MIN_SESSIONS_PX = 240
/** DOM id of More (at every width since the bar holds on one line): the focus fallback of the panels whose button it holds (#476). */
export const TOPBAR_MORE_ID = 'topbar-more'
/** DOM id of the Commands button (in the bar or in More, by width) */
const TOPBAR_COMMANDS_ID = 'topbar-commands'

// ─── Toggle Button ──────────────────────────────────────────────────────────

function ToggleButton({ id, buttonRef, active, pressed, onClick, children, style, activeColor, title, shortcut, ariaLabel, labelledBy, hasDialog, keepsInspector, describedBy, expanded, controls, lang, wrap, className = '' }: {
  /** DOM id, used as the focus fallback of the panel this button toggles */
  id?: string
  buttonRef?: React.Ref<HTMLButtonElement>
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
  /** id of the element that names the button (aria-labelledby) */
  labelledBy?: string
  /** True when the button opens a modal dialog */
  hasDialog?: boolean
  /** Moving focus here keeps the agent inspector open (see INSPECTOR_KEEP_ATTR) */
  keepsInspector?: boolean
  /** id of an element describing the button (read after its name) */
  describedBy?: string
  /** aria-expanded of a disclosure button, with the id of what it shows */
  expanded?: boolean
  controls?: string
  /** Language of this button's text when it is a translated control (#373); the others follow the page */
  lang?: string
  /** Content wraps onto a second line instead of squeezing its first item (#595); the text is never cut */
  wrap?: boolean
  /** Extra classes (a narrower padding under 768 px, where the box is at least 44 px anyway) */
  className?: string
}) {
  return (
    <button
      id={id}
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-keyshortcuts={shortcut}
      aria-haspopup={hasDialog ? 'dialog' : undefined}
      title={title}
      lang={lang}
      {...(keepsInspector ? { [INSPECTOR_KEEP_ATTR]: '' } : {})}
      // Bold + the 2 px bar under the button (boxShadow below) are the non-colour cues of the active state (WCAG 1.4.1).
      // Never also a text underline: it drew a second stroke next to the bar, and one per wrapped line on Sessions
      className={`min-h-6 min-w-6 ${TOUCH_TARGET} px-2 py-1 rounded transition-all inline-flex items-center ${wrap ? 'flex-wrap justify-start text-left gap-y-0.5' : 'justify-center'} text-[11px] ${active ? 'font-bold' : ''} ${FOCUS_RING} ${className}`}
      style={{
        background: active ? (activeColor?.bg ?? COLORS.toggleActive) : COLORS.toggleInactive,
        border: `1px solid ${COLORS.controlBorder}`,
        color: active ? (activeColor?.text ?? COLORS.holoBright) : COLORS.textMuted,
        boxShadow: active ? `inset 0 -2px 0 ${activeColor?.text ?? COLORS.holoBright}` : undefined,
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

/**
 * Shown in every mode, in the bar at every width. The text label (never colour alone) carries the state; while offline its
 * tooltip gives the reconnect detail ("attempt 2, retry in 10s"), also written in More with the "Retry now" button (#371)
 * when the bar has no room for it. In demo, a button leaves it.
 */
function ConnectionLabel({ display, labelRef }: { display: ConnectionText; labelRef: React.Ref<HTMLSpanElement> }) {
  const color = TONE_COLOR[display.tone]
  return (
    <span ref={labelRef} tabIndex={-1} title={display.description} data-connection-label="" className="flex shrink-0 items-center gap-1.5 whitespace-nowrap font-semibold outline-none" style={{ color }}>
      <span
        aria-hidden="true"
        className={`w-2 h-2 shrink-0 rounded-full max-md:hidden ${display.tone === 'pending' ? 'motion-safe:animate-pulse' : ''}`}
        style={{ background: display.tone === 'error' ? 'transparent' : color, border: `2px solid ${color}`, boxShadow: `0 0 4px ${color}` }}
      />
      {display.label}
    </span>
  )
}

/** "Retry now" (offline) and "Exit demo" (demo): in the bar from 1280 px, in More under it. */
function ConnectionActions({ locale, offline, isDemo, onRetry, onExitDemo, labelRef }: {
  locale: Locale; offline: boolean; isDemo: boolean; onRetry?: () => void; onExitDemo?: () => void; labelRef: React.RefObject<HTMLSpanElement | null>
}) {
  // The buttons disappear once used (state changes): hand focus to the label so it is not lost on <body> (2.4.3)
  const then = (fn?: () => void) => () => { labelRef.current?.focus({ preventScroll: true }); fn?.() }
  const buttonClass = `min-h-6 min-w-6 ${TOUCH_TARGET} shrink-0 whitespace-nowrap px-2 rounded text-xs font-semibold ${FOCUS_RING}`
  const buttonStyle = { background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }
  return (
    <>
      {offline && onRetry && (
        <button type="button" id="topbar-retry" data-testid="retry-connection" onClick={then(onRetry)} className={buttonClass} style={buttonStyle}>
          {translate(locale, 'topbar.connection.retry')}
        </button>
      )}
      {isDemo && onExitDemo && (
        <button type="button" id="topbar-exit-demo" data-testid="exit-demo" onClick={then(onExitDemo)} className={buttonClass} style={buttonStyle}>
          {translate(locale, 'topbar.connection.exitDemo')}
        </button>
      )}
    </>
  )
}

function MoreIcon() {
  return (
    <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="hidden shrink-0 max-md:block">
      <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
    </svg>
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
  /**
   * A loss is known for the view and its truncation notice is closed (#569 review): the Sessions button carries ⚠ and
   * says so to screen readers, so the loss stays visible with the Sessions panel closed.
   */
  lossMarked?: boolean
  /**
   * 'Show: active / all' (#372): one control, 'Hide inactive', instead of 'Hide inactive agents' and 'Show finished
   * sessions'. 'active' hides the agents whose turn is over and, in All, the finished sessions silent for ACTIVE_WINDOW_MINUTES
   */
  showMode?: ShowMode
  onChangeShowMode?: (mode: ShowMode) => void
  /** Sessions the bridge counts as finished in the view's project scope: the ones 'active' hides from All */
  finishedSessionCount?: number
  // Connection
  isVSCode: boolean
  connectionStatus: ConnectionStatus
  /** True when the visualizer shows the built-in demo scenario instead of live data */
  isDemo?: boolean
  /** "reconnecting (attempt N, retry in Xs)" while the relay link is down (#371) */
  connectionDetail?: string | null
  /** "Retry now": offered while offline */
  onRetryConnection?: () => void
  /** "Exit demo": offered next to the DEMO badge */
  onExitDemo?: () => void
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
  /** Tokens tied to no agent, as the Cost panel draws them (#576); read after the cost and the tokens */
  unattributedTokens?: number
  /** Cost of those tokens at the default rate */
  unattributedCost?: number
  /** True when a part of the unattributed usage is an estimate */
  unattributedEstimated?: boolean
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
  /** Select the next blocked agent (the first one on the first click, #377) */
  onJumpToAttention?: () => void
  /** Opens the command palette (also Ctrl+K / Cmd+K); the button is hidden when omitted (#377) */
  onOpenPalette?: () => void
  /** Browser notifications opt-in; absent or 'unsupported' = no control */
  notifyState?: NotifyState
  onToggleNotify?: () => void
  /** Scope of the session discovery (#291): in More when a relay reports its scope, signalled on More */
  scope?: ScopeSelectorProps
  /** Subscription quota snapshot of the relay (#467); null until it sends one (always null in VS Code and demo mode) */
  quota?: QuotaSnapshotView | null
  /** Runtime of the selected session ('claude', 'copilot', ...); undefined = no session selected */
  selectedRuntime?: string
  /** Settings > Show the quota gauges; on by default */
  showQuota?: boolean
}

export const TopBar = memo(function TopBar({
  sessions, teams, selectedSessionId, sessionsWithActivity,
  showSessions, onToggleSessions,
  allSessionCount, lossMarked = false, showMode = 'all', onChangeShowMode, finishedSessionCount = 0,
  isVSCode, connectionStatus, isDemo = false, connectionDetail, onRetryConnection, onExitDemo,
  activeAgentCount, staleAgentCount = 0, idleAgentCount = 0, errorAgentCount = 0, doneAgentCount, totalTokens, totalCost, tokenUsage, costUsage, unattributedTokens = 0, unattributedCost = 0, unattributedEstimated = false,
  showFileAttention, showConversation, showContext = false, showSystem = false, showCostOverlay, showTimeline, showStats, isMuted,
  onTogglePanel, onToggleTimeline, onToggleStats, onToggleMute, onOpenShortcuts, onOpenSettings, onToggleFullscreen,
  attention, onJumpToAttention, onOpenPalette, notifyState = 'unsupported', onToggleNotify, scope,
  quota = null, selectedRuntime, showQuota = true,
}: TopBarProps) {
  const { locale } = useLocale()
  const t = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => translate(locale, key, params)
  useThemeVersion() // the bar is memoized: repaint its COLORS-based styles on a theme switch
  // Spelled out in the language (#501): "1 agent waiting", never "1 waiting". With two or more blocked agents each click goes
  // to the next one (#377); with one, there is no "next" to promise. Outside VS Code no permission card is drawn here (#240):
  // the tooltip says where a permission is answered.
  const attentionText = attention ? attentionCounterText(locale, attention.waiting, attention.errors) : ''
  const more = moreText(locale)
  const rootRef = useRef<HTMLElement>(null)
  const isAllMode = selectedSessionId === ALL_SESSIONS_ID
  // Listed sessions nobody has heard from: their status is unknown, never "idle" or "working" (issue #52)
  const unobservedCount = useUnobservedSessionCount(sessions, sessionsWithActivity)
  // One line at every width (owner request, 2026-10-21): what does not fit moves behind More, an overlay, at fixed widths
  // (lib/mobile-view.ts, measured in tests-a11y/e2e/topbar-layout.e2e.ts). Behind More a control is not rendered while More
  // is closed (no hidden Tab stop).
  const [moreOpen, setMoreOpen] = useState(false)
  const menuId = useId()
  const moreNameId = useId()
  const holdsId = useId()
  const hiddenFinishedId = useId()
  const moreRef = useRef<HTMLButtonElement>(null)
  const connectionLabelRef = useRef<HTMLSpanElement>(null)
  // A resize (or a browser zoom) that crosses a width moves controls between the bar and More, which mounts them anew: the
  // focused one is remembered here, before React renders the new width, and focused again where it is drawn now, More
  // opening to show it if it moved there (2.4.3, as #523 did for the folded bar)
  const pendingFocus = useRef<string | null>(null)
  const subscribeTier = useCallback((onChange: () => void) => subscribeTopbarTier(() => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    if (active && active.id && active.id !== TOPBAR_MORE_ID && rootRef.current?.contains(active)) pendingFocus.current = active.id
    onChange()
  }), [])
  const tier = useSyncExternalStore(subscribeTier, getTopbarTier, () => 'wide' as const)
  const mobile = tier === 'mobile'
  const panelsInBar = tier === 'wide' || tier === 'mid'
  const commandsInBar = tier === 'wide' || tier === 'fold'
  const connectionActionsInBar = tier === 'wide'
  // The filters are in the bar while it has room for them, measured (they need ~ their own width); else behind More.
  const [filtersFit, setFiltersFit] = useState(true)
  const filtersWidth = useRef(0)
  const filtersFitRef = useRef(true)
  const filtersInBar = !mobile && filtersFit
  // Under 1440 px the attention counter is a number (lib/mobile-view.ts): spelled out it left no room for the selection
  const attentionShort = useSyncExternalStore(subscribeAttentionShort, getAttentionShort, () => false)
  // Room for the filters: the Sessions button keeps at least FILTERS_MIN_SESSIONS_PX of width (its selection ends in an
  // ellipsis, it gives way first). In the bar, they stay while the spacer has slack or Sessions is not squeezed below that;
  // behind More they come back once the slack plus what Sessions can give covers their last measured width (+ a margin
  // against flicker). jsdom measures 0 everywhere: there they always fit.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || mobile) return
    // A filter that moves is mounted anew: the focused control is remembered before, as for a change of tier
    const apply = (fit: boolean) => {
      if (fit === filtersFitRef.current) return
      filtersFitRef.current = fit
      const active = document.activeElement
      if (active && active.id && active.id !== TOPBAR_MORE_ID && root.contains(active)) pendingFocus.current = active.id
      setFiltersFit(fit)
    }
    const measure = () => {
      const spacer = root.querySelector<HTMLElement>('[data-topbar-spacer]')
      const sessions = document.getElementById(PANEL_BUTTON_IDS.sessions)
      if (!spacer || !sessions) return
      const label = sessions.querySelector<HTMLElement>('[data-sensitive]')
      const squeezed = !!label && label.scrollWidth > label.clientWidth + 0.5
      const group = root.querySelector<HTMLElement>('[data-topbar-group="filters"]')
      if (group) {
        filtersWidth.current = group.offsetWidth + 8
        apply(spacer.offsetWidth > 0.5 || sessions.offsetWidth >= FILTERS_MIN_SESSIONS_PX || !squeezed)
      } else {
        apply(spacer.offsetWidth + Math.max(0, sessions.offsetWidth - FILTERS_MIN_SESSIONS_PX) >= filtersWidth.current + 16)
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    const spacer = root.querySelector('[data-topbar-spacer]')
    if (spacer) ro.observe(spacer)
    return () => ro.disconnect()
  })
  useLayoutEffect(() => {
    const id = pendingFocus.current
    if (!id) return
    const el = document.getElementById(id)
    if (el && rootRef.current?.contains(el)) {
      pendingFocus.current = null
      if (document.activeElement !== el) el.focus({ preventScroll: true })
    } else if (!moreOpen) {
      setMoreOpen(true) // the control moved behind More: this effect runs again once More shows it
    } else {
      pendingFocus.current = null
      moreRef.current?.focus({ preventScroll: true })
    }
  }, [tier, moreOpen, filtersInBar])
  // More closes on Escape (the focus goes back to it, 2.4.3), on a click outside the bar, and when the focus leaves the bar
  useEffect(() => {
    if (!moreOpen) return
    const root = rootRef.current
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Only More closes: the app's own Escape (close the latest panel, clear the selection) waits for the next one
      e.stopPropagation()
      const inside = !!root && root.contains(document.activeElement)
      setMoreOpen(false)
      if (inside) moreRef.current?.focus({ preventScroll: true })
    }
    const onDown = (e: PointerEvent) => { if (root && !root.contains(e.target as Node)) setMoreOpen(false) }
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null
      if (next && root && !root.contains(next)) setMoreOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown)
    root?.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onDown)
      root?.removeEventListener('focusout', onFocusOut)
    }
  }, [moreOpen])
  // While a tooltip of the bar or More is open the bar rises above the docked panels, which they are drawn over (#497 review)
  const [openTooltips, setOpenTooltips] = useState(0)
  const onTooltip = useCallback((delta: 1 | -1) => setOpenTooltips(n => Math.max(0, n + delta)), [])
  // The age and the expiry of the quota move with the clock; it ticks once a minute, only while there is a snapshot to age
  const quotaNow = useMinuteClock(showQuota && quota !== null)
  const quotaState = quotaGaugeState(selectedRuntime, quota, quotaNow)
  // #523 (user request): the bar draws no summary text any more: no token total, no cost (the Cost panel draws the
  // view's, the Sessions panel each session's, the inspector each agent's) and no agent counts by state (the Sessions
  // panel header draws them, same text). The Cost panel is a canvas that screen readers do not read: they keep the
  // counts and the totals here, visually hidden.
  const counts = viewCountsText(
    { active: activeAgentCount, done: doneAgentCount, stale: staleAgentCount, idle: idleAgentCount, error: errorAgentCount },
    isAllMode ? (allSessionCount ?? sessions.length) : null,
    locale,
  )
  const contextText = topBarContextText(
    tokenUsage ?? { value: totalTokens, status: 'available', estimated: false },
    costUsage ?? { value: totalCost, status: 'available', estimated: false },
    locale,
  )
  const spokenTotals = [
    // Full wording ("last known state"); screen readers skip the "-" (#364)
    counts.spoken,
    contextText.spoken,
    contextText.tokens,
    // Same rule, qualifiers and order as the Cost panel text region (#576): cost, tokens, then the unattributed part, in every view
    unattributedRestText(unattributedTokens, unattributedCost, unattributedEstimated, locale),
  ].filter((part): part is string => part !== null).join(', ')
  // The filters that change what the canvas shows are behind More: they are named on More, never hidden behind it (reading-the-ui.md)
  // Same wording and language as the filter button that More reveals (#373); `lang` is the language of that wording
  // 'Hide inactive' (#372): in All, while it hides finished sessions, it says how many (the bridge count, never a guess)
  const hidesInactive = showMode === 'active' && !!onChangeShowMode
  const hiddenFinished = hidesInactive && isAllMode && finishedSessionCount > 0 ? finishedSessionCount : 0
  const hideInactiveLabel = t('show.hideInactive')
  const hideInactiveCount = hiddenFinished > 0 ? t('show.hideInactive.count', { n: hiddenFinished }) : null
  const hideInactiveTitle = [
    isAllMode ? t('show.hideInactive.title.all', { n: ACTIVE_WINDOW_MINUTES }) : t('show.hideInactive.title.one'),
    hideInactiveCount,
  ].filter((part): part is string => part !== null).join(' ')
  const activeFilters: { text: string; lang: string }[] = hidesInactive
    ? [{ text: hiddenFinished > 0 ? t('show.hideInactive.withCount', { n: hiddenFinished }) : hideInactiveLabel, lang: locale }]
    : []
  const showFilterCount = activeFilters.length > 0 && !filtersInBar

  // What More holds that the bar does not show is never hidden behind it without a sign (reading-the-ui.md): the
  // reconnect detail, blocked notifications, the scope and its discovery ceilings, the quota. More reads them in its
  // description and carries a mark: ⚠ when one of them needs a look (a ceiling, a failure, a low or unknown quota, the link
  // down, notifications blocked by the browser), • otherwise.
  const connection = connectionText(locale, connectionStatus, isDemo, connectionDetail)
  const offline = !isDemo && connection.tone === 'error'
  const connectionDetailShown = offline ? connection.detail : null
  const scopeState = scope?.state ?? null
  const scopeText = scopeState ? {
    summary: scopeSummary(scopeState, locale),
    notices: scopeNotices({ ...scopeState, runtimeProblems: [] }, locale),
    // What the relay or the link wrote is English data: it keeps its own lang (WCAG 3.1.2)
    relay: [...(scope?.error ? [scope.error] : []), ...(scopeState.runtimeProblems ?? []).map(p => p.message)],
    losses: scopeLossNotices(scopeState, locale),
  } : null
  const quotaHeld = showQuota ? quotaSummary(quotaState, locale) : null
  // Before the one-line bar "Notifications blocked" was drawn in the bar from 1024 px; behind More it is signalled on More
  // (PR #631 review): no alert reaches the person while the browser blocks them
  const notifyBlocked = notifyState === 'denied' && !!onToggleNotify && !filtersInBar
  const holdsAlert = !!connectionDetailShown || notifyBlocked || !!quotaHeld?.alert
    || (!!scopeText && (scopeText.notices.length > 0 || scopeText.relay.length > 0 || scopeText.losses.length > 0))
  const holdsAny = holdsAlert || !!quotaHeld || !!scopeText?.summary
  const moreMark = holdsAlert ? 'alert' : holdsAny ? 'status' : null

  // A control of More that opens a dialog, a panel or full screen closes More first and leaves the focus on More: the
  // control is gone once More closes, so More is what the dialog gives the focus back to (2.4.3)
  const fromMenu = (fn: () => void) => () => {
    setMoreOpen(false)
    moreRef.current?.focus({ preventScroll: true })
    fn()
  }
  // A panel button of More closes More and the focus waits on More (the button is gone). Under 768 px the panel opens as a
  // drawer below the short bar, which takes the focus; More is where it comes back when it closes
  const thenFold = (fn: () => void) => () => {
    fn()
    setMoreOpen(false)
    moreRef.current?.focus({ preventScroll: true })
  }

  // Publish the measured height so panels can offset themselves below the bar (More is an overlay: it does not count).
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    return observeTopbarHeight(el, document.documentElement, typeof ResizeObserver === 'undefined' ? undefined : ResizeObserver)
  }, [])

  // A panel button: an icon at every width (one-line bar, owner request); its name is the accessible name (2.5.3: no visible
  // text, nothing to contradict), the tooltip names it and says what the panel shows.
  const panelButton = (panel: TopBarPanelId, { active, onClick, shortcut, inGroup, activeColor, tooltip, tooltipLang }: {
    active: boolean; onClick: () => void; shortcut: string; inGroup: boolean
    activeColor?: { bg: string; text: string }; tooltip?: string; tooltipLang?: string
  }) => {
    const name = t(`topbar.panel.${panel}.name`)
    const tipText = tooltip ?? t(`topbar.panel.${panel}.tooltip`)
    // Only a tooltip exactly equal to the name (Conversation: "Conversation (C)") is not linked, a screen reader would read
    // it twice. "Files (F)" adds the shortcut, which aria-keyshortcuts alone does not get spoken everywhere (#545 review).
    // An unlinked tooltip is still drawn on hover and focus.
    const saysMore = tipText !== name
    return (
      <TopBarTooltip text={tipText} lang={tooltipLang ?? locale} onOpen={onTooltip}>
        {tipId => (
          <ToggleButton
            id={PANEL_BUTTON_IDS[panel]}
            active={active}
            pressed={active}
            onClick={onClick}
            ariaLabel={name}
            describedBy={saysMore ? tipId : undefined}
            shortcut={shortcut}
            lang={locale}
            activeColor={activeColor}
            style={inGroup ? { background: active ? undefined : 'transparent', border: 'none' } : undefined}
          >
            <PanelIcon panel={panel} />
            <span data-panel-label="" className="sr-only">{name.replace(/ \([A-Z]\)$/, '')}</span>
          </ToggleButton>
        )}
      </TopBarTooltip>
    )
  }

  /** Notifications and 'Hide inactive': in the bar while it has room (measured), in More otherwise. */
  const filtersGroup = (inMenu: boolean) => {
    if (!((notifyState !== 'unsupported' && onToggleNotify) || onChangeShowMode)) return null
    return (
        <div role="group" aria-label={t('topbar.menu.filters')} data-topbar-group="filters" className={`flex items-center gap-2 ${inMenu ? 'flex-wrap' : 'shrink-0 flex-nowrap'}`}>
          {notifyState !== 'unsupported' && onToggleNotify && (
            <ToggleButton
              id="topbar-notify"
              active={notifyState === 'on'}
              pressed={notifyState === 'on'}
              onClick={onToggleNotify}
              lang={locale}
              title={notifyState === 'denied' ? t('topbar.notify.blocked.title') : t('topbar.notify.title')}
            >
              {notifyState === 'denied' ? t('topbar.notify.blocked') : t('topbar.notify')}
            </ToggleButton>
          )}
          {/* 'Show: active / all' (#372): one toggle, pressed = the inactive ones are hidden. Its short name starts with the
              label (2.5.3) and names only what the view hides (sessions in All only); the rule is in the tooltip; in All the
              number of finished sessions it hides is its description */}
          {onChangeShowMode && (
            <Fragment>
              <ToggleButton
                id="topbar-hide-inactive"
                active={showMode === 'active'}
                pressed={showMode === 'active'}
                onClick={() => onChangeShowMode(showMode === 'active' ? 'all' : 'active')}
                ariaLabel={isAllMode ? t('show.hideInactive.name.all') : t('show.hideInactive.name.one')}
                title={hideInactiveTitle}
                describedBy={hideInactiveCount ? hiddenFinishedId : undefined}
                lang={locale}
              >
                {hideInactiveLabel}
              </ToggleButton>
              {hideInactiveCount && <span id={hiddenFinishedId} lang={locale} className="sr-only">{hideInactiveCount}</span>}
            </Fragment>
          )}
        </div>
    )
  }

  /** The seven panel buttons: in the bar from 1024 px, in More under it (where a panel closes More). */
  const panels = (inMenu: boolean) => {
    const wrapFn = inMenu ? thenFold : (fn: () => void) => fn
    return (
      <div data-topbar-group="panels" className={`flex items-center gap-1 ${inMenu ? 'flex-wrap' : 'shrink-0'}`}>
        {/* Side panels: Files, Conversation and Context are mutually exclusive; System and Cost open beside them */}
        {/* No vertical padding: the group is as high as the other controls (26.5 px), so the bar stays 38.5 px high */}
        <div role="group" aria-label={t('topbar.sidePanels')} className={`flex items-center gap-1 px-1 rounded ${inMenu ? 'flex-wrap' : ''}`} style={{
          background: COLORS.holoBg03,
          border: `1px solid ${COLORS.holoBorder06}`,
        }}>
          {panelButton('files', { active: showFileAttention, onClick: wrapFn(() => onTogglePanel('files')), shortcut: 'f', inGroup: true })}
          {panelButton('conversation', { active: showConversation, onClick: wrapFn(() => onTogglePanel('conversation')), shortcut: 'c', inGroup: true })}
          {panelButton('context', {
            active: showContext, onClick: wrapFn(() => onTogglePanel('context')), shortcut: 'p', inGroup: true,
            ...(isVSCode ? { tooltip: t('topbar.context.vscode') } : {}),
          })}
          {panelButton('system', { active: showSystem, onClick: wrapFn(() => onTogglePanel('system')), shortcut: 'y', inGroup: true })}
          {/* Cost and Stats are drawn on the canvas and take no focus: More stays open, so several can be toggled in a row */}
          {panelButton('cost', {
            active: showCostOverlay, onClick: () => onTogglePanel('cost'), shortcut: '$', inGroup: true,
            activeColor: { bg: COLORS.costActiveBg, text: COLORS.complete },
          })}
        </div>

        {/* Independent toggles */}
        {panelButton('timeline', { active: showTimeline, onClick: wrapFn(onToggleTimeline), shortcut: 't', inGroup: false })}
        {panelButton('stats', { active: showStats, onClick: onToggleStats, shortcut: 's', inGroup: false })}
      </div>
    )
  }

  const commandsButton = (inMenu: boolean) => onOpenPalette && (
    <ToggleButton
      id={TOPBAR_COMMANDS_ID}
      active={false}
      onClick={inMenu ? fromMenu(onOpenPalette) : onOpenPalette}
      ariaLabel={t('topbar.commands')}
      title={t('topbar.commands.title')}
      lang={locale}
      shortcut="Control+K Meta+K"
      hasDialog
      style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
    >
      <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="7" cy="7" r="5" />
        <path d="M11 11l4 4" />
      </svg>
      <span aria-hidden="true" className="ml-1">{t('topbar.commands')}</span>
    </ToggleButton>
  )

  const selectionText = selectionLabelText(locale, selectedSessionId, sessions, teams)
  const sessionLabel = t('topbar.sessions.button', { label: selectionText })
  // "Sessions: " is read, not drawn (review of PR 631): measured in a browser, the drawn prefix left no room for the
  // selection at 320 px, at 768 px and at 1280 px in the worst case. The button draws the selection and its marks; its
  // accessible name and its tooltip still start with "Sessions: " (2.5.3: the drawn text is part of the name)
  const sessionPrefix = sessionLabel.endsWith(selectionText) ? sessionLabel.slice(0, sessionLabel.length - selectionText.length) : ''
  const unobservedText = unobservedCount > 0 ? unobservedSessionsText(locale, unobservedCount) : null
  // The whole Sessions text in its tooltip: the button is capped and gives way first (its label then ends in an ellipsis)
  const sessionsTip = [`${sessionLabel} (${sessions.length})`, unobservedText, t('topbar.sessions.title')].filter(Boolean).join(' · ')

  return (
    <header
      ref={rootRef}
      lang={locale}
      className="absolute top-3 left-3 right-3 flex flex-nowrap items-center gap-x-2 max-md:gap-x-0.5 rounded-md font-mono text-[11px]"
      style={{ zIndex: openTooltips > 0 || moreOpen ? Z.topBarRaised : Z.topBar, background: 'var(--lens-bar-bg)', boxShadow: 'var(--lens-bar-shadow)', padding: 'var(--lens-bar-pad)', color: COLORS.textMuted }}
    >
      {/* Sessions button: opens the list of sessions and agents (always shown, even with one session). Capped at 320 px, it
          gives way first when the bar is full: it draws the selection, which ends in an ellipsis (the whole text, from
          "Sessions: ", is its name and its tooltip); the marks of a loss and of new activity never shrink. Measured in
          topbar-layout.e2e.ts, at least 10 characters of the selection are drawn from 320 to 1920 px, in English and in
          French, worst case included (40-character name, OFFLINE or DEMO, attention, a filter, More marked). Under 768 px
          the number of sessions is read, not drawn, and the padding is narrower (the box stays 44 px) to leave it room */}
      <TopBarTooltip text={sessionsTip} lang={locale} sensitive onOpen={onTooltip} boxClassName="min-w-0 max-w-[320px]">
        {() => (
          <ToggleButton
            id={PANEL_BUTTON_IDS.sessions}
            active={showSessions}
            pressed={showSessions}
            onClick={onToggleSessions}
            lang={locale}
            shortcut="l"
            keepsInspector
            className="max-md:px-1.5"
            style={{ maxWidth: '100%', whiteSpace: 'nowrap' }}
          >
            {/* The space is a text node of its own: inside the hidden span it would be trimmed from the name */}
            {sessionPrefix && <><span className="sr-only">{sessionPrefix.trimEnd()}</span>{' '}</>}
            <span className="min-w-0 truncate" data-sensitive="">{sessionPrefix ? selectionText : sessionLabel}</span>
            <span className="ml-1.5 shrink-0 max-md:sr-only" style={{ color: COLORS.textDim }}>({sessions.length})</span>
            {lossMarked && (
              // A symbol, never a colour alone; its words are read with the button name
              <span data-loss-mark="" className="ml-1.5 shrink-0 max-md:ml-0.5">
                <span aria-hidden="true">⚠</span>
                <span className="sr-only">, {t('truncation.topbarMark')}</span>
              </span>
            )}
            {unobservedText && (
              // Drawn short from 1280 px ("2 not observed"), where the label keeps room; read in full; the Sessions panel marks each such session
              <>
                <span aria-hidden="true" className="ml-1.5 shrink-0 max-xl:hidden" style={{ color: COLORS.textMuted }}>
                  {unobservedSessionsShortText(locale, unobservedCount)}
                </span>
                <span className="sr-only">, {unobservedText}</span>
              </>
            )}
            {sessionsWithActivity.size > 0 && (
              <>
                <span aria-hidden="true" className="ml-1.5 inline-block w-2 h-2 shrink-0 rounded-full motion-safe:animate-pulse max-md:ml-0.5" style={{ border: `2px solid ${COLORS.complete}` }} />
                <span className="sr-only">, {t('topbar.sessions.newActivity')}</span>
              </>
            )}
          </ToggleButton>
        )}
      </TopBarTooltip>

      <ConnectionLabel display={connection} labelRef={connectionLabelRef} />
      {connectionActionsInBar && (
        <ConnectionActions locale={locale} offline={offline} isDemo={isDemo} onRetry={onRetryConnection} onExitDemo={onExitDemo} labelRef={connectionLabelRef} />
      )}
      {attentionText && onJumpToAttention && (
        <button
          type="button"
          data-testid="attention-counter"
          onClick={onJumpToAttention}
          lang={locale}
          // Under 1440 px the counter is the number of agents; its name starts with that number, then gives the full text
          aria-label={attentionShort
            ? t('topbar.attention.compactName', { n: attention!.waiting + attention!.errors, name: attentionAriaLabel(locale, attention!.waiting, attention!.errors) })
            : attentionAriaLabel(locale, attention!.waiting, attention!.errors)}
          title={attentionTooltip(locale, attention!.waiting, attention!.errors, isVSCode)}
          className={`min-h-6 ${TOUCH_TARGET} shrink-0 whitespace-nowrap px-2 rounded font-bold ${FOCUS_RING}`}
          style={{
            background: COLORS.toggleInactive,
            border: `1px solid ${attention!.waiting > 0 ? COLORS.waiting_permission : COLORS.error}`,
            color: attention!.waiting > 0 ? COLORS.waiting_permission : COLORS.error,
          }}
        >
          <span aria-hidden="true">! </span>{attentionShort ? attention!.waiting + attention!.errors : attentionText}
        </button>
      )}

      {filtersInBar && filtersGroup(false)}

      {/* Spacer: the panels, Commands and More go to the right (under 768 px More alone, by its auto margin) */}
      <div data-topbar-spacer="" className="flex-1 max-md:hidden" />

      {(panelsInBar || (commandsInBar && onOpenPalette)) && (
        <div role="toolbar" aria-label={t('topbar.toolbar')} lang={locale} className="flex shrink-0 flex-nowrap items-center gap-1">
          {panelsInBar && panels(false)}
          {commandsInBar && commandsButton(false)}
        </div>
      )}

      <ToggleButton
        id={TOPBAR_MORE_ID}
        buttonRef={moreRef}
        active={moreOpen}
        onClick={() => setMoreOpen(v => !v)}
        ariaLabel={showFilterCount ? undefined : more.name}
        labelledBy={showFilterCount ? moreNameId : undefined}
        describedBy={holdsAny ? holdsId : undefined}
        title={more.help}
        lang={locale}
        expanded={moreOpen}
        controls={menuId}
        className="max-md:px-1"
        // Under 768 px the spacer is not drawn (its gap went to Sessions): the auto margin keeps More on the right. From
        // 768 px the spacer grows first, so this margin stays 0
        style={{ flexShrink: 0, whiteSpace: 'nowrap', marginLeft: 'auto' }}
      >
        {/* Under 768 px: an icon, then the number of filters on */}
        <MoreIcon />
        <span className="max-md:hidden">{showFilterCount ? more.withFilters(activeFilters.length) : more.more}</span>
        {showFilterCount && <span aria-hidden="true" className="hidden max-md:inline ml-1">{activeFilters.length}</span>}
        {moreMark && (
          // A shape, never a colour alone: a warning triangle, or a dot when More only holds figures; the words are its description
          <svg aria-hidden="true" focusable="false" data-more-mark={moreMark} width="10" height="10" viewBox="0 0 10 10" className="ml-1.5 shrink-0 max-md:ml-1">
            {moreMark === 'alert'
              ? <path d="M5 0.8 L9.6 9.2 L0.4 9.2 Z M5 3.6 V6.2 M5 7.4 V7.6" fill="none" stroke={COLORS.waiting_permission} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
              : <circle cx="5" cy="5" r="2.5" fill={COLORS.textMuted} />}
          </svg>
        )}
      </ToggleButton>
      {showFilterCount && (
        // The accessible name of More, in parts: each filter keeps the language of its button (read through aria-labelledby)
        <span id={moreNameId} hidden lang={locale}>
          {more.nameParts(activeFilters.length).before}
          {activeFilters.map((f, i) => (
            <Fragment key={f.text}>
              {i > 0 && ', '}
              <span lang={f.lang}>{f.text}</span>
            </Fragment>
          ))}
          {more.nameParts(activeFilters.length).after}
        </span>
      )}
      {holdsAny && (
        // The description of More: what it holds that the bar does not show, each part in its own language
        <span id={holdsId} hidden lang={locale}>
          {connectionDetailShown && (
            <span>{t('topbar.more.holds.connection')} <span lang={connectionDetailShown.lang} {...(connectionDetailShown.lang !== locale ? { 'data-i18n-exempt': '' } : {})}>{connectionDetailShown.text}</span>. </span>
          )}
          {notifyBlocked && <span>{t('topbar.notify.blocked')}. </span>}
          {scopeText && (scopeText.summary || scopeText.notices.length > 0 || scopeText.relay.length > 0 || scopeText.losses.length > 0) && (
            <span>
              {t('topbar.more.holds.scope')}{' '}
              {[scopeText.summary, ...scopeText.notices].filter(Boolean).join(' ')}
              {scopeText.relay.map((text, i) => <span key={`relay-${i}`} lang="en" data-i18n-exempt=""> {text}</span>)}
              {scopeText.losses.length > 0 && ` ${scopeText.losses.join(' ')}`}
              {'. '}
            </span>
          )}
          {quotaHeld && <span>{t('topbar.more.holds.quota')} {quotaHeld.text}.</span>}
        </span>
      )}
      {/* The discovery ceilings and the failures (#291) are announced from here, a polite live region that is in the DOM from
          the first render, empty while there is nothing to say: a region inserted with its text already in it is not
          announced by NVDA, JAWS and often VoiceOver (PR #631 review). It keeps its text while More is open, where the
          selector writes the same text without a live region of its own: nothing is announced twice, nor again on close */}
      <span role="status" data-topbar-scope-live="" className="sr-only" lang={locale}>
        {scopeText?.relay.map((text, i) => <span key={`relay-${i}`} lang="en" data-i18n-exempt="">{i > 0 && ' '}{text}</span>)}
        {scopeText && scopeText.notices.length > 0 && `${scopeText.relay.length > 0 ? ' ' : ''}${scopeText.notices.join(' ')}`}
      </span>

      {/* More: an overlay below the bar, after its button in the DOM (Tab goes from More into it). It never adds a row */}
      <div
        id={menuId}
        data-topbar-menu=""
        hidden={!moreOpen}
        className="absolute right-0 top-full mt-1 flex w-max max-w-[min(34rem,calc(100vw-24px))] max-h-[calc(100dvh-var(--topbar-h,60px)-8px)] flex-col gap-2 overflow-y-auto rounded-md max-md:left-0 max-md:w-auto max-md:max-w-none"
        style={{ background: 'var(--lens-bar-bg)', boxShadow: 'var(--lens-bar-shadow)', padding: 'var(--lens-bar-pad)', border: `1px solid ${COLORS.controlBorder}` }}
      >
        {moreOpen && (
          <>
            {(connectionDetailShown || (!connectionActionsInBar && ((offline && onRetryConnection) || (isDemo && onExitDemo)))) && (
              <div data-topbar-group="connection" className="flex flex-wrap items-center gap-2">
                {connectionDetailShown && (
                  <span data-testid="connection-detail" lang={connectionDetailShown.lang} {...(connectionDetailShown.lang !== locale ? { 'data-i18n-exempt': '' } : {})} style={{ color: COLORS.textMuted }}>
                    {connectionDetailShown.text}
                  </span>
                )}
                {!connectionActionsInBar && (
                  <ConnectionActions locale={locale} offline={offline} isDemo={isDemo} onRetry={onRetryConnection} onExitDemo={onExitDemo} labelRef={connectionLabelRef} />
                )}
              </div>
            )}
            {scope && <ScopeSelector {...scope} announce={false} />}
            {!filtersInBar && filtersGroup(true)}
            {showQuota && quotaState.kind !== 'hidden' && (
              <div data-topbar-group="status" className="flex flex-wrap items-center gap-2">
                <QuotaGauges state={quotaState} />
              </div>
            )}
            {!panelsInBar && (
              <div role="toolbar" aria-label={t('topbar.toolbar')} lang={locale} className="flex flex-wrap items-center gap-1">
                {panels(true)}
              </div>
            )}
            <div role="group" aria-label={t('topbar.menu.tools')} data-topbar-group="tools" className="flex flex-wrap items-center gap-1">
              {!commandsInBar && commandsButton(true)}
              <ToggleButton
                id="topbar-mute"
                active={!isMuted}
                onClick={onToggleMute}
                ariaLabel={isMuted ? t('topbar.unmute') : t('topbar.mute')}
                title={isMuted ? t('topbar.unmute.title') : t('topbar.mute.title')}
                lang={locale}
                shortcut="m"
              >
                {isMuted ? <MutedIcon /> : <UnmutedIcon />}
              </ToggleButton>
              {onToggleFullscreen && (
                <ToggleButton
                  id={FULLSCREEN_BUTTON_ID}
                  active={false}
                  onClick={fromMenu(onToggleFullscreen)}
                  ariaLabel={t('topbar.fullscreen')}
                  title={t('topbar.fullscreen.title')}
                  lang={locale}
                  shortcut="z"
                >
                  <FullscreenIcon />
                </ToggleButton>
              )}
              {onOpenSettings && (
                <ToggleButton
                  id="topbar-settings"
                  active={false}
                  onClick={fromMenu(onOpenSettings)}
                  ariaLabel={t('settings.title')}
                  title={t('topbar.settings.title')}
                  lang={locale}
                  shortcut=","
                  hasDialog
                >
                  <GearIcon />
                </ToggleButton>
              )}
              <ToggleButton
                id="topbar-shortcuts"
                active={false}
                onClick={fromMenu(onOpenShortcuts)}
                ariaLabel={t('topbar.shortcuts')}
                title={t('topbar.shortcuts.title')}
                lang={locale}
                shortcut="?"
                hasDialog
              >
                <span aria-hidden="true">?</span>
                <span aria-hidden="true" className="ml-1">{t('topbar.shortcuts.short')}</span>
              </ToggleButton>
            </div>
          </>
        )}
      </div>

      {/* The totals read by screen readers only (#523: no summary text drawn) */}
      <span data-testid="topbar-spoken-totals" lang={locale} className="sr-only">{spokenTotals}</span>
    </header>
  )
})
