"use client"

import { Fragment, memo, useCallback, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
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
  moreText, selectionLabelText, unobservedSessionsText,
} from "@/lib/top-bar-text"
import { ACTIVE_WINDOW_MINUTES, type ShowMode } from "@/lib/show-mode"
import { useUnobservedSessionCount } from "@/hooks/use-unobserved-sessions"
import { ALL_SESSIONS_ID, type SessionInfo, type ConnectionStatus } from "@/lib/bridge-types"
import { useLocale } from "@/lib/locale"
import { translate, type Locale, type MessageKey } from "@/lib/messages"
import type { NotifyState } from "@/hooks/use-attention-alerts"
import { ScopeSelector, type ScopeSelectorProps } from "./scope-selector"
import { QuotaGauges } from "./quota-gauges"
import { quotaGaugeState, type QuotaSnapshotView } from "@/lib/quota"
import { useMinuteClock } from "@/hooks/use-minute-clock"
import { TOUCH_TARGET } from "@/lib/mobile-view"
import { isMobileView as isNarrow, subscribeMobileView as subscribeNarrow, isTopbarFolded, subscribeTopbarFold } from "@/hooks/use-mobile-view"
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

/** DOM id of More (under 1024 px, #523): the focus fallback of the panels whose button it folds (#476). */
export const TOPBAR_MORE_ID = 'topbar-more'

// ─── Toggle Button ──────────────────────────────────────────────────────────

