'use client'

import { useId } from 'react'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING_INSET } from '@/lib/focus-ring'
import { copyText } from '@/lib/comms-export'
import { useCopyFeedback } from '@/hooks/use-copy-feedback'
import { hasControlChars } from '@/lib/control-chars'
import { resumeCommand, type ResumableSession } from '@/lib/resume-command'
import { useLocale } from '@/lib/locale'
import { DATA_EN, t as tr, resumeUnavailableText } from '@/lib/panel-text'

/**
 * RESUME block of the Context panel (#240, PR 1): the command that reopens the session in Claude Code from a
 * terminal, shown as text and copied on demand. Nothing is run from here and no request is made; when the
 * command cannot be proven right, the block says why instead of offering it.
 */
export function ResumeSection({ session, onOpenTerminal }: { session: ResumableSession; onOpenTerminal?: (sessionId: string) => void }) {
  const { message: feedback, notify } = useCopyFeedback()
  const { locale } = useLocale()
  const t = (key: Parameters<typeof tr>[1], params?: Parameters<typeof tr>[2]) => tr(locale, key, params)
  const result = resumeCommand(session)
  const titleId = useId()

  const copy = async () => {
    if (!result.ok) return
    notify(await copyText(result.command) ? t('resume.copied') : t('resume.copyFailed'))
  }

  // Inside VS Code only (#240, PR 2). The extension holds the directory and checks it again; here it only has to be known.
  const canOpenTerminal = !!onOpenTerminal && !session.imported
    && typeof session.cwd === 'string' && session.cwd !== '' && !hasControlChars(session.cwd)
  const openTerminal = () => {
    if (!onOpenTerminal) return
    onOpenTerminal(session.id)
    // Only what is known: the request was sent. Whether the terminal opened is VS Code's to show.
    notify(t('resume.terminalAsked'))
  }

  return (
    <section aria-labelledby={titleId} className="mb-2">
      <h3 id={titleId} className="m-0 text-[11px] font-mono font-semibold tracking-wider" style={{ color: COLORS.panelLabel }}>{t('resume.heading')}</h3>
      {result.ok ? (
        <>
          <div className="flex items-start gap-1 py-1">
            <code
              {...DATA_EN}
              className="min-w-0 flex-1 whitespace-pre-wrap break-all text-[11px] font-mono rounded p-1"
              style={{ background: COLORS.holoBg05, color: COLORS.assistantText }}
            >{result.command}</code>
            <button
              type="button"
              onClick={() => { void copy() }}
              aria-label={t('resume.copy.aria')}
              className={`shrink-0 text-[11px] font-mono px-1.5 min-h-6 min-w-6 rounded motion-safe:transition-colors ${FOCUS_RING_INSET}`}
              style={{ color: COLORS.textMuted }}
            >
              {t('resume.copy')}
            </button>
          </div>
          <p className="text-[11px] font-mono m-0" style={{ color: COLORS.textMuted }}>{t('resume.help')}</p>
        </>
      ) : (
        <p className="text-[11px] font-mono py-1 m-0" style={{ color: COLORS.textMuted }}>{resumeUnavailableText(locale, result.reason)}</p>
      )}
      {canOpenTerminal && (
        <div className="py-1">
          <button
            type="button"
            onClick={openTerminal}
            aria-label={t('resume.terminal.aria')}
            className={`text-[11px] font-mono px-1.5 min-h-6 min-w-6 rounded motion-safe:transition-colors ${FOCUS_RING_INSET}`}
            style={{ color: COLORS.textMuted }}
          >
            {t('resume.terminal')}
          </button>
        </div>
      )}
      <p role="status" data-testid="resume-copy-feedback" className={`m-0 text-[11px] font-mono ${feedback ? 'py-1' : ''}`} style={{ color: COLORS.textPrimary }}>{feedback}</p>
    </section>
  )
}
