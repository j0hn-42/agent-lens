'use client'

import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/feed-utils'
import { useSessionWork } from '@/hooks/use-session-work'
import { checksLabel, isSessionBranch, sortPrsByBranch, type ChecksState } from '@/lib/session-work'
import { issueLinkLabel } from '@/lib/issue-links'

interface SessionWorkSectionProps {
  /** Origin of the relay API ('' = same origin); null: no relay, nothing is requested */
  relayOrigin: string | null | undefined
  sessionId: string | null
  /** Branch the session recorded; undefined when it recorded none */
  sessionBranch?: string
  /** Panel open */
  active: boolean
}

const CHECKS_COLOR: Record<ChecksState, () => string> = {
  passing: () => COLORS.complete,
  failing: () => COLORS.error,
  pending: () => COLORS.tool,
  none: () => COLORS.textMuted,
  unknown: () => COLORS.textMuted,
}

function Note({ children, role, testId }: { children: React.ReactNode; role?: 'status'; testId?: string }) {
  return <p role={role} data-testid={testId} className="text-[11px] font-mono py-1 m-0" style={{ color: COLORS.textMuted }}>{children}</p>
}

const Heading = ({ children }: { children: React.ReactNode }) => (
  <h3 className="m-0 text-[11px] font-mono font-semibold tracking-wider" style={{ color: COLORS.panelLabel }}>{children}</h3>
)

const ANCHOR_CLASS = `underline break-words rounded ${FOCUS_RING}`

export function SessionWorkSection({ relayOrigin, sessionId, sessionBranch, active }: SessionWorkSectionProps) {
  const state = useSessionWork(relayOrigin, sessionId, active)
  if (state.status === 'idle') return null

  const body = (() => {
    if (state.status === 'loading') return <Note role="status">Loading pull requests and issues…</Note>
    if (state.status === 'unavailable') return <Note role="status">Pull requests and issues unavailable for now.</Note>
    if (state.status === 'unknown-project') return <Note>The project of this session is unknown: its pull requests and issues cannot be shown.</Note>
    const work = state.work
    if (!work) return null
    if (work.repo === null) return <Note>This project has no GitHub repository (no github.com origin remote).</Note>
    const prs = sortPrsByBranch(work.prs)
    return (
      <>
        <Heading>PULL REQUESTS BY BRANCH</Heading>
        {prs.length === 0 ? (
          <Note>{work.prsTruncated ? 'No open pull request could be shown; more may exist.' : 'No open pull request.'}</Note>
        ) : (
          <>
            <table aria-label="Open pull requests by branch" className="w-full text-[11px] font-mono border-collapse" style={{ color: COLORS.assistantText }}>
              <thead>
                <tr style={{ color: COLORS.textMuted }}>
                  <th scope="col" className="text-left font-normal py-1 pr-2">Branch</th>
                  <th scope="col" className="text-left font-normal py-1 pr-2">Pull request</th>
                  <th scope="col" className="text-left font-normal py-1">Checks</th>
                </tr>
              </thead>
              <tbody>
                {prs.map(pr => (
                  <tr key={pr.number} className="align-top" style={{ borderTop: `1px solid ${COLORS.holoBg05}` }}>
                    <td className="py-1 pr-2 break-all">
                      {pr.branch}
                      {isSessionBranch(pr.branch, sessionBranch) && <span style={{ color: COLORS.textMuted }}> (this session)</span>}
                    </td>
                    <td className="py-1 pr-2 break-words">
                      <a href={pr.url} target="_blank" rel="noopener noreferrer" title={issueLinkLabel({ ...pr, kind: 'pr', state: 'open' })} className={ANCHOR_CLASS} style={{ color: COLORS.textPrimary }}>
                        #{pr.number}{pr.draft ? ' (draft)' : ''} {pr.title}
                      </a>
                    </td>
                    <td className="py-1" style={{ color: CHECKS_COLOR[pr.checks.state]() }}>{checksLabel(pr.checks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {work.prsTruncated && <Note>At least {prs.length} open pull request{prs.length === 1 ? '' : 's'} shown; more may exist.</Note>}
          </>
        )}
        {!sessionBranch && <Note testId="session-work-no-branch">The branch of this session was not recorded: no pull request is matched to it.</Note>}

        <div className="mt-2" />
        <Heading>ISSUES WITHOUT AN AGENT</Heading>
        <Note>Open issues carrying no agent:&lt;role&gt; label.</Note>
        {work.issues.length === 0 ? (
          <Note>{work.issuesTruncated ? 'No open issue without an agent could be shown; more may exist.' : 'No open issue without an agent.'}</Note>
        ) : (
          <>
            <ul aria-label="Open issues without an agent" className="flex flex-col gap-0.5 list-none p-0 m-0 text-[11px] font-mono">
              {work.issues.map(issue => (
                <li key={issue.number}>
                  <a href={issue.url} target="_blank" rel="noopener noreferrer" className={ANCHOR_CLASS} style={{ color: COLORS.textPrimary }}>
                    #{issue.number} {issue.title}
                  </a>
                </li>
              ))}
            </ul>
            {work.issuesTruncated && <Note>At least {work.issues.length} open issue{work.issues.length === 1 ? '' : 's'} without an agent shown; more may exist.</Note>}
          </>
        )}
      </>
    )
  })()

  return <section aria-label="Pull requests and issues" data-testid="session-work" className="mb-1">{body}</section>
}
