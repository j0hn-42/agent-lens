'use client'

/**
 * Redirect dialog of the permission requests panel (#387, PR 5 of #240). A redirect is a deny that carries the
 * operator's text to Claude. The text is required (never sent empty or blank), lives in this component's state only
 * (gone when the dialog closes) and is never written to the journal, which keeps only its length.
 *
 * Modal: focus starts in the text field, Tab and Shift+Tab stay inside, Escape and Cancel close without sending,
 * and the focus goes back to the Redirect button (or, when the request ended meanwhile, to the panel). The error is
 * tied to the field and announced in a polite live region. Colors come from the theme tokens; the card's fade is
 * dropped under prefers-reduced-motion (GlassCard). No keyboard shortcut sends it.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING, FOCUS_RING_INSET } from '@/lib/focus-ring'
import { visibleInput, type PermissionRequestMessage } from '@/lib/bridge-types'
import { REDIRECT_MESSAGE_MAX, redirectMessage } from '@/lib/permission-requests'
import { useLocale, useT } from '@/lib/locale'
import { stopPropagationHandlers } from '@/lib/menu-utils'
import { GlassCard } from './glass-card'
import { INSPECTOR_KEEP_ATTR } from './shared-ui'

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], select, [tabindex]:not([tabindex="-1"])'

interface RedirectDialogProps {
  request: PermissionRequestMessage
  /** Session as shown in the panel (its label, or its id) */
  session: string
  /** Called with the cleaned, non-empty text */
  onSend: (message: string) => void
  onCancel: () => void
  /** Where the focus goes on close when the Redirect button is gone (the request ended or was answered meanwhile) */
  focusFallback: () => void
}

export function RedirectDialog({ request: r, session, onSend, onCancel, focusFallback }: RedirectDialogProps) {
  const { locale } = useLocale()
  const t = useT()
  const titleId = useId()
  const fieldId = useId()
  const helpId = useId()
  const errorId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel
  const fallbackRef = useRef(focusFallback)
  fallbackRef.current = focusFallback
  const [text, setText] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => { setMounted(true) }, [])

  // Focus in the text field; back to the trigger on close, or to the panel when the trigger is gone
  useEffect(() => {
    if (!mounted) return
    const trigger = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    fieldRef.current?.focus({ preventScroll: true })
    return () => {
      setText('')
      const dialog = dialogRef.current
      // Only when the focus was in the dialog (or already lost): focus the user moved elsewhere is never taken back
      const active = document.activeElement
      if (active && active !== document.body && active.isConnected && !(dialog && dialog.contains(active))) return
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
      else fallbackRef.current()
    }
  }, [mounted])

  // Native listeners: the dialog container is not an interactive element (jsx-a11y)
  useEffect(() => {
    const dialog = dialogRef.current
    if (!mounted || !dialog) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancelRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (nodes.length === 0) { e.preventDefault(); return }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const current = document.activeElement
      if (e.shiftKey && (current === first || current === dialog)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && current === last) { e.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', onKeyDown)
    return () => dialog.removeEventListener('keydown', onKeyDown)
  }, [mounted])

  const send = () => {
    const message = redirectMessage(text)
    if (!message) {
      setInvalid(true)
      fieldRef.current?.focus({ preventScroll: true })
      return
    }
    onSend(message)
  }

  if (!mounted) return null

  const button = `text-[11px] font-mono px-2 min-h-6 min-w-6 rounded motion-safe:transition-colors ${FOCUS_RING}`
  const content = (
    <div
      {...stopPropagationHandlers}
      {...{ [INSPECTOR_KEEP_ATTR]: '' }}
      className="fixed inset-0 flex items-center justify-center p-3"
      style={{ zIndex: Z.contextMenu + 1, background: 'var(--lens-scrim)' }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        lang={locale}
        tabIndex={-1}
        className="max-h-[calc(100vh-24px)] w-[480px] max-w-[calc(100vw-24px)] overflow-y-auto outline-none"
      >
        <GlassCard visible={true}>
          <div className="flex flex-col gap-2 text-[11px] font-mono" style={{ color: COLORS.textPrimary }}>
            <h2 id={titleId} className="m-0 text-xs font-semibold break-all">
              {t('permission.redirect.title', { tool: r.toolName, session })}
            </h2>
            <p className="m-0" style={{ color: COLORS.textMuted }}>{t('permission.redirect.intro')}</p>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2" style={{ color: COLORS.textMuted }}>
              <dt>{t('permission.session')}</dt>
              <dd className="m-0 break-all">{r.sessionId}</dd>
              <dt>{t('permission.call')}</dt>
              <dd className="m-0 break-all">{r.toolUseId ?? t('permission.callUnknown')}</dd>
            </dl>
            <div
              role="group"
              aria-label={t('permission.inputLabel', { tool: r.toolName })}
              tabIndex={0}
              className={`max-h-32 overflow-auto rounded ${FOCUS_RING_INSET}`}
              style={{ background: COLORS.holoBg05 }}
            >
              <pre className="m-0 p-1 whitespace-pre-wrap break-all">{visibleInput(r.inputPreview)}</pre>
            </div>
            <label htmlFor={fieldId} className="font-semibold">{t('permission.redirect.label')}</label>
            <textarea
              ref={fieldRef}
              id={fieldId}
              value={text}
              rows={4}
              maxLength={REDIRECT_MESSAGE_MAX}
              spellCheck
              aria-required="true"
              aria-invalid={invalid || undefined}
              aria-describedby={`${helpId} ${errorId}`}
              onChange={e => {
                setText(e.target.value)
                if (invalid && redirectMessage(e.target.value)) setInvalid(false)
              }}
              className={`rounded px-1 py-0.5 resize-y ${FOCUS_RING}`}
              style={{
                background: COLORS.toggleInactive,
                border: `1px solid ${invalid ? COLORS.error : COLORS.controlBorder}`,
                color: COLORS.textPrimary,
              }}
            />
            <p id={helpId} className="m-0" style={{ color: COLORS.textMuted }}>
              {t('permission.redirect.help', { max: REDIRECT_MESSAGE_MAX })}
            </p>
            <p id={errorId} aria-live="polite" className="m-0" style={{ color: COLORS.error }}>
              {invalid ? t('permission.redirect.required') : ''}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={button}
                style={{ color: COLORS.textPrimary, border: `1px solid ${COLORS.controlBorder}`, background: 'transparent' }}
                onClick={() => onCancelRef.current()}
              >
                {t('permission.redirect.cancel')}
              </button>
              <button
                type="button"
                className={button}
                style={{ color: COLORS.textPrimary, border: `1px solid ${COLORS.waiting_permission}`, background: COLORS.toggleInactive }}
                onClick={send}
              >
                {t('permission.redirect.send')}
              </button>
            </div>
          </div>
        </GlassCard>
      </div>
    </div>
  )
  return createPortal(content, document.body)
}
