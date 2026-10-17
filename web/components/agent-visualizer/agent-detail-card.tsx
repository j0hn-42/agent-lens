'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Z, type AgentState } from '@/lib/agent-types'
import { COLORS, getStateColor } from '@/lib/colors'
import { formatTokens, formatModelName, formatDuration, pluralize } from '@/lib/utils'
import { parseMcpTool, formatToolName } from '@/lib/mcp-tool'
import { formatTokenUsage, usageFromAgent, type UsageStatus } from '@/lib/usage'
import { GlassCard } from './glass-card'
import { ActiveTimeStat } from './active-time-stat'
import { PanelHeader, ProgressBar, useDialogBehavior, dialogEscapeHandler, useDockPanel, dockAttrs } from './shared-ui'
import { modelBadge, type ModelSource } from '@/lib/model-provenance'
import { useIssueLinks } from '@/hooks/use-issue-links'
import { agentRoleOf, issueLinkLabel, ISSUE_LINKS_SHOWN, type IssueLink } from '@/lib/issue-links'
import { isLaunchEnded, latestLaunchFor, launchStateLabel, repoOfIssueUrl, type LaunchView } from '@/lib/launch-client'
import { LaunchDialog } from './launch-dialog'
import { useLocale, useT } from '@/lib/locale'
import { getStateLabel, getActivityLabel, safeLabel, safeTeamColor } from '@/lib/state-labels'
import { CONTEXT_WINDOW_NAME, GIT_STRIP_LABELS, groupHeading } from '@/lib/ui-glossary'
import { gitCommitTotal, type GitState } from '@/lib/git-state'
import { useFreshnessValue, type FreshnessClock } from '@/hooks/use-freshness-clock'
import { deriveFreshness, deriveSilence, silenceText, lastKnownStateText, type Freshness } from '@/hooks/simulation/freshness'
import { goneText } from '@/lib/inspector-model'
import { healthText, findingText, type HealthVerdict } from '@/lib/loop-detection'
import { FOCUS_RING, FOCUS_RING_STRONG } from '@/lib/focus-ring'
import { tokensText, filesReadText, durationText, resultText, delegationCountText, type DelegationRow } from '@/lib/delegation-report'
import { boundedCount, replayLostSentence } from '@/lib/event-loss'

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
    tokensMaxAssumed?: boolean
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
    freshnessSource?: 'live' | 'history' | 'imported'
    sessionLabel?: string
    activeMs?: number
    activeSince?: number
    subagentType?: string
    agentType?: string
    spawnTime?: number
    /** Branch, commits, PR states read from this agent's own observed outputs (#386); absent = no strip */
    git?: GitState
  }
  /** Tool errors of this node only (cumulative, Agent.toolErrors); absent = not counted, nothing shown */
  toolErrors?: number
  /** Loop verdict of this node only (#230); absent = not assessed, nothing shown */
  health?: HealthVerdict
  /** Loop verdict of the node's whole session; absent = not shown */
  sessionHealth?: HealthVerdict
  /** Delegation report of this node (#233): one row per direct sub-agent; absent or empty = no section */
  delegation?: DelegationRow[]
  /** Opens the inspector of another agent (a sub-agent of the report) */
  onSelectAgent?: (agentId: string) => void
  /** Origin of the relay API when a relay feeds the view (null: no relay, no issue links) */
  relayOrigin?: string | null
  /** Agent launches (#229): present only when the relay serving this page has `launch` in GET /status (--allow-launch) */
  launch?: { maxConcurrent: number; launches: ReadonlyMap<string, LaunchView> } | null
  onClose: () => void
  /** Escape pressed inside the card; defaults to onClose. The shell uses it to close newer panels first. */
  onEscape?: () => void
  /** Freshness clock override for tests */
  freshnessClock?: FreshnessClock
  /** Events of this node's session the relay could not replay (#366): totals and "none" verdicts then read "at least" / "incomplete" */
  replayLost?: number
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
  health,
  sessionHealth,
  delegation,
  onSelectAgent,
  relayOrigin = null,
  launch = null,
  onClose,
  onEscape,
  freshnessClock,
  replayLost = 0,
}: AgentDetailCardProps) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  // Left dock: placed by the shared layout (below the message feed, above the control bar, never over a panel)
  const dock = useDockPanel('detail', true)
  const { rect } = dock
  // Moving focus elsewhere never clears the selection (WCAG 3.2.2, 2.4.3); Escape and Close do
  useDialogBehavior(ref, onClose, { closeOnFocusOutside: false })
  const contextPercent = agent.tokensMax > 0 ? Math.round((agent.tokensUsed / agent.tokensMax) * 100) : 0
  const stateColor = getStateColor(agent.state)
  // Freshness of THIS node only; re-renders when it crosses a threshold, not on every tick
  const freshness = useFreshnessValue(t => deriveFreshness(agent, t), freshnessClock)
  // A string that changes once a minute while the agent stays silent (never on a plain tick)
  const silenceLine = useFreshnessValue(t => {
    const s = deriveSilence(agent, t)
    return s ? silenceText(s, agent.state) : ''
  }, freshnessClock)
  const stateText = freshness === 'stale' ? lastKnownStateText(agent.state) : getStateLabel(agent.state)
  const sessionLabel = safeLabel(agent.sessionLabel)
  const badge = modelBadge(agent)
  const role = agentRoleOf(agent)
  const { links: issueLinks, status: issueLinksStatus } = useIssueLinks(relayOrigin, role, agent.sessionId)
  /** Issue whose launch dialog is open (null: closed) */
  const [launchTarget, setLaunchTarget] = useState<{ link: IssueLink; repo: string } | null>(null)
  // The launch surface going away (relay link dropped) closes the dialog for good: when it comes back, nobody asked for it
  const launchAvailable = launch !== null
  useEffect(() => { if (!launchAvailable) setLaunchTarget(null) }, [launchAvailable])
  const teamName = safeLabel(agent.teamName)
  const teamColor = safeTeamColor(agent.teamColor)

  return (
    // Key boundary of the dialog (Escape, see dialogEscapeHandler): a box-less presentational wrapper,
    // so the dialog itself carries no handler and its layout is unchanged (display: contents).
    <div role="presentation" style={{ display: 'contents' }} onKeyDown={dialogEscapeHandler(onEscape ?? onClose)}>
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
        <PanelHeader onClose={onClose} className="mb-3" titleId={titleId}>
          <span
            aria-hidden="true"
            className="w-2 h-2 rounded-full"
            style={{ background: stateColor, boxShadow: `0 0 8px ${stateColor}` }}
          />
          <span className="flex flex-col">
            <span className="text-xs font-mono" data-sensitive="" style={{ color: COLORS.textPrimary }}>
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
            <span className="text-[11px]" style={{ color: COLORS.textMuted }}>{CONTEXT_WINDOW_NAME}</span>
            <span data-testid="inspector-context" className="text-[11px] font-mono" style={{ color: COLORS.textDim }}>
              {formatTokenUsage(usageFromAgent(agent))} / {formatTokens(agent.tokensMax)}{agent.tokenStatus === 'unavailable' ? (agent.tokensMaxAssumed ? ' (assumed window)' : '') : ` (${agent.tokenStatus === 'partial' ? '≥ ' : ''}${contextPercent}%${agent.tokensMaxAssumed ? ' of an assumed window' : ''})`}
            </span>
          </div>
          {/* Textual value is adjacent, so the bar itself is decorative */}
          <ProgressBar percent={contextPercent} color={stateColor} />
        </div>

        {/* Stats row */}
        <div className="flex gap-3 mb-3 text-[11px] font-mono" style={{ color: COLORS.textDim }}>
          <span>{boundedCount(agent.toolCalls, replayLost, 'tool')}</span>
          <span>{formatDuration(agent.timeAlive)} alive</span>
          <span style={{ color: freshness === 'stale' ? COLORS.textMuted : stateColor }}>{stateText}</span>
        </div>

        {/* Own freshness, clock and errors (never borrowed from the anchor session) */}
        <div className="flex flex-wrap gap-x-3 gap-y-1 mb-3 text-[11px] font-mono" style={{ color: COLORS.textDim }} data-inspector-own>
          {/* A history status is never live (#361): it was received, not seen happening, and never "no longer reporting" */}
          <span data-testid="inspector-freshness">{freshness === 'stale' && agent.freshnessSource === 'history' ? 'From history' : FRESHNESS_TEXT[freshness]}</span>
          {silenceLine && <span data-testid="inspector-silence">{silenceLine}</span>}
          <span data-testid="inspector-last-event">
            {typeof agent.lastEventAt === 'number' && Number.isFinite(agent.lastEventAt)
              ? agent.freshnessSource === 'history'
                ? `history received ${formatClockTime(agent.lastEventAt)}`
                : `last event ${formatClockTime(agent.lastEventAt)}${agent.freshnessSource === 'imported' ? ' (imported transcript)' : ''}`
              : 'no event observed'}
          </span>
          {typeof toolErrors === 'number' && (
            <span data-testid="inspector-errors" style={{ color: toolErrors > 0 ? COLORS.error : undefined }}>
              {boundedCount(toolErrors, replayLost, 'tool error')}
            </span>
          )}
          {replayLost > 0 && <span data-testid="inspector-replay-lost">{replayLostSentence(replayLost)}</span>}
          {sessionLabel && <span className="truncate">{sessionLabel}</span>}
        </div>
        <div className="mb-3 text-[11px] font-mono" style={{ color: COLORS.textDim }}>
          <ActiveTimeStat agent={agent} />
        </div>

        {/* Loop verdict (#230): words and evidence, never a bare "healthy" */}
        {health && <HealthSection health={health} sessionHealth={sessionHealth} />}

        {/* Git strip (#386): only what this agent's own git / gh outputs proved; nothing observed, nothing shown */}
        {agent.git && <GitStrip git={agent.git} spawnTime={agent.spawnTime} lost={replayLost} />}

        {/* Delegation report (#233): per sub-agent, each value proven or said unknown */}
        {delegation && delegation.length > 0 && <DelegationSection rows={delegation} onSelectAgent={onSelectAgent} lost={replayLost} />}

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
                    className={`block truncate underline ${FOCUS_RING_STRONG}`}
                    style={{ color: COLORS.textPrimary }}
                    title={issueLinkLabel(link)}
                  >
                    {issueLinkLabel(link)}
                  </a>
                  {launch && relayOrigin !== null && link.kind === 'issue' && link.state === 'open' && repoOfIssueUrl(link.url) && (
                    <LaunchRow
                      link={link}
                      repo={repoOfIssueUrl(link.url)!}
                      launches={launch.launches}
                      onOpen={() => setLaunchTarget({ link, repo: repoOfIssueUrl(link.url)! })}
                    />
                  )}
                </li>
              ))}
            </ul>
            {issueLinks.length > ISSUE_LINKS_SHOWN && (
              <div style={{ color: COLORS.textDim }}>+{issueLinks.length - ISSUE_LINKS_SHOWN} more</div>
            )}
          </div>
        )}
        {launch && relayOrigin !== null && role && launchTarget && (
          <LaunchDialog
            repo={launchTarget.repo}
            issue={launchTarget.link.number}
            role={role}
            title={launchTarget.link.title}
            maxConcurrent={launch.maxConcurrent}
            launches={launch.launches}
            origin={relayOrigin}
            onClose={() => setLaunchTarget(null)}
          />
        )}
      </GlassCard>
    </div>
    </div>
  )
}

