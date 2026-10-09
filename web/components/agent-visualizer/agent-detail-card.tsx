'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Z, type AgentState } from '@/lib/agent-types'
import { COLORS, getStateColor } from '@/lib/colors'
import { formatTokens, formatModelName, formatDuration, pluralize } from '@/lib/utils'
import { parseMcpTool, formatToolName } from '@/lib/mcp-tool'
import { formatTokenUsage, usageFromAgent, type UsageStatus } from '@/lib/usage'
import { GlassCard } from './glass-card'
import { ActiveTimeStat } from './active-time-stat'
import { PanelHeader, ProgressBar, INSPECTOR_IGNORE_SELECTOR, useDialogBehavior, dialogEscapeHandler, useDockPanel, dockAttrs } from './shared-ui'
import { modelBadge, type ModelSource } from '@/lib/model-provenance'
import { useIssueLinks } from '@/hooks/use-issue-links'
import { agentRoleOf, issueLinkLabel, ISSUE_LINKS_SHOWN } from '@/lib/issue-links'
import { getStateLabel, getActivityLabel, safeLabel, safeTeamColor } from '@/lib/state-labels'
import { groupHeading } from '@/lib/ui-glossary'
import { useFreshnessValue, type FreshnessClock } from '@/hooks/use-freshness-clock'
import { deriveFreshness, lastKnownStateText, type Freshness } from '@/hooks/simulation/freshness'
import { goneText } from '@/lib/inspector-model'

interface AgentDetailCardProps {
  agent: {
    id: string
    name: string
    state: AgentState
    sessionId?: string
    model?: string
    modelSource?: ModelSource
    requestedModel?: string
    modelsUsed?: string[]
    effort?: string
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
    /** The node's OWN last event (wall clock) and where it comes from: never the anchor session's */
    lastEventAt?: number
    freshnessSource?: 'live' | 'history'
    sessionLabel?: string
    activeMs?: number
    activeSince?: number
    subagentType?: string
    agentType?: string
  }
  /** Tool errors of this node only (cumulative, Agent.toolErrors); absent = not counted, nothing shown */
  toolErrors?: number
  /** Origin of the relay API when a relay feeds the view (null: no relay, no issue links) */
  relayOrigin?: string | null
  onClose: () => void
  /** Escape pressed inside the card; defaults to onClose. The shell uses it to close newer panels first. */
  onEscape?: () => void
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
  relayOrigin = null,
  onClose,
  onEscape,
  freshnessClock,
}: AgentDetailCardProps) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  // Left dock: placed by the shared layout (below the message feed, above the control bar, never over a panel)
  const dock = useDockPanel('detail', true)
  const { rect } = dock
  // Hidden behind a sheet (narrow viewport): moving focus elsewhere must not clear the selection
  useDialogBehavior(ref, onClose, { ignoreSelector: INSPECTOR_IGNORE_SELECTOR, closeOnFocusOutside: !dock.hidden })
  const contextPercent = agent.tokensMax > 0 ? Math.round((agent.tokensUsed / agent.tokensMax) * 100) : 0
  const stateColor = getStateColor(agent.state)
  // Freshness of THIS node only; re-renders when it crosses a threshold, not on every tick
  const freshness = useFreshnessValue(t => deriveFreshness(agent, t), freshnessClock)
  const stateText = freshness === 'stale' ? lastKnownStateText(agent.state) : getStateLabel(agent.state)
  const sessionLabel = safeLabel(agent.sessionLabel)
  const badge = modelBadge(agent)
  const role = agentRoleOf(agent)
  const { links: issueLinks, status: issueLinksStatus } = useIssueLinks(relayOrigin, role, agent.sessionId)
  const teamName = safeLabel(agent.teamName)
  const teamColor = safeTeamColor(agent.teamColor)

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
        <div className="mb-3 text-[11px] font-mono" style={{ color: COLORS.textDim }}>
          <ActiveTimeStat agent={agent} />
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

        {/* Issues / PRs carrying the agent:<role> label of this node. A failed load is said to be unavailable, never shown as "no link" (#149) */}
        {role && issueLinksStatus === 'unavailable' && (
          <div className="mt-3 text-[11px] font-mono" data-testid="issue-links-unavailable">
            <div className="mb-1" style={{ color: COLORS.textMuted }}>agent:{role}</div>
            <p role="status" className="m-0" style={{ color: COLORS.textDim }}>Issue and PR links unavailable for now.</p>
          </div>
        )}
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
                    className="block truncate underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--lens-focus-strong)]"
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

function focusIsBusy(el: Element | null): boolean {
  if (!el || el === document.body) return false
  if (el.closest('[data-companion-panel]')) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || (el as HTMLElement).isContentEditable === true
}

/**
 * Shown when the selected node left the graph (closed, hidden, session removed): says so instead of
 * keeping the old values or substituting another node's.
 */
export function AgentGoneCard({ name, onClose, onEscape }: { name: string | null; onClose: () => void; onEscape?: () => void }) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  // Opened by a data event, not a gesture: never pull focus from a companion panel or a text field (WCAG 3.2.2).
  // The role="status" text still announces it.
  const [focusOnOpen] = useState(() => !focusIsBusy(typeof document === 'undefined' ? null : document.activeElement))
  useDialogBehavior(ref, onClose, { ignoreSelector: INSPECTOR_IGNORE_SELECTOR, focusOnOpen })
  // Escape closes exactly this layer. A native listener keeps the dialog element free of JSX key handlers
  // (jsx-a11y/no-noninteractive-element-interactions), as the link panel does.
  const closeEscape = onEscape ?? onClose
  const closeEscapeRef = useRef(closeEscape)
  closeEscapeRef.current = closeEscape
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      closeEscapeRef.current()
    }
    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  }, [])
  // Same left dock slot as the detail card it replaces
  const dock = useDockPanel('detail', true)
  const { rect } = dock
  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
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
        <PanelHeader onClose={onClose} className="mb-1" titleId={titleId}>
          <span role="status" className="text-xs font-mono" style={{ color: COLORS.textMuted }} data-testid="inspector-gone">
            {goneText(name)}
          </span>
        </PanelHeader>
      </GlassCard>
    </div>
  )
}
