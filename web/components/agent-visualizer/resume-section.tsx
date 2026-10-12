'use client'

import { useId } from 'react'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING_INSET } from '@/lib/focus-ring'
import { copyText } from '@/lib/comms-export'
import { useCopyFeedback } from '@/hooks/use-copy-feedback'
import { hasControlChars } from '@/lib/control-chars'
import { resumeCommand, RESUME_UNAVAILABLE_TEXT, type ResumableSession } from '@/lib/resume-command'

/**
 * RESUME block of the Context panel (#240, PR 1): the command that reopens the session in Claude Code from a
 * terminal, shown as text and copied on demand. Nothing is run from here and no request is made; when the
 * command cannot be proven right, the block says why instead of offering it.
 */
export function ResumeSection({ session, onOpenTerminal }: { session: ResumableSession; onOpenTerminal?: (sessionId: string) => void }) {
  const { message: feedback, notify } = useCopyFeedback()
  const result = resumeCommand(session)
  const titleId = useId()

  const copy = async () => {
    if (!result.ok) return
    notify(await copyText(result.command)
      ? 'Resume command copied. Paste it in a terminal on the machine where the session ran.'
      : 'Copy failed: select the command and copy it by hand')
  }

  // Inside VS Code only (#240, PR 2). The extension holds the directory and checks it again; here it only has to be known.
  const canOpenTerminal = !!onOpenTerminal && !session.imported
    && typeof session.cwd === 'string' && session.cwd !== '' && !hasControlChars(session.cwd)
  const openTerminal = () => {
    if (!onOpenTerminal) return
    onOpenTerminal(session.id)
    // Only what is known: the request was sent. Whether the terminal opened is VS Code's to show.
    notify('Asked VS Code to open a terminal in the directory of this session. Nothing is run in it.')
  }

  return (
    <section aria-labelledby={titleId} className="mb-2">
      <h3 id={titleId} className="m-0 text-[11px] font-mono font-semibold tracking-wider" style={{ color: COLORS.panelLabel }}>RESUME</h3>
      {result.ok ? (
        <>
          <div className="flex items-start gap-1 py-1">
            <code
              className="min-w-0 flex-1 whitespace-pre-wrap break-all text-[11px] font-mono rounded p-1"
              style={{ background: COLORS.holoBg05, color: COLORS.assistantText }}
            >{result.command}</code>
            <button
              type="button"
              onClick={() => { void copy() }}
              aria-label="Copy resume command"
              className={`shrink-0 text-[11px] font-mono px-1.5 min-h-6 min-w-6 rounded motion-safe:transition-colors ${FOCUS_RING_INSET}`}
              style={{ color: COLORS.textMuted }}
            >
              Copy
            </button>
          </div>
          <p className="text-[11px] font-mono m-0" style={{ color: COLORS.textMuted }}>Paste it in a terminal on the machine where the session ran. Nothing is run from here.</p>
        </>
      ) : (
        <p className="text-[11px] font-mono py-1 m-0" style={{ color: COLORS.textMuted }}>{RESUME_UNAVAILABLE_TEXT[result.reason]}</p>
      )}
      {canOpenTerminal && (
        <div className="py-1">
          <button
            type="button"
            onClick={openTerminal}
            aria-label="Go to terminal: open a terminal in the session directory"
            className={`text-[11px] font-mono px-1.5 min-h-6 min-w-6 rounded motion-safe:transition-colors ${FOCUS_RING_INSET}`}
            style={{ color: COLORS.textMuted }}
          >
            Go to terminal
          </button>
        </div>
      )}
      <p role="status" data-testid="resume-copy-feedback" className={`m-0 text-[11px] font-mono ${feedback ? 'py-1' : ''}`} style={{ color: COLORS.textPrimary }}>{feedback}</p>
    </section>
  )
}