/** Launch button of an open issue (#229), and the last state the relay reported for it, in words */
function LaunchRow({ link, repo, launches, onOpen }: {
  link: IssueLink
  repo: string
  launches: ReadonlyMap<string, LaunchView>
  onOpen: () => void
}) {
  const { locale } = useLocale()
  const t = useT()
  const latest = latestLaunchFor(launches, repo, link.number)
  return (
    <div className="flex flex-col gap-0.5 pl-2" lang={locale}>
      <button
        type="button"
        onClick={onOpen}
        className={`self-start min-h-6 rounded px-1.5 py-0.5 ${FOCUS_RING}`}
        style={{ border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
      >
        {t('launch.button', { n: link.number })}
      </button>
      {latest && (
        <span style={{ color: COLORS.textMuted }} data-testid="launch-state">
          {launchStateLabel(latest, locale)}
          {isLaunchEnded(latest) && latest.worktreePath && <span className="block break-all">{t('launch.worktree', { path: latest.worktreePath })}</span>}
        </span>
      )}
    </div>
  )
}

const FINDINGS_SHOWN = 5

function HealthSection({ health, sessionHealth }: { health: HealthVerdict; sessionHealth?: HealthVerdict }) {
  const loop = health.status === 'loop'
  return (
    <div className="mb-3 text-[11px] font-mono" data-testid="inspector-health">
      <div className="mb-1" style={{ color: COLORS.textMuted }}>Health</div>
      <p className="m-0" data-testid="inspector-health-verdict" style={{ color: loop ? COLORS.warn : COLORS.textDim }}>
        {loop && <span aria-hidden="true">⟳ </span>}{healthText(health)}
      </p>
      {health.findings.length > 0 && (
        <ul className="flex flex-col gap-0.5 mt-0.5" aria-label="Loop evidence" style={{ color: COLORS.textDim }}>
          {health.findings.slice(0, FINDINGS_SHOWN).map((f, i) => (
            <li key={i} className="truncate" title={f.kind === 'edit-cycle' ? f.path : undefined}>{findingText(f)}</li>
          ))}
        </ul>
      )}
      {health.findings.length > FINDINGS_SHOWN && (
        <div style={{ color: COLORS.textDim }}>+{health.findings.length - FINDINGS_SHOWN} more</div>
      )}
      {sessionHealth && (
        <p className="m-0 mt-0.5" data-testid="inspector-session-health" style={{ color: COLORS.textDim }}>
          Session: {healthText(sessionHealth)}
        </p>
      )}
    </div>
  )
}

function GitStrip({ git, spawnTime, lost }: { git: GitState; spawnTime?: number; lost: number }) {
  const headingId = useId()
  const L = GIT_STRIP_LABELS
  // Time since the agent appeared, the only clock the call times share; nothing when the start is unknown
  const seen = (time: number) => typeof spawnTime === 'number' && Number.isFinite(spawnTime) ? ` · ${L.seen(formatDuration(time - spawnTime))}` : ''
  const total = gitCommitTotal(git)
  return (
    <section className="mb-3 min-w-0 text-[11px] font-mono" aria-labelledby={headingId} data-testid="git-strip">
      <h3 id={headingId} className="m-0 mb-1 text-[11px] font-normal" style={{ color: COLORS.textMuted }}>{L.title}</h3>
      {lost > 0 && <p className="m-0" data-testid="git-lost" style={{ color: COLORS.textDim }}>{L.lost}</p>}
      {git.head && (
        <p className="m-0 break-all" data-testid="git-branch" style={{ color: COLORS.textDim }}>
          <span aria-hidden="true">⎇ </span>
          <span style={{ color: COLORS.textMuted }}>{L.branch} </span>
          <span data-sensitive="" style={{ color: COLORS.textPrimary }}>{git.head.ref.kind === 'branch' ? git.head.ref.name : L.detached}</span>
          <span> · {L.sources[git.head.source]}{seen(git.head.time)}</span>
        </p>
      )}
      {total > 0 && (
        <div className="mt-0.5" data-testid="git-commits" style={{ color: COLORS.textDim }}>
          <details>
            <summary className={`cursor-pointer ${FOCUS_RING}`}>{L.commits(total, lost > 0)}</summary>
            <ul className="flex flex-col" aria-label={L.commitsList}>
              {git.commits.map(c => (
                <li key={c.sha} className="min-w-0 break-words">
                  <span style={{ color: COLORS.textPrimary }}>{c.sha}</span>{' '}
                  <span data-sensitive="">{c.message}</span>
                  {c.amend && <span> ({L.amended})</span>}
                  <span>{seen(c.time)}</span>
                </li>
              ))}
            </ul>
            {git.omittedCommits > 0 && <div>{L.omittedCommits(git.omittedCommits)}</div>}
          </details>
        </div>
      )}
      {git.prs.length > 0 && (
        <>
          <ul className="mt-0.5 flex flex-col" aria-label={L.prsList} style={{ color: COLORS.textDim }}>
            {git.prs.map(p => {
              const name = `${L.pr(p.number, p.repo)} ${L.prStates[p.state]}`
              return (
                <li key={`${p.repo ?? ''}#${p.number}`} className="min-w-0 break-words">
                  {p.url ? (
                    <a href={p.url} target="_blank" rel="noopener noreferrer" className={`underline ${FOCUS_RING_STRONG}`} style={{ color: COLORS.textPrimary }}>{name}<span className="sr-only">{L.newTab}</span></a>
                  ) : (
                    <span style={{ color: COLORS.textPrimary }}>{name}</span>
                  )}
                  <span>{seen(p.time)}</span>
                </li>
              )
            })}
          </ul>
          {git.omittedPrs > 0 && <div style={{ color: COLORS.textDim }}>{L.omittedPrs(git.omittedPrs)}</div>}
        </>
      )}
    </section>
  )
}

function DelegationSection({ rows, onSelectAgent, lost = 0 }: { rows: DelegationRow[]; onSelectAgent?: (agentId: string) => void; lost?: number }) {
  const headingId = useId()
  return (
    <section className="mb-3 text-[11px] font-mono" aria-labelledby={headingId} data-testid="delegation-report">
      <h3 id={headingId} className="m-0 mb-1 text-[11px] font-normal" style={{ color: COLORS.textMuted }}>Delegation report</h3>
      <ul className="flex flex-col gap-2" aria-label={`Delegation report: ${delegationCountText(rows.length, lost)}`}>
        {rows.map(row => (
          <li key={row.agentId} className="min-w-0" data-testid="delegation-row">
            <div className="flex min-w-0 items-center gap-x-2">
              {onSelectAgent ? (
                <button
                  type="button"
                  aria-label={`Inspect sub-agent ${row.name}`}
                  onClick={() => onSelectAgent(row.agentId)}
                  className={`truncate underline ${FOCUS_RING}`}
                  style={{ color: COLORS.textPrimary }}
                >
                  {row.name}
                </button>
              ) : (
                <span className="truncate" style={{ color: COLORS.textPrimary }}>{row.name}</span>
              )}
              {row.subagentType && <span className="truncate" style={{ color: COLORS.textDim }}>{row.subagentType}</span>}
            </div>
            {!row.linkVerified && <div style={{ color: COLORS.textDim }}>parent link not verified</div>}
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2" style={{ color: COLORS.textDim }}>
              <dt style={{ color: COLORS.textMuted }}>Tokens</dt>
              <dd className="m-0">{tokensText(row)}</dd>
              <dt style={{ color: COLORS.textMuted }}>Files read</dt>
              <dd className="m-0 min-w-0">
                {row.filesReadCount > 0 ? (
                  <details>
                    <summary className={`cursor-pointer ${FOCUS_RING}`}>{filesReadText(row, lost)}</summary>
                    <ul className="flex flex-col">
                      {row.filesRead.map(f => <li key={f} className="truncate" title={f}>{f}</li>)}
                    </ul>
                    {row.filesReadCount > row.filesRead.length && <div>+{row.filesReadCount - row.filesRead.length} more</div>}
                  </details>
                ) : filesReadText(row, lost)}
              </dd>
              <dt style={{ color: COLORS.textMuted }}>Duration</dt>
              <dd className="m-0">{durationText(row.duration, lost)}</dd>
              <dt style={{ color: COLORS.textMuted }}>Result</dt>
              <dd className="m-0 min-w-0 break-words" style={row.result.kind === 'error' ? { color: COLORS.error } : undefined}>
                {resultText(row.result, lost)}
                {row.result.kind !== 'not-returned' && row.result.truncated && (
                  <span style={{ color: COLORS.textDim }}> (full report in Conversation)</span>
                )}
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    </section>
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
  useDialogBehavior(ref, onClose, { closeOnFocusOutside: false, focusOnOpen })
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
