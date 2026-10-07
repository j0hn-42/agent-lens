'use client'

import { useId, useRef } from 'react'
import { CARD, Z, type AgentState } from '@/lib/agent-types'
import { COLORS, getStateColor } from '@/lib/colors'
import { formatTokens, formatModelName, formatDuration, pluralize } from '@/lib/utils'
import { GlassCard } from './glass-card'
import { PanelHeader, ProgressBar, useDialogBehavior, dialogEscapeHandler } from './shared-ui'
import { modelBadge, type ModelSource } from '@/lib/model-provenance'
import { useIssueLinks } from '@/hooks/use-issue-links'
import { agentRoleOf, issueLinkLabel, ISSUE_LINKS_SHOWN } from '@/lib/issue-links'
import { getStateLabel, getActivityLabel, safeLabel, safeTeamColor } from '@/lib/state-labels'

interface AgentDetailCardProps {
  agent: {
    id: string
    name: string
    state: AgentState
    model?: string
    modelSource?: ModelSource
    requestedModel?: string
    modelsUsed?: string[]
    effort?: string
    tokensUsed: number
    tokensMax: number
    toolCalls: number
    timeAlive: number
    currentTool?: string
    kind?: 'main' | 'subagent' | 'teammate'
    teamName?: string
    teamColor?: string
    activity?: 'working' | 'idle' | 'done'
    subagentType?: string
    agentType?: string
  }
  /** Origin of the relay API when a relay feeds the view (null: no relay, no issue links) */
  relayOrigin?: string | null
  onClose: () => void
}

export function AgentDetailCard({
  agent,
  relayOrigin = null,
  onClose,
}: AgentDetailCardProps) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  useDialogBehavior(ref, onClose, { ignoreSelector: '[data-companion-panel]' })
  const contextPercent = agent.tokensMax > 0 ? Math.round((agent.tokensUsed / agent.tokensMax) * 100) : 0
  const stateColor = getStateColor(agent.state)
  const badge = modelBadge(agent)
  const role = agentRoleOf(agent)
  const issueLinks = useIssueLinks(relayOrigin, role)
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
              <span className="flex flex-wrap items-center gap-x-2 text-[11px] font-mono" style={{ color: COLORS.textDim }}>
                <span>{formatModelName(agent.model)}</span>
                {badge && (
                  <span
                    data-testid="model-badge"
                    data-kind={badge.kind}
                    className="rounded px-1 text-[10px]"
                    style={{ border: `1px solid ${COLORS.glassBorder}`, color: badge.kind === 'mismatch' ? COLORS.toolIndicatorText : COLORS.textMuted }}
                  >
                    {badge.label}
                  </span>
                )}
                {agent.effort && <span data-testid="model-effort">effort {agent.effort}</span>}
              </span>
            )}
          </span>
        </PanelHeader>

        {/* Models that really ran (runtime-reported), and the requested one when it differs */}
        {(agent.modelsUsed?.length || (badge?.kind === 'mismatch' && agent.requestedModel)) && (
          <div className="mb-3 text-[11px] font-mono" style={{ color: COLORS.textDim }} data-testid="models-used">
            {badge?.kind === 'mismatch' && agent.requestedModel && (
              <div>Requested: {formatModelName(agent.requestedModel)}</div>
            )}
            {agent.modelsUsed && agent.modelsUsed.length > 0 && (
              <div>Used: {agent.modelsUsed.map(formatModelName).join(', ')}</div>
            )}
          </div>
        )}

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
          <span style={{ color: stateColor }}>{getStateLabel(agent.state)}</span>
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

        {/* Issues / PRs carrying the agent:<role> label of this node (silent when gh is unavailable) */}
        {role && issueLinks.length > 0 && (
          <div className="mt-3 text-[11px] font-mono" data-testid="issue-links">
            <div className="mb-1" style={{ color: COLORS.textMuted }}>agent:{role}</div>
            <ul className="flex flex-col gap-0.5" aria-label={`Issues and pull requests labelled agent:${role}`}>
              {issueLinks.slice(0, ISSUE_LINKS_SHOWN).map(link => (
                <li key={link.url} className="min-w-0">
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block truncate underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                    style={{ color: COLORS.textPrimary }}
                    title={issueLinkLabel(link)}
                  >
                    {issueLinkLabel(link)}
                  </a>
                </li>
              ))}
            </ul>
            {issueLinks.length > ISSUE_LINKS_SHOWN && (
              <div style={{ color: COLORS.textDim }}>+{issueLinks.length - ISSUE_LINKS_SHOWN} more</div>
            )}
          </div>
        )}
      </GlassCard>
    </div>
  )
}