function ToggleButton({ id, buttonRef, active, pressed, onClick, children, style, activeColor, title, shortcut, ariaLabel, labelledBy, hasDialog, keepsInspector, describedBy, expanded, controls, lang, barCue, wrap }: {
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
  /** Active, a 2 px bar under the button: the non-colour cue that still works on an icon (#523, WCAG 1.4.1) */
  barCue?: boolean
  /** Content wraps onto a second line instead of squeezing its first item (#595); the text is never cut */
  wrap?: boolean
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
      // Underline + bold is the non-colour cue for the active state (with the bar under a panel button)
      className={`min-h-6 min-w-6 ${TOUCH_TARGET} px-2 py-1 rounded transition-all inline-flex items-center ${wrap ? 'flex-wrap justify-start text-left gap-y-0.5' : 'justify-center'} text-[11px] ${active ? 'font-bold underline underline-offset-4 decoration-2' : ''} ${FOCUS_RING}`}
      style={{
        background: active ? (activeColor?.bg ?? COLORS.toggleActive) : COLORS.toggleInactive,
        border: `1px solid ${COLORS.controlBorder}`,
        color: active ? (activeColor?.text ?? COLORS.holoBright) : COLORS.textMuted,
        boxShadow: active && barCue ? `inset 0 -2px 0 ${activeColor?.text ?? COLORS.holoBright}` : undefined,
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
 * Shown in every mode. The text label (never colour alone) carries the state. While offline the reconnect detail
 * ("attempt 2, retry in 10s") is written next to it and in the tooltip, with a "Retry now" button (#371).
 * In demo, a button leaves it.
 */
function ConnectionIndicator({ locale, status, isDemo, detail, onRetry, onExitDemo }: {
  locale: Locale; status: ConnectionStatus; isDemo: boolean; detail?: string | null; onRetry?: () => void; onExitDemo?: () => void
}) {
  const display = connectionText(locale, status, isDemo, detail)
  const color = TONE_COLOR[display.tone]
  const offline = !isDemo && display.tone === 'error'
  // The buttons disappear once used (state changes): hand focus to the label so it is not lost on <body> (2.4.3)
  const labelRef = useRef<HTMLSpanElement>(null)
  const then = (fn?: () => void) => () => { labelRef.current?.focus({ preventScroll: true }); fn?.() }
  const buttonClass = `min-h-6 min-w-6 ${TOUCH_TARGET} px-2 rounded text-xs font-semibold ${FOCUS_RING}`
  const buttonStyle = { background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span ref={labelRef} tabIndex={-1} title={display.description} className="flex items-center gap-1.5 font-semibold outline-none" style={{ color }}>
        <span
          aria-hidden="true"
          className={`w-2 h-2 rounded-full ${display.tone === 'pending' ? 'motion-safe:animate-pulse' : ''}`}
          style={{ background: display.tone === 'error' ? 'transparent' : color, border: `2px solid ${color}`, boxShadow: `0 0 4px ${color}` }}
        />
        {display.label}
      </span>
      {offline && display.detail && <span data-testid="connection-detail" lang={display.detail.lang} {...(display.detail.lang !== locale ? { 'data-i18n-exempt': '' } : {})} style={{ color: COLORS.textMuted }}>{display.detail.text}</span>}
      {offline && onRetry && (
        <button type="button" data-testid="retry-connection" onClick={then(onRetry)} className={buttonClass} style={buttonStyle}>
          {translate(locale, 'topbar.connection.retry')}
        </button>
      )}
      {isDemo && onExitDemo && (
        <button type="button" data-testid="exit-demo" onClick={then(onExitDemo)} className={buttonClass} style={buttonStyle}>
          {translate(locale, 'topbar.connection.exitDemo')}
        </button>
      )}
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
  /** Scope of the session discovery (#291): shown permanently when a relay reports its scope */
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
  // Under 1024 px (#523; 768 px in #476, 600 px in #378) the filters, the quota gauges, the panel buttons and the tools
  // fold behind a disclosure button; the drawers and the 44 px targets stay under 768 px (mobile view). Folded, the
  // buttons are not rendered (no hidden Tab stop). Commands stays
  // in the folded bar from 768 px, where there is room for it.
  const [moreOpen, setMoreOpen] = useState(false)
  const filtersId = useId()
  const row2Id = useId()
  const moreNameId = useId()
  const hiddenFinishedId = useId()
  // Crossing 1024 or 768 px (resize, browser zoom) unmounts More or a folded control: keep the focus out of <body>
  // (2.4.3). The focus is read in the media query handlers, before React renders the new width.
  const filtersRef = useRef<HTMLDivElement>(null)
  const row2Ref = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const refocusAfterWiden = useRef(false)
  const paletteRef = useRef<HTMLButtonElement>(null)
  const refocusAfterNarrow = useRef(false)
  const subscribeFold = useCallback((onChange: () => void) => subscribeTopbarFold(() => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    if (isTopbarFolded()) {
      // A control that folds has the focus: open More in the same render, so it stays mounted (Commands does not fold)
      const folds = !!active && active !== paletteRef.current && (!!filtersRef.current?.contains(active) || !!row2Ref.current?.contains(active))
      if (folds) setMoreOpen(true)
    } else if (active && active === moreRef.current) {
      refocusAfterWiden.current = true
    }
    onChange()
  }), [])
  const foldNarrow = useSyncExternalStore(subscribeFold, isTopbarFolded, () => false)
  const subscribeMobile = useCallback((onChange: () => void) => subscribeNarrow(() => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    // Commands is not drawn under 768 px: its focus goes to More
    if (isNarrow() && active && active === paletteRef.current) refocusAfterNarrow.current = true
    onChange()
  }), [])
  const narrow = useSyncExternalStore(subscribeMobile, isNarrow, () => false)
  useLayoutEffect(() => {
    if (!narrow || !refocusAfterNarrow.current) return
    refocusAfterNarrow.current = false
    moreRef.current?.focus({ preventScroll: true })
  }, [narrow])
  useLayoutEffect(() => {
    if (foldNarrow || !refocusAfterWiden.current) return
    refocusAfterWiden.current = false
    // More is gone: the first filter takes the focus, else the first view control
    const target = filtersRef.current?.querySelector<HTMLElement>('button')
      ?? rootRef.current?.querySelector<HTMLElement>('[role="toolbar"] button')
    target?.focus({ preventScroll: true })
  }, [foldNarrow])
  const folded = foldNarrow && !moreOpen
  // While a tooltip of the bar is open the bar rises above the docked panels, which the tooltip is drawn over (#497 review)
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
  // Folded, the filters that change what the canvas shows are named on More, never hidden behind it (reading-the-ui.md)
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
  const showFilterCount = folded && activeFilters.length > 0
  // Folded (under 1024 px) a panel button folds More again and the focus waits on More (the button is gone). Under 768 px
  // the panel opens as a drawer below the short bar, which takes the focus; More is where it comes back when it closes
  const thenFold = (fn: () => void) => () => {
    fn()
    if (!foldNarrow) return
    setMoreOpen(false)
    moreRef.current?.focus({ preventScroll: true })
  }

  // Publish the measured height so panels can offset themselves below the (wrapping) bar.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    return observeTopbarHeight(el, document.documentElement, typeof ResizeObserver === 'undefined' ? undefined : ResizeObserver)
  }, [])

  // A panel button: an icon under 1280 px, its name from 1280 px (CSS only, so the DOM and the Tab order never change).
  // The accessible name is the same at every width (2.5.3, 4.1.2) and starts with the visible label; the tooltip names it.
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
            barCue
            style={inGroup ? { background: active ? undefined : 'transparent', border: 'none' } : undefined}
          >
            <PanelIcon panel={panel} />
            <span data-panel-label="" className="max-xl:sr-only">{name.replace(/ \([A-Z]\)$/, '')}</span>
          </ToggleButton>
        )}
      </TopBarTooltip>
    )
  }

  // One DOM order at every width (#523). From 1024 px the bar is two rows with a fixed content: row 1 = Sessions, scope,
  // connection state, attention, then the filters; row 2 = the quota gauges, then the panel buttons
  // and the tools. Under 1024 px the rows and groups are plain boxes (display: contents): the bar is one folded row,
  // More expands it, and an expanded bar taller than the window scrolls under 768 px (#476).
  const ROW = 'max-lg:contents lg:flex lg:w-full lg:flex-wrap lg:items-center lg:gap-x-4 lg:gap-y-1.5'
  const GROUP = 'max-lg:contents lg:flex lg:flex-wrap lg:items-center'
  return (
    <header
      ref={rootRef}
      lang={locale}
      className="absolute top-3 left-3 right-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md font-mono text-[11px] max-md:max-h-[calc(100dvh-24px)] max-md:overflow-y-auto"
      style={{ zIndex: openTooltips > 0 ? Z.topBarRaised : Z.topBar, background: 'var(--lens-bar-bg)', boxShadow: 'var(--lens-bar-shadow)', padding: 'var(--lens-bar-pad)', color: COLORS.textMuted }}
    >
      <div data-topbar-row="1" className={ROW}>
        <div data-topbar-group="identity" className={`${GROUP} gap-x-4 gap-y-1.5 min-w-0`}>
          {/* Sessions button: opens the list of sessions and agents (always shown, even with one session) */}
          <ToggleButton
            id={PANEL_BUTTON_IDS.sessions}
            active={showSessions}
            pressed={showSessions}
            onClick={onToggleSessions}
            title={t('topbar.sessions.title')}
            lang={locale}
            shortcut="l"
            keepsInspector
            wrap
            style={{ maxWidth: 'min(320px, 100%)' }}
          >
            {/* The « all sessions » label wraps (#595); a named selection keeps one line, ending in an ellipsis past the button width, so a long name does not grow the bar */}
            <span className={`min-w-0 max-w-full ${selectedSessionId === null || selectedSessionId === ALL_SESSIONS_ID ? 'break-words' : 'truncate'}`} data-sensitive="">{t('topbar.sessions.button', { label: selectionLabelText(locale, selectedSessionId, sessions, teams) })}</span>
            <span className="ml-1.5 shrink-0" style={{ color: COLORS.textDim }}>({sessions.length})</span>
            {lossMarked && (
              // A symbol, never a colour alone; its words are read with the button name
              <span data-loss-mark="" className="ml-1.5 shrink-0">
                <span aria-hidden="true" title={t('truncation.topbarMark')}>⚠</span>
                <span className="sr-only">, {t('truncation.topbarMark')}</span>
              </span>
            )}
            {unobservedCount > 0 && (
              <span className="ml-1.5 shrink-0" style={{ color: COLORS.textMuted }} title={sessionStatusHelp(locale, 'unobserved')}>
                {unobservedSessionsText(locale, unobservedCount)}
              </span>
            )}
            {sessionsWithActivity.size > 0 && (
              <>
                <span aria-hidden="true" className="ml-1.5 inline-block w-2 h-2 shrink-0 rounded-full motion-safe:animate-pulse" style={{ border: `2px solid ${COLORS.complete}` }} />
                <span className="sr-only">, {t('topbar.sessions.newActivity')}</span>
              </>
            )}
          </ToggleButton>

          {scope && <ScopeSelector {...scope} />}

          <ConnectionIndicator locale={locale} status={connectionStatus} isDemo={isDemo} detail={connectionDetail} onRetry={onRetryConnection} onExitDemo={onExitDemo} />
          {attentionText && onJumpToAttention && (
            <button
              type="button"
              data-testid="attention-counter"
              onClick={onJumpToAttention}
              lang={locale}
              aria-label={attentionAriaLabel(locale, attention!.waiting, attention!.errors)}
              title={attentionTooltip(locale, attention!.waiting, attention!.errors, isVSCode)}
              className={`min-h-6 ${TOUCH_TARGET} px-2 rounded font-bold ${FOCUS_RING}`}
              style={{
                background: COLORS.toggleInactive,
                border: `1px solid ${attention!.waiting > 0 ? COLORS.waiting_permission : COLORS.error}`,
                color: attention!.waiting > 0 ? COLORS.waiting_permission : COLORS.error,
              }}
            >
              <span aria-hidden="true">! </span>{attentionText}
            </button>
          )}
        </div>

        {/* Spacer: the filters (or More) go to the right */}
        <div data-topbar-spacer="" className="flex-1" />

        {foldNarrow && (
          <ToggleButton
            id={TOPBAR_MORE_ID}
            buttonRef={moreRef}
            active={moreOpen}
            onClick={() => setMoreOpen(v => !v)}
            ariaLabel={showFilterCount ? undefined : more.name}
            labelledBy={showFilterCount ? moreNameId : undefined}
            title={more.help}
            lang={locale}
            expanded={moreOpen}
            controls={`${filtersId} ${row2Id}`}
          >
            {showFilterCount ? more.withFilters(activeFilters.length) : more.more}
          </ToggleButton>
        )}
        {foldNarrow && showFilterCount && (
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

        <div id={filtersId} ref={filtersRef} data-topbar-group="filters" className={`${GROUP} justify-end gap-x-4 gap-y-1.5`}>
          {!folded && notifyState !== 'unsupported' && onToggleNotify && (
            <ToggleButton
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
          {!folded && onChangeShowMode && (
            <Fragment>
              <ToggleButton
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
      </div>

      <div id={row2Id} ref={row2Ref} data-topbar-row="2" className={ROW}>
        {/* Quota gauges, and the totals read by screen readers only (#523: no summary text drawn) */}
        <div data-topbar-group="status" className={folded ? 'sr-only' : `${GROUP} gap-x-4 gap-y-1.5 min-w-0`}>
          <span data-testid="topbar-spoken-totals" lang={locale} className="sr-only">{spokenTotals}</span>
          {showQuota && <QuotaGauges state={quotaState} interactive={!folded} />}
        </div>

        <div data-topbar-spacer="" className="flex-1" />

        {/* Under 768 px with More folded nothing of it is drawn (Commands is not drawn there) */}
        {!(folded && narrow) && (
        <div role="toolbar" aria-label={t('topbar.toolbar')} lang={locale} className="flex flex-wrap items-center gap-1 lg:justify-end">
          {!folded && (
          <div data-topbar-group="panels" className={`${GROUP} gap-1`}>
            {/* Side panels: Files, Conversation and Context are mutually exclusive; System and Cost open beside them */}
            {/* Wraps like the toolbar: at 320 px the five toggles do not fit on one line (WCAG 1.4.10) */}
            <div role="group" aria-label={t('topbar.sidePanels')} className="flex flex-wrap items-center gap-1 px-1 py-0.5 rounded" style={{
              background: COLORS.holoBg03,
              border: `1px solid ${COLORS.holoBorder06}`,
            }}>
              {panelButton('files', { active: showFileAttention, onClick: thenFold(() => onTogglePanel('files')), shortcut: 'f', inGroup: true })}
              {panelButton('conversation', { active: showConversation, onClick: thenFold(() => onTogglePanel('conversation')), shortcut: 'c', inGroup: true })}
              {panelButton('context', {
                active: showContext, onClick: thenFold(() => onTogglePanel('context')), shortcut: 'p', inGroup: true,
                ...(isVSCode ? { tooltip: t('topbar.context.vscode') } : {}),
              })}
              {panelButton('system', { active: showSystem, onClick: thenFold(() => onTogglePanel('system')), shortcut: 'y', inGroup: true })}
              {panelButton('cost', {
                active: showCostOverlay, onClick: () => onTogglePanel('cost'), shortcut: '$', inGroup: true,
                activeColor: { bg: COLORS.costActiveBg, text: COLORS.complete },
              })}
            </div>

            {/* Independent toggles */}
            {panelButton('timeline', { active: showTimeline, onClick: thenFold(onToggleTimeline), shortcut: 't', inGroup: false })}
            {panelButton('stats', { active: showStats, onClick: onToggleStats, shortcut: 's', inGroup: false })}
          </div>
          )}
          <div data-topbar-group="tools" className={`${GROUP} gap-1`}>
            {!folded && (
              <ToggleButton
                active={!isMuted}
                onClick={onToggleMute}
                ariaLabel={isMuted ? t('topbar.unmute') : t('topbar.mute')}
                title={isMuted ? t('topbar.unmute.title') : t('topbar.mute.title')}
                lang={locale}
                shortcut="m"
              >
                {isMuted ? <MutedIcon /> : <UnmutedIcon />}
              </ToggleButton>
            )}
            {!folded && onToggleFullscreen && (
              <ToggleButton
                id={FULLSCREEN_BUTTON_ID}
                active={false}
                onClick={onToggleFullscreen}
                ariaLabel={t('topbar.fullscreen')}
                title={t('topbar.fullscreen.title')}
                lang={locale}
                shortcut="z"
              >
                <FullscreenIcon />
              </ToggleButton>
            )}
            {/* Kept in the folded bar from 768 px; not under 768 px: one more button wraps the folded bar onto another row (#378 height budget) */}
            {onOpenPalette && !narrow && (
              <ToggleButton
                buttonRef={paletteRef}
                active={false}
                onClick={onOpenPalette}
                ariaLabel={t('topbar.commands')}
                title={t('topbar.commands.title')}
                lang={locale}
                shortcut="Control+K Meta+K"
                hasDialog
              >
                <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="7" cy="7" r="5" />
                  <path d="M11 11l4 4" />
                </svg>
                <span aria-hidden="true" className="ml-1 hidden sm:inline">{t('topbar.commands')}</span>
              </ToggleButton>
            )}
            {!folded && onOpenSettings && (
              <ToggleButton
                active={false}
                onClick={onOpenSettings}
                ariaLabel={t('settings.title')}
                title={t('topbar.settings.title')}
                lang={locale}
                shortcut=","
                hasDialog
              >
                <GearIcon />
              </ToggleButton>
            )}
            {!folded && (
              <ToggleButton
                active={false}
                onClick={onOpenShortcuts}
                ariaLabel={t('topbar.shortcuts')}
                title={t('topbar.shortcuts.title')}
                lang={locale}
                shortcut="?"
                hasDialog
              >
                <span aria-hidden="true">?</span>
                <span aria-hidden="true" className="ml-1 hidden sm:inline">{t('topbar.shortcuts.short')}</span>
              </ToggleButton>
            )}
          </div>
        </div>
        )}
      </div>
    </header>
  )
})
