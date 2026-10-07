"use client"

import { memo, useLayoutEffect, useRef } from "react"
import { Z } from "@/lib/agent-types"
import { COLORS } from "@/lib/colors"
import { formatTokens, formatCost } from "@/lib/utils"
import { FOCUS_RING, connectionDisplay, formatAgentCounts, type ConnectionTone } from "@/lib/chrome-utils"
import { SessionTabs } from "./session-tabs"
import type { SessionInfo, ConnectionStatus } from "@/lib/bridge-types"

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

// ─── Toggle Button ──────────────────────────────────────────────────────────

function ToggleButton({ active, pressed, onClick, children, style, activeColor, title, shortcut, ariaLabel, hasDialog }: {
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
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      aria-keyshortcuts={shortcut}
      aria-haspopup={hasDialog ? 'dialog' : undefined}
      title={title}
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

const TONE_COLOR: Record<ConnectionTone, string> = {
  ok: COLORS.complete,
  pending: COLORS.idle,
  error: COLORS.error,
  demo: COLORS.holoBright,
}

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
  // Session tabs
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
  // Connection
  isVSCode: boolean
  connectionStatus: ConnectionStatus
  /** True when the visualizer shows the built-in demo scenario instead of live data */
  isDemo?: boolean
  // Stats
  activeAgentCount: number
  doneAgentCount: number
  totalTokens: number
  /** Sum of per-agent costs, each priced with its own model */
  totalCost: number
  // Panel toggles
  showFileAttention: boolean
  showTranscript: boolean
  showCostOverlay: boolean
  showTimeline: boolean
  isMuted: boolean
  onTogglePanel: (panel: 'files' | 'transcript' | 'cost') => void
  onToggleTimeline: () => void
  onToggleMute: () => void
  /** Open the keyboard shortcuts dialog (also bound to `?`) */
  onOpenShortcuts: () => void
}

export const TopBar = memo(function TopBar({
  sessions, selectedSessionId, sessionsWithActivity,
  onSelectSession, onCloseSession,
  connectionStatus, isDemo = false,
  activeAgentCount, doneAgentCount, totalTokens, totalCost,
  showFileAttention, showTranscript, showCostOverlay, showTimeline, isMuted,
  onTogglePanel, onToggleTimeline, onToggleMute, onOpenShortcuts,
}: TopBarProps) {
  const rootRef = useRef<HTMLElement>(null)

  // Publish the measured height so panels can offset themselves below the (wrapping) bar.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const root = document.documentElement
    const publish = () => {
      // top offset (12px) + measured height + 8px breathing room
      root.style.setProperty('--topbar-h', `${Math.ceil(el.getBoundingClientRect().height) + 20}px`)
    }
    publish()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <header
      ref={rootRef}
      className="absolute top-3 left-3 right-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[11px]"
      style={{ zIndex: Z.info }}
    >
      {/* Session tabs — scrollable, always shown (even with one session) */}
      {sessions.length > 0 && (
        <div className="min-w-0 max-w-full flex-shrink overflow-x-auto scrollbar-hide -m-1 p-1">
          <SessionTabs
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            sessionsWithActivity={sessionsWithActivity}
            onSelectSession={onSelectSession}
            onCloseSession={onCloseSession}
          />
        </div>
      )}

      {/* Spacer pushes info to the right */}
      <div className="flex-1" />

      {/* Right-side info/controls */}
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1.5 min-w-0 max-w-full" style={{ color: COLORS.textMuted }}>
        <ConnectionIndicator status={connectionStatus} isDemo={isDemo} />
        <span>{formatAgentCounts(activeAgentCount, doneAgentCount)}</span>
        <span>
          {formatTokens(totalTokens)} tokens
          <span style={{ color: COLORS.complete + '65', marginLeft: 4 }}>
            ~{formatCost(totalCost)}
          </span>
        </span>

        <div role="toolbar" aria-label="View controls" className="flex flex-wrap items-center gap-1">
          {/* Mutually exclusive panel group */}
          <div role="group" aria-label="Side panels" className="flex items-center gap-1 px-1 py-0.5 rounded" style={{
            background: COLORS.holoBg03,
            border: `1px solid ${COLORS.holoBorder06}`,
          }}>
            <ToggleButton active={showFileAttention} pressed={showFileAttention} onClick={() => onTogglePanel('files')} title="Files (F)" shortcut="f" style={{ background: showFileAttention ? undefined : 'transparent', border: 'none' }}>Files</ToggleButton>
            <ToggleButton active={showTranscript} pressed={showTranscript} onClick={() => onTogglePanel('transcript')} title="Chat transcript (C)" shortcut="c" style={{ background: showTranscript ? undefined : 'transparent', border: 'none' }}>Chat</ToggleButton>
            <ToggleButton
              active={showCostOverlay}
              pressed={showCostOverlay}
              onClick={() => onTogglePanel('cost')}
              title="Cost overlay ($)"
              shortcut="$"
              activeColor={{ bg: COLORS.costActiveBg, text: COLORS.complete }}
              style={{ background: showCostOverlay ? undefined : 'transparent', border: 'none' }}
            >
              $Cost
            </ToggleButton>
          </div>

          {/* Independent toggles */}
          <ToggleButton active={showTimeline} pressed={showTimeline} onClick={onToggleTimeline} title="Timeline (T)" shortcut="t">Timeline</ToggleButton>
          <ToggleButton
            active={!isMuted}
            onClick={onToggleMute}
            ariaLabel={isMuted ? 'Unmute sound effects' : 'Mute sound effects'}
            title={isMuted ? 'Unmute (M)' : 'Mute (M)'}
            shortcut="m"
          >
            {isMuted ? <MutedIcon /> : <UnmutedIcon />}
          </ToggleButton>
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
