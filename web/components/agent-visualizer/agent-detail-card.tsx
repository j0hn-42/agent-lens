'use client'

import { useId, useRef } from 'react'
import { CARD, Z, type AgentState } from '@/lib/agent-types'
import { COLORS, getStateColor } from '@/lib/colors'
import { formatTokens, formatModelName, formatDuration, pluralize } from '@/lib/utils'
import { GlassCard } from './glass-card'
import { PanelHeader, ProgressBar, useDialogBehavior, dialogEscapeHandler } from './shared-ui'
import { getStateLabel, getActivityLabel, safeLabel, safeTeamColor } from '@/lib/state-labels'
import { useFreshnessValue, type FreshnessClock } from '@/hooks/use-freshness-clock'
import { deriveFreshness, lastKnownStateText, type Freshness } from '@/hooks/simulation/freshness'
import { goneText } from '@/lib/inspector-model'

interface AgentDetailCardProps {
  agent: {
    id: string
    name: string
    state: AgentState
    model?: string
    tokensUsed: number
    tokensMax: number
    toolCalls: number
    timeAlive: number
    currentTool?: string
    kind?: 'main' | 'subagent' | 'teammate'
    teamName?: string
    teamColor?: string
    activity?: 'working' | 'idle' | 'done'
    /** The node's OWN last event (wall clock) and where it comes from: never the anchor session's */
    lastEventAt?: number
    freshnessSource?: 'live' | 'history'
    sessionLabel?: string
  }
  /** Tool errors of this node only (cumulative, Agent.toolErrors); absent = not counted, nothing shown */
  toolErrors?: number
  onClose: () => void
  /** Freshness clock override for tests */
  freshnessClock?: FreshnessClock
}

const FRESHNESS_TEXT: Record<Freshness, string> = {
  fresh: 'Live',
  stale: 'No longer reporting',
  interrupted: 'Interrupted',
  error: 'Failed',
  closed: 'Closed',
  'never-observed': 'Not observed yet',
}

function formatClockTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function AgentDetailCard({
  agent,
  toolErrors,
  onClose,
  freshnessClock,
}: AgentDetailCardProps) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  useDialogBehavior(ref, onClose, { ignoreSelector: '[data-companion-panel]' })
  const contextPercent = agent.tokensMax > 0 ? Math.round((agent.tokensUsed / agent.tokensMax) * 100) : 0
  const stateColor = getStateColor(agent.state)
  // Freshness of THIS node only; re-renders when it crosses a threshold, not on every tick
  const freshness = useFreshnessValue(t => deriveFreshness(agent, t), freshnessClock)
  const stateText = freshness === 'stale' ? lastKnownStateText(agent.state) : getStateLabel(agent.state)
  const sessionLabel = safeLabel(agent.sessionLabel)
  const teamName = safeLabel(agent.teamName)
  const teamColor = safeTeamColor(agent.teamColor)

  // Fixed position: middle-left of the screen (below message feed panel)
  const left = CARD.margin
  const top = typeof window !== 'undefined' ? Math.max(100, (window.innerHeight - CARD.detail.height) / 2) : 300

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={dialogEscapeHandler(onClose)}
      className="agent-detail-card max-w-[calc(100vw-24px)] outline-none"
      style={{
        position: 'absolute',
        left,
        top,
        width: CARD.detail.width,
        zIndex: Z.detailCard,
      }}
    >
      <GlassCard visible={true}>
        <PanelHeader onClose={onClose} className="mb-3" titleId={titleId}>
          <span
            aria-hidden="true"
            className="w-2 h-2 rounded-full"
            style={{ background: stateColor, boxShadow: `0 0 8px ${stateColor}` }}
          />
          <span className="flex flex-col">
            <span className="text-xs font-mono" style={{ color: COLORS.textPrimary }}>
              {agent.name}
            </span>
            {agent.model && (
              <span className="text-[11px] font-mono" style={{ color: COLORS.textDim }}>
                {formatModelName(agent.model)}
              </span>
            )}
          </span>
        </PanelHeader>

        {/* Context bar */}
        <div className="mb-3">
          <div className="flex justify-between mb-1">
            <span className="text-[11px]" style={{ color: COLORS.textMuted }}>Context</span>
            <span className="text-[11px] font-mono" style={{ color: COLORS.textDim }}>
              {formatTokens(agent.tokensUsed)} / {formatTokens(agent.tokensMax)} ({contextPercent}%)
            </span>
          </div>
          {/* Textual value is adjacent, so the bar itself is decorative */}
          <ProgressBar percent={contextPercent} color={stateColor} />
        </div>

        {/* Stats row */}
        <div className="flex gap-3 mb-3 text-[11px] font-mono" style={{ color: COLORS.textDim }}>
          <span>{pluralize(agent.toolCalls, 'tool')}</span>
          <span>{formatDuration(agent.timeAlive)} alive</span>
          <span style={{ color: freshness === 'stale' ? COLORS.textMuted : stateColor }}>{stateText}</span>
        </div>

        {/* Own freshness, clock and errors (never borrowed from the anchor session) */}
        <div className="flex flex-wrap gap-x-3 gap-y-1 mb-3 text-[11px] font-mono" style={{ color: COLORS.textDim }} data-inspector-own>
          <span data-testid="inspector-freshness">{FRESHNESS_TEXT[freshness]}</span>
          <span data-testid="inspector-last-event">
            {typeof agent.lastEventAt === 'number' && Number.isFinite(agent.lastEventAt)
              ? `last event ${formatClockTime(agent.lastEventAt)}${agent.freshnessSource === 'history' ? ' (history)' : ''}`
              : 'no event observed'}
          </span>
          {typeof toolErrors === 'number' && (
            <span data-testid="inspector-errors" style={{ color: toolErrors > 0 ? COLORS.error : undefined }}>
              {pluralize(toolErrors, 'tool error')}
            </span>
          )}
          {sessionLabel && <span className="truncate">{sessionLabel}</span>}
        </div>

        {/* Teammate info */}
        {agent.kind === 'teammate' && (
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono" style={{ color: COLORS.textDim }}>
            <span>Teammate</span>
            {teamName && (
              <span className="flex min-w-0 items-center gap-1">
                {teamColor && (
                  <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: teamColor }} />
                )}
                <span className="truncate">Team {teamName}</span>
              </span>
            )}
            {agent.activity && <span>{getActivityLabel(agent.activity)}</span>}
          </div>
        )}

        {/* Current tool */}
        {agent.currentTool && (
          <div
            className="mb-3 px-2 py-1.5 rounded text-[11px] font-mono flex items-center gap-2"
            style={{
              background: COLORS.toolIndicatorBg,
              border: `1px solid ${COLORS.toolIndicatorBorder}`,
              color: COLORS.toolIndicatorText,
            }}
          >
            <span className="animate-spin motion-reduce:animate-none inline-block" aria-hidden="true">⚙</span>
            {agent.currentTool}
          </div>
        )}
      </GlassCard>
    </div>
  )
}

/**
 * Shown when the selected node left the graph (closed, hidden, session removed): says so instead of
 * keeping the old values or substituting another node's.
 */
export function AgentGoneCard({ name, onClose }: { name: string | null; onClose: () => void }) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  useDialogBehavior(ref, onClose, { ignoreSelector: '[data-companion-panel]' })
  const top = typeof window !== 'undefined' ? Math.max(100, (window.innerHeight - CARD.detail.height) / 2) : 300
  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={dialogEscapeHandler(onClose)}
      className="agent-detail-card max-w-[calc(100vw-24px)] outline-none"
      style={{ position: 'absolute', left: CARD.margin, top, width: CARD.detail.width, zIndex: Z.detailCard }}
    >
      <GlassCard visible={true}>
        <PanelHeader onClose={onClose} className="mb-1" titleId={titleId}>
          <span role="status" className="text-xs font-mono" style={{ color: COLORS.textMuted }} data-testid="inspector-gone">
            {goneText(name)}
          </span>
        </PanelHeader>
      </GlassCard>
    </div>
  )
}
