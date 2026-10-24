'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Z, type AgentState } from '@/lib/agent-types'
import { COLORS, getStateColor } from '@/lib/colors'
import { formatTokens, formatModelName, formatDuration } from '@/lib/utils'
import { parseMcpTool, formatToolName } from '@/lib/mcp-tool'
import { usageFromAgent, type UsageStatus } from '@/lib/usage'
import { GlassCard } from './glass-card'
import { ActiveTimeStat } from './active-time-stat'
import { PanelHeader, ProgressBar, useDialogBehavior, dialogEscapeHandler, useDockPanel, dockAttrs } from './shared-ui'
import { DETAIL_SIZE } from '@/lib/panel-layout'
import { modelBadge, type ModelSource } from '@/lib/model-provenance'
import { useIssueLinks } from '@/hooks/use-issue-links'
import { agentRoleOf, ISSUE_LINKS_SHOWN, type IssueLink } from '@/lib/issue-links'
import { isLaunchEnded, latestLaunchFor, launchStateLabel, repoOfIssueUrl, type LaunchView } from '@/lib/launch-client'
import { LaunchDialog } from './launch-dialog'
import { useLocale, useT } from '@/lib/locale'
import { translate, type Locale } from '@/lib/messages'
import { safeLabel, safeTeamColor } from '@/lib/state-labels'
import { gitCommitTotal, type GitState } from '@/lib/git-state'
import { useFreshnessValue, type FreshnessClock } from '@/hooks/use-freshness-clock'
import { deriveFreshness, deriveSilence } from '@/hooks/simulation/freshness'
import type { HealthVerdict } from '@/lib/loop-detection'
import { FOCUS_RING, FOCUS_RING_INSET, FOCUS_RING_STRONG } from '@/lib/focus-ring'
import type { DelegationRow } from '@/lib/delegation-report'
import * as C from '@/lib/card-text'

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

function formatClockTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** What follows "5k / 10k": the percentage of the window, or that the window is an assumption. Figures and qualifiers do not depend on the language. */
function contextSuffix(locale: Locale, agent: { tokenStatus?: UsageStatus; tokensMaxAssumed?: boolean }, percent: number): string {
  if (agent.tokenStatus === 'unavailable') return agent.tokensMaxAssumed ? ` ${translate(locale, 'card.ctx.assumedWindow')}` : ''
  const pct = `${agent.tokenStatus === 'partial' ? '≥ ' : ''}${percent}%`
  return ` ${agent.tokensMaxAssumed ? translate(locale, 'card.ctx.pctOfAssumed', { pct }) : `(${pct})`}`
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
  const { locale } = useLocale()
  const t = useT()
  // Left dock: placed by the shared layout (below the message feed, above the control bar, never over a panel)
  const dock = useDockPanel('detail', true)
  const { rect } = dock
  // The card's body is a scroll container: it joins the tab order only while it actually scrolls, so a keyboard user
  // can scroll a card taller than its slot (WCAG 2.1.1), as the System panel does. Set imperatively: the jsx-a11y rule
  // rejects a static tabIndex on a non-interactive element.
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (el.scrollHeight > el.clientHeight + 1) el.setAttribute('tabindex', '0')
    else el.removeAttribute('tabindex')
  })
  // Moving focus elsewhere never clears the selection (WCAG 3.2.2, 2.4.3); Escape and Close do
  useDialogBehavior(ref, onClose, { closeOnFocusOutside: false })
  const contextPercent = agent.tokensMax > 0 ? Math.round((agent.tokensUsed / agent.tokensMax) * 100) : 0
  // The last reading, incomplete, when the relay could not replay events of the agent's session (#366): a context
  // reading is absolute (a lost compaction can lower it), so never "at least", like the context bar on the canvas
  const contextUsage = usageFromAgent(agent)
  const contextIncomplete = replayLost > 0 && contextUsage.status !== 'unavailable'
  const stateColor = getStateColor(agent.state)
  // Freshness of THIS node only; re-renders when it crosses a threshold, not on every tick
  const freshness = useFreshnessValue(t => deriveFreshness(agent, t), freshnessClock)
  // A string that changes once a minute while the agent stays silent (never on a plain tick)
  const silenceLine = useFreshnessValue(t => {
    const s = deriveSilence(agent, t)
    return s ? C.silenceText(locale, s, agent.state) : ''
  }, freshnessClock)
  const stateText = freshness === 'stale' ? C.lastKnownStateText(locale, agent.state) : C.stateText(locale, agent.state)
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
      lang={locale}
      aria-labelledby={titleId}
      tabIndex={-1}
      {...dockAttrs('detail', 'left', dock)}
      className="agent-detail-card outline-none"
      style={{
        position: 'absolute',
        left: rect?.x ?? 12,
        top: rect?.y ?? 'calc(var(--topbar-h, 60px) + 8px)',
        width: rect?.w ?? DETAIL_SIZE.w,
        zIndex: Z.detailCard,
        display: dock.hidden ? 'none' : undefined,
      }}
    >
      <GlassCard ref={bodyRef} className={FOCUS_RING_INSET} visible={true} style={rect ? { maxHeight: rect.h, overflowY: 'auto' } : undefined}>
        <PanelHeader onClose={onClose} className="mb-3" titleId={titleId} closeLabel={t('common.close')}>
          <span
            aria-hidden="true"
            className="w-2 h-2 rounded-full"
            style={{ background: stateColor, boxShadow: `0 0 8px ${stateColor}` }}
          />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-mono" data-sensitive="" title={agent.name} style={{ color: COLORS.textPrimary }}>
              {agent.name}
            </span>
            {agent.model && (
              <span className="flex flex-wrap items-center gap-x-2 text-xs font-mono" style={{ color: COLORS.textDim }}>
                <span>{formatModelName(agent.model)}</span>
                {badge && (
                  <span
                    data-testid="model-badge"
                    data-kind={badge.kind}
                    className="rounded px-1 text-2xs"
                    style={{ border: `1px solid ${COLORS.glassBorder}`, color: badge.kind === 'mismatch' ? COLORS.toolIndicatorText : COLORS.textMuted }}
                  >
                    {C.modelBadgeText(locale, badge.kind)}
                  </span>
                )}
                {agent.effort && <span data-testid="model-effort">{t('card.effort', { value: agent.effort })}</span>}
              </span>
            )}
          </span>
        </PanelHeader>

        {/* Models that really ran (runtime-reported), and the requested one when it differs */}
        {(agent.modelsUsed?.length || (badge?.kind === 'mismatch' && agent.requestedModel)) && (
          <div className="mb-3 text-xs font-mono" style={{ color: COLORS.textDim }} data-testid="models-used">
            {badge?.kind === 'mismatch' && agent.requestedModel && (
              <div>{t('card.requested', { model: formatModelName(agent.requestedModel) })}</div>
            )}
            {agent.modelsUsed && agent.modelsUsed.length > 0 && (
              <div>{t('card.used', { models: agent.modelsUsed.map(formatModelName).join(', ') })}</div>
            )}
          </div>
        )}

        {/* Context bar */}
        <div className="mb-3">
          <div className="flex justify-between mb-1">
            <span className="text-xs" style={{ color: COLORS.textMuted }}>{t('card.contextWindow')}</span>
            <span data-testid="inspector-context" className="text-xs font-mono" style={{ color: COLORS.textDim }}>
              {C.usageText(locale, contextUsage)} / {formatTokens(agent.tokensMax)}{contextSuffix(locale, agent, contextPercent)}{contextIncomplete ? ` ${translate(locale, 'card.ctx.lastReadingIncomplete')}` : ''}
            </span>
          </div>
          {/* Textual value is adjacent, so the bar itself is decorative */}
          <ProgressBar percent={contextPercent} color={stateColor} />
        </div>

        {/* Stats row */}
        <div className="flex gap-3 mb-3 text-xs font-mono" style={{ color: COLORS.textDim }}>
          <span>{C.boundedCountText(locale, agent.toolCalls, replayLost, 'tool')}</span>
          <span>{t('card.alive', { duration: formatDuration(agent.timeAlive) })}</span>
          <span style={{ color: freshness === 'stale' ? COLORS.textMuted : stateColor }}>{stateText}</span>
        </div>

        {/* Own freshness, clock and errors (never borrowed from the anchor session) */}
        <div className="flex flex-wrap gap-x-3 gap-y-1 mb-3 text-xs font-mono" style={{ color: COLORS.textDim }} data-inspector-own>
          {/* A history status is never live (#361): it was received, not seen happening, and never "no longer reporting" */}
          <span data-testid="inspector-freshness">{C.freshnessText(locale, freshness, agent.freshnessSource === 'history')}</span>
          {silenceLine && <span data-testid="inspector-silence">{silenceLine}</span>}
          <span data-testid="inspector-last-event">
            {C.lastEventText(locale, agent.lastEventAt, agent.freshnessSource, formatClockTime)}
          </span>
          {typeof toolErrors === 'number' && (
            <span data-testid="inspector-errors" style={{ color: toolErrors > 0 ? COLORS.error : undefined }}>
              {C.boundedCountText(locale, toolErrors, replayLost, 'toolError')}
            </span>
          )}
          {replayLost > 0 && <span data-testid="inspector-replay-lost">{C.replayLostText(locale, replayLost)}</span>}
          {sessionLabel && <span className="truncate">{sessionLabel}</span>}
        </div>
        <div className="mb-3 text-xs font-mono" style={{ color: COLORS.textDim }}>
          <ActiveTimeStat agent={agent} locale={locale} />
        </div>

        {/* Loop verdict (#230): words and evidence, never a bare "healthy" */}
        {health && <HealthSection health={health} sessionHealth={sessionHealth} />}

        {/* Git strip (#386): only what this agent's own git / gh outputs proved; nothing observed, nothing shown */}
        {agent.git && <GitStrip git={agent.git} spawnTime={agent.spawnTime} lost={replayLost} />}

        {/* Delegation report (#233): per sub-agent, each value proven or said unknown */}
        {delegation && delegation.length > 0 && <DelegationSection rows={delegation} onSelectAgent={onSelectAgent} lost={replayLost} />}

        {/* Teammate info */}
        {agent.kind === 'teammate' && (
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono" style={{ color: COLORS.textDim }}>
            <span>{t(agent.teamKind === 'workflow' ? 'card.workflowAgent' : 'card.teammate')}</span>
            {teamName && (
              <span className="flex min-w-0 items-center gap-1">
                {teamColor && (
                  <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: teamColor }} />
                )}
                <span className="truncate">{C.groupHeadingText(locale, agent.teamKind, teamName)}</span>
              </span>
            )}
            {agent.activity && <span>{C.activityText(locale, agent.activity)}</span>}
          </div>
        )}

        {/* Current tool */}
        {agent.currentTool && (() => {
          const mcp = parseMcpTool(agent.currentTool)
          return (
            <div
              className="mb-3 px-2 py-1.5 rounded text-xs font-mono flex items-center gap-2"
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
          <div className="mt-3 text-xs font-mono" data-testid="issue-links-unavailable">
            <div className="mb-1" style={{ color: COLORS.textMuted }}>agent:{role}</div>
            <p role="status" className="m-0" style={{ color: COLORS.textDim }}>{t('card.issueLinks.unavailable')}</p>
          </div>
        )}
        {role && issueLinks.length > 0 && (
          <div className="mt-3 text-xs font-mono" data-testid="issue-links">
            <div className="mb-1" style={{ color: COLORS.textMuted }}>agent:{role}</div>
            <ul className="flex flex-col gap-0.5" aria-label={t('card.issueLinks.list', { role })}>
              {issueLinks.slice(0, ISSUE_LINKS_SHOWN).map(link => (
                <li key={link.url} className="min-w-0">
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`block truncate underline ${FOCUS_RING_STRONG}`}
                    style={{ color: COLORS.textPrimary }}
                    title={C.issueLinkText(locale, link)}
                  >
                    {C.issueLinkText(locale, link)}
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
              <div style={{ color: COLORS.textDim }}>{t('card.more', { n: issueLinks.length - ISSUE_LINKS_SHOWN })}</div>
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
  const { locale } = useLocale()
  const t = useT()
  const loop = health.status === 'loop'
  return (
    <div className="mb-3 text-xs font-mono" data-testid="inspector-health">
      <div className="mb-1" style={{ color: COLORS.textMuted }}>{t('card.health')}</div>
      <p className="m-0" data-testid="inspector-health-verdict" style={{ color: loop ? COLORS.warn : COLORS.textDim }}>
        {loop && <span aria-hidden="true">⟳ </span>}{C.healthText(locale, health)}
      </p>
      {health.findings.length > 0 && (
        <ul className="flex flex-col gap-0.5 mt-0.5" aria-label={t('card.health.evidence')} style={{ color: COLORS.textDim }}>
          {health.findings.slice(0, FINDINGS_SHOWN).map((f, i) => (
            <li key={i} className="truncate" title={f.kind === 'edit-cycle' ? f.path : undefined}>{C.findingText(locale, f)}</li>
          ))}
        </ul>
      )}
      {health.findings.length > FINDINGS_SHOWN && (
        <div style={{ color: COLORS.textDim }}>{t('card.more', { n: health.findings.length - FINDINGS_SHOWN })}</div>
      )}
      {sessionHealth && (
        <p className="m-0 mt-0.5" data-testid="inspector-session-health" style={{ color: COLORS.textDim }}>
          {t('card.health.session', { text: C.healthText(locale, sessionHealth) })}
        </p>
      )}
    </div>
  )
}

function GitStrip({ git, spawnTime, lost }: { git: GitState; spawnTime?: number; lost: number }) {
  const headingId = useId()
  const { locale } = useLocale()
  const L = C.gitLabels(locale)
  // Time since the agent appeared, the only clock the call times share; nothing when the start is unknown
  const seen = (time: number) => typeof spawnTime === 'number' && Number.isFinite(spawnTime) ? ` · ${L.seen(formatDuration(time - spawnTime))}` : ''
  const total = gitCommitTotal(git)
  return (
    <section className="mb-3 min-w-0 text-xs font-mono" aria-labelledby={headingId} data-testid="git-strip">
      <h3 id={headingId} className="m-0 mb-1 text-xs font-normal" style={{ color: COLORS.textMuted }}>{L.title}</h3>
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
                  {c.amend && <span> {L.amended}</span>}
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
              const name = <><span>{L.pr(p.number, p.repo)}</span> <span>{L.prStates[p.state]}</span></>
              return (
                <li key={`${p.repo ?? ''}#${p.number}`} className="min-w-0 break-words">
                  {p.url ? (
                    <a href={p.url} target="_blank" rel="noopener noreferrer" className={`underline ${FOCUS_RING_STRONG}`} style={{ color: COLORS.textPrimary }}>{name}<span className="sr-only"> {L.newTab}</span></a>
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
  const { locale } = useLocale()
  const t = useT()
  return (
    <section className="mb-3 text-xs font-mono" aria-labelledby={headingId} data-testid="delegation-report">
      <h3 id={headingId} className="m-0 mb-1 text-xs font-normal" style={{ color: COLORS.textMuted }}>{t('card.delegation.title')}</h3>
      <ul className="flex flex-col gap-2" aria-label={t('card.delegation.list', { count: C.delegationCountText(locale, rows.length, lost) })}>
        {rows.map(row => (
          <li key={row.agentId} className="min-w-0" data-testid="delegation-row">
            <div className="flex min-w-0 items-center gap-x-2">
              {onSelectAgent ? (
                <button
                  type="button"
                  aria-label={t('card.delegation.inspect', { name: row.name })}
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
            {!row.linkVerified && <div style={{ color: COLORS.textDim }}>{t('card.delegation.unverified')}</div>}
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2" style={{ color: COLORS.textDim }}>
              <dt style={{ color: COLORS.textMuted }}>{t('card.delegation.tokens')}</dt>
              <dd className="m-0">{C.delegationTokensText(locale, row)}</dd>
              <dt style={{ color: COLORS.textMuted }}>{t('card.delegation.files')}</dt>
              <dd className="m-0 min-w-0">
                {row.filesReadCount > 0 ? (
                  <details>
                    <summary className={`cursor-pointer ${FOCUS_RING}`}>{C.filesReadText(locale, row, lost)}</summary>
                    <ul className="flex flex-col">
                      {row.filesRead.map(f => <li key={f} className="truncate" title={f}>{f}</li>)}
                    </ul>
                    {row.filesReadCount > row.filesRead.length && <div>{t('card.more', { n: row.filesReadCount - row.filesRead.length })}</div>}
                  </details>
                ) : C.filesReadText(locale, row, lost)}
              </dd>
              <dt style={{ color: COLORS.textMuted }}>{t('card.delegation.duration')}</dt>
              <dd className="m-0">{C.durationText(locale, row.duration, lost)}</dd>
              <dt style={{ color: COLORS.textMuted }}>{t('card.delegation.result')}</dt>
              <dd className="m-0 min-w-0 break-words" style={row.result.kind === 'error' ? { color: COLORS.error } : undefined}>
                {C.resultText(locale, row.result, lost)}
                {row.result.kind !== 'not-returned' && row.result.truncated && (
                  <span style={{ color: COLORS.textDim }}> {t('card.result.truncated')}</span>
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
  const { locale } = useLocale()
  const t = useT()
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
      lang={locale}
      aria-labelledby={titleId}
      tabIndex={-1}
      {...dockAttrs('detail', 'left', dock)}
      className="agent-detail-card outline-none"
      style={{
        position: 'absolute',
        left: rect?.x ?? 12,
        top: rect?.y ?? 'calc(var(--topbar-h, 60px) + 8px)',
        width: rect?.w ?? DETAIL_SIZE.w,
        zIndex: Z.detailCard,
        display: dock.hidden ? 'none' : undefined,
      }}
    >
      <GlassCard visible={true} style={rect ? { maxHeight: rect.h, overflowY: 'auto' } : undefined}>
        <PanelHeader onClose={onClose} className="mb-1" titleId={titleId} closeLabel={t('common.close')}>
          <span role="status" className="text-sm font-mono" style={{ color: COLORS.textMuted }} data-testid="inspector-gone">
            {C.goneText(locale, name)}
          </span>
        </PanelHeader>
      </GlassCard>
    </div>
  )
}
