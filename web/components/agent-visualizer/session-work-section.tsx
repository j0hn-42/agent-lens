'use client'

import { COLORS } from '@/lib/colors'
import { FOCUS_RING_INSET } from '@/lib/focus-ring'
import { useSessionWork } from '@/hooks/use-session-work'
import { isSessionBranch, sortPrsByBranch, type ChecksState } from '@/lib/session-work'
import { issueLinkText } from '@/lib/card-text'
import { useLocale } from '@/lib/locale'
import { DATA_EN, t as tr, pluralText, checksText } from '@/lib/panel-text'

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
  return <p role={role} data-testid={testId} className="text-2xs font-mono py-1 m-0" style={{ color: COLORS.textMuted }}>{children}</p>
}

const Heading = ({ children }: { children: React.ReactNode }) => (
  <h3 className="m-0 text-2xs font-mono font-semibold tracking-wider" style={{ color: COLORS.panelLabel }}>{children}</h3>
)

const ANCHOR_CLASS = `underline break-words rounded ${FOCUS_RING_INSET}`

export function SessionWorkSection({ relayOrigin, sessionId, sessionBranch, active }: SessionWorkSectionProps) {
  const state = useSessionWork(relayOrigin, sessionId, active)
  const { locale } = useLocale()
  const t = (key: Parameters<typeof tr>[1], params?: Parameters<typeof tr>[2]) => tr(locale, key, params)
  if (state.status === 'idle') return null

  const body = (() => {
    if (state.status === 'loading') return <Note role="status">{t('sw.loading')}</Note>
    if (state.status === 'unavailable') return <Note role="status">{t('sw.unavailable')}</Note>
    if (state.status === 'unknown-project') return <Note>{t('sw.unknownProject')}</Note>
    const work = state.work
    if (!work) return null
    if (work.repo === null) return <Note>{t('sw.noRepo')}</Note>
    const prs = sortPrsByBranch(work.prs)
    return (
      <>
        <Heading>{t('sw.prs.heading')}</Heading>
        {prs.length === 0 ? (
          <Note>{work.prsTruncated ? t('sw.prs.noneShown') : t('sw.prs.none')}</Note>
        ) : (
          <>
            <table aria-label={t('sw.prs.table')} className="w-full text-2xs font-mono border-collapse" style={{ color: COLORS.assistantText }}>
              <thead>
                <tr style={{ color: COLORS.textMuted }}>
                  <th scope="col" className="text-left font-normal py-1 pr-2">{t('sw.col.branch')}</th>
                  <th scope="col" className="text-left font-normal py-1 pr-2"><span {...DATA_EN}>{t('sw.col.pr')}</span></th>
                  <th scope="col" className="text-left font-normal py-1">{t('sw.col.checks')}</th>
                </tr>
              </thead>
              <tbody>
                {prs.map(pr => (
                  <tr key={pr.number} className="align-top" style={{ borderTop: `1px solid ${COLORS.holoBg05}` }}>
                    <td className="py-1 pr-2 break-all">
                      <span {...DATA_EN}>{pr.branch}</span>
                      {isSessionBranch(pr.branch, sessionBranch) && <span style={{ color: COLORS.textMuted }}> {t('sw.thisSession')}</span>}
                    </td>
                    <td className="py-1 pr-2 break-words">
                      <a href={pr.url} target="_blank" rel="noopener noreferrer" title={issueLinkText(locale, { ...pr, kind: 'pr', state: 'open' })} className={ANCHOR_CLASS} style={{ color: COLORS.textPrimary }}>
                        #{pr.number}{pr.draft ? t('sw.draft') : ''} <span {...DATA_EN}>{pr.title}</span>
                      </a>
                    </td>
                    <td className="py-1" style={{ color: CHECKS_COLOR[pr.checks.state]() }}>{checksText(locale, pr.checks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {work.prsTruncated && <Note>{pluralText(locale, 'sw.prs.atLeast', prs.length)}</Note>}
          </>
        )}
        {!sessionBranch && <Note testId="session-work-no-branch">{t('sw.noBranch')}</Note>}

        <div className="mt-2" />
        <Heading>{t('sw.issues.heading')}</Heading>
        <Note>{t('sw.issues.note')}</Note>
        {work.issues.length === 0 ? (
          <Note>{work.issuesTruncated ? t('sw.issues.noneShown') : t('sw.issues.none')}</Note>
        ) : (
          <>
            <ul aria-label={t('sw.issues.list')} className="flex flex-col gap-0.5 list-none p-0 m-0 text-2xs font-mono">
              {work.issues.map(issue => (
                <li key={issue.number}>
                  <a href={issue.url} target="_blank" rel="noopener noreferrer" className={ANCHOR_CLASS} style={{ color: COLORS.textPrimary }}>
                    #{issue.number} <span {...DATA_EN}>{issue.title}</span>
                  </a>
                </li>
              ))}
            </ul>
            {work.issuesTruncated && <Note>{pluralText(locale, 'sw.issues.atLeast', work.issues.length)}</Note>}
          </>
        )}
      </>
    )
  })()

  return <section aria-label={t('sw.region')} data-testid="session-work" className="mb-1">{body}</section>
}
