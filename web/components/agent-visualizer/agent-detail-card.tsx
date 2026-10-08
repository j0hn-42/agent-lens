'use client'

import { useId, useRef } from 'react'
import { Z, type AgentState } from '@/lib/agent-types'
import { COLORS, getStateColor } from '@/lib/colors'
import { formatTokens, formatModelName, formatDuration, pluralize } from '@/lib/utils'
import { parseMcpTool, formatToolName } from '@/lib/mcp-tool'
import { formatTokenUsage, usageFromAgent, type UsageStatus } from '@/lib/usage'
import { GlassCard } from './glass-card'
import { PanelHeader, ProgressBar, useDialogBehavior, dialogEscapeHandler, useDockPanel, dockAttrs } from './shared-ui'
import { getStateLabel, getActivityLabel, safeLabel, safeTeamColor } from '@/lib/state-labels'
import { groupHeading } from '@/lib/ui-glossary'

interface AgentDetailCardProps {
  agent: {
    id: string
    name: string
    state: AgentState
    model?: string
    tokensUsed: number
    tokenStatus?: UsageStatus
    tokensEstimated?: boolean
    tokensMax: number
    toolCalls: number
    timeAlive: number
    currentTool?: string
    kind?: 'main' | 'subagent' | 'teammate'
    teamName?: string
    teamColor?: string
    teamKind?: 'team' | 'workflow'
    activity?: 'working' | 'idle' | 'done'
  }
  onClose: () => void
  /** Escape pressed inside the card; defaults to onClose. The shell uses it to close newer panels first. */
  onEscape?: () => void
}

export function AgentDetailCard({
  agent,
  onClose,
  onEscape,
}: AgentDetailCardProps) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  useDialogBehavior(ref, onClose, { ignoreSelector: '[data-companion-panel]' })
  const contextPercent = agent.tokensMax > 0 ? Math.round((agent.tokensUsed / agent.tokensMax) * 100) : 0
  const stateColor = getStateColor(agent.state)
  const teamName = safeLabel(agent.teamName)
  const teamColor = safeTeamColor(agent.teamColor)

  // Left dock: placed by the shared layout (below the message feed, above the control bar, never over a panel)
  const dock = useDockPanel('detail', true)
  const { rect } = dock

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={dialogEscapeHandler(onEscape ?? onClose)}
      {...dockAttrs('detail', 'left', dock)}
      className="agent-detail-card outline-none"
      style={{
        position: 'absolute',
        left: rect?.x ?? 12,
        top: rect?.y ?? 'calc(var(--topbar-h, 60px) + 8px)',
        width: rect?.w ?? 240,
        zIndex: Z.detailCard,
        display: dock.hidden ? 'none' : undefined,
      }}
    >
      <GlassCard visible={true} style={rect ? { maxHeight: rect.h, overflowY: 'auto' } : undefined}>
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
              {formatTokenUsage(usageFromAgent(agent))} / {formatTokens(agent.tokensMax)}{agent.tokenStatus === 'unavailable' ? '' : ` (${agent.tokenStatus === 'partial' ? '≥ ' : ''}${contextPercent}%)`}
            </span>
          </div>
          {/* Textual value is adjacent, so the bar itself is decorative */}
          <ProgressBar percent={contextPercent} color={stateColor} />
        </div>

        {/* Stats row */}
        <div className="flex gap-3 mb-3 text-[11px] font-mono" style={{ color: COLORS.textDim }}>
          <span>{pluralize(agent.toolCalls, 'tool')}</span>
          <span>{formatDuration(agent.timeAlive)} alive</span>
          <span style={{ color: stateColor }}>{getStateLabel(agent.state)}</span>
        </div>

        {/* Teammate info */}
        {agent.kind === 'teammate' && (
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono" style={{ color: COLORS.textDim }}>
            <span>{agent.teamKind === 'workflow' ? 'Workflow agent' : 'Teammate'}</span>
            {teamName && (
              <span className="flex min-w-0 items-center gap-1">
                {teamColor && (
                  <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: teamColor }} />
                )}
                <span className="truncate">{groupHeading(agent.teamKind, teamName)}</span>
              </span>
            )}
            {agent.activity && <span>{getActivityLabel(agent.activity)}</span>}
          </div>
        )}

        {/* Current tool */}
        {agent.currentTool && (() => {
          const mcp = parseMcpTool(agent.currentTool)
          return (
            <div
              className="mb-3 px-2 py-1.5 rounded text-[11px] font-mono flex items-center gap-2"
              style={mcp ? {
                background: COLORS.mcpIndicatorBg,
                border: `1px solid ${COLORS.mcpIndicatorBorder}`,
                color: COLORS.mcp,
              } : {
                background: COLORS.toolIndicatorBg,
                border: `1px solid ${COLORS.toolIndicatorBorder}`,
                color: COLORS.toolIndicatorText,
              }}
            >
              <span className="animate-spin motion-reduce:animate-none inline-block" aria-hidden="true">{mcp ? '◌' : '⚙'}</span>
              {mcp && <span className="uppercase tracking-wide opacity-80">MCP</span>}
              {formatToolName(agent.currentTool)}
            </div>
          )
        })()}
      </GlassCard>
    </div>
  )
}
