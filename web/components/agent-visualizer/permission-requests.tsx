'use client'

import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING, FOCUS_RING_INSET } from '@/lib/focus-ring'
import { CONTROL_ALL } from '@/lib/control-chars'
import { visibleInput, type PermissionRequestMessage } from '@/lib/bridge-types'
import { formatPermissionTime, inputSummary } from '@/lib/permission-requests'
import { useLocale, useT } from '@/lib/locale'
import type { MessageKey } from '@/lib/messages'
import { usePermissionRequests, type PermissionNotice, type PermissionRow } from '@/hooks/use-vscode-bridge'

const CLOSED_KEYS: Record<string, MessageKey> = {
  expired: 'permission.closed.expired',
  'answered-elsewhere': 'permission.closed.answered-elsewhere',
  disabled: 'permission.closed.disabled',
  'surface-closed': 'permission.closed.surface-closed',
  shutdown: 'permission.closed.shutdown',
  'journal-failed': 'permission.closed.journal-failed',
}
const ERROR_KEYS: Record<string, MessageKey> = {
  mismatch: 'permission.error.mismatch',
  'message-required': 'permission.error.message-required',
  closed: 'permission.error.closed',
  unknown: 'permission.error.unknown',
  disabled: 'permission.error.disabled',
  'no-surface': 'permission.error.no-surface',
  'journal-failed': 'permission.error.journal-failed',
}

interface PermissionRequestsProps {
  /** Label of a session when the panel knows one (the full id is shown too) */
  sessionLabel?: (sessionId: string) => string | undefined
}

/**
 * Operator decisions inside VS Code (#240, PR 4): each PermissionRequest the extension holds is shown in full (tool,
 * session, input, deadline) with an Approve and a Deny button. A click sends one decision; the row then says it was
 * sent, never that it was applied: only the transcript can show that. Outside VS Code nothing is rendered.
 * No global shortcut, no focus taken: news is announced in a polite live region.
 */
export function PermissionRequests({ sessionLabel }: PermissionRequestsProps) {
  const { available, rows, notice, decide, dismiss } = usePermissionRequests()
  const { locale } = useLocale()
  const t = useT()
  const headingId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  /** Focus was inside the panel at the last focus event, and on which request */
  const focusRef = useRef<{ inside: boolean; nonce: string | null }>({ inside: false, nonce: null })

  // Where the focus is, followed with native listeners (the container itself is not interactive)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onIn = (e: FocusEvent) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-nonce]')
      focusRef.current = { inside: true, nonce: row?.dataset.nonce ?? null }
    }
    const onOut = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null
      if (to && !el.contains(to)) focusRef.current = { inside: false, nonce: null }
    }
    el.addEventListener('focusin', onIn)
    el.addEventListener('focusout', onOut)
    return () => {
      el.removeEventListener('focusin', onIn)
      el.removeEventListener('focusout', onOut)
    }
  }, [available])

  // A row that changed under the focus (buttons replaced, request closed) would drop it on the page: keep it in the
  // panel, on the same request when it is still shown. Focus that was elsewhere is never moved.
  useLayoutEffect(() => {
    const el = containerRef.current
    const f = focusRef.current
    if (!el || !f.inside || el.contains(document.activeElement)) return
    const row = f.nonce ? el.querySelector<HTMLElement>(`[data-nonce="${f.nonce}"]`) : null
    const target = row?.querySelector<HTMLElement>('button') ?? headingRef.current
    target?.focus({ preventScroll: true })
  })

  if (!available) return null

  const sessionName = (id: string) => {
    const label = sessionLabel?.(id)
    return label ? label.replace(CONTROL_ALL, ' ').trim() || id : id
  }
  const subject = (r: PermissionRequestMessage) => t('permission.rowTitle', { tool: r.toolName, session: sessionName(r.sessionId) })

  return (
    <div
      ref={containerRef}
      lang={locale}
      className="absolute right-3 top-14 flex flex-col gap-2 max-h-[60vh] overflow-y-auto pointer-events-none"
      style={{ zIndex: Z.controlBar + 6, width: 'min(28rem, calc(100% - 1.5rem))' }}
    >
      <section aria-labelledby={headingId} className="flex flex-col gap-2">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className={rows.length ? `m-0 text-[11px] font-mono font-semibold tracking-wider pointer-events-auto rounded ${FOCUS_RING}` : 'sr-only'}
          style={{ color: COLORS.panelLabel }}
        >
          {rows.length ? t('permission.title') : t('permission.titleEmpty')}
        </h2>
        {rows.length > 0 && (
          <p className="m-0 text-[11px] font-mono pointer-events-auto rounded px-2 py-1" style={{ color: COLORS.textMuted, background: COLORS.panelBg }}>
            {t('permission.intro')}
          </p>
        )}
        {rows.map(row => (
          <RequestRow
            key={row.request.nonce}
            row={row}
            subject={subject(row.request)}
            session={sessionName(row.request.sessionId)}
            locale={locale}
            t={t}
            onDecide={decide}
            onDismiss={dismiss}
          />
        ))}
      </section>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {notice ? noticeText(notice, subject, t) : ''}
      </p>
    </div>
  )
}

function noticeText(n: PermissionNotice, subject: (r: PermissionRequestMessage) => string, t: ReturnType<typeof useT>): string {
  if (n.kind === 'sent') return t('permission.withSubject', { subject: subject(n.request), text: t('permission.announce.sent') })
  if (n.kind === 'closed') {
    const key = CLOSED_KEYS[n.outcome]
    const text = key ? t(key) : t('permission.closed.other', { outcome: n.outcome })
    return t('permission.withSubject', { subject: subject(n.request), text })
  }
  const key = ERROR_KEYS[n.reason]
  const text = key ? t(key) : t('permission.error.other', { reason: n.reason })
  return n.request ? t('permission.withSubject', { subject: subject(n.request), text }) : text
}

interface RequestRowProps {
  row: PermissionRow
  subject: string
  session: string
  locale: string
  t: ReturnType<typeof useT>
  onDecide: (nonce: string, action: 'approve' | 'deny') => void
  onDismiss: (nonce: string) => void
}

function RequestRow({ row, subject, session, locale, t, onDecide, onDismiss }: RequestRowProps) {
  const { request: r, state } = row
  const titleId = useId()
  const summary = inputSummary(r)
  const name = (action: string) => summary
    ? t('permission.actionName', { action, tool: r.toolName, summary, session })
    : t('permission.actionNameShort', { action, tool: r.toolName, session })
  const button = `text-[11px] font-mono px-2 min-h-6 min-w-6 rounded motion-safe:transition-colors ${FOCUS_RING}`
  const buttonStyle = { color: COLORS.textPrimary, border: `1px solid ${COLORS.controlBorder}`, background: 'transparent' }
  const sending = state === 'sending'

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      data-nonce={r.nonce}
      className="pointer-events-auto rounded p-2 flex flex-col gap-1 text-[11px] font-mono"
      style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.waiting_permission}`, color: COLORS.textPrimary }}
    >
      <p id={titleId} className="m-0 font-semibold break-all">{subject}</p>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2" style={{ color: COLORS.textMuted }}>
        <dt>{t('permission.session')}</dt>
        <dd className="m-0 break-all">{r.sessionId}</dd>
        <dt>{t('permission.call')}</dt>
        <dd className="m-0 break-all">{r.toolUseId ?? t('permission.callUnknown')}</dd>
        <dt>{t('permission.deadline')}</dt>
        <dd className="m-0"><time dateTime={new Date(r.expiresAt).toISOString()}>{formatPermissionTime(r.expiresAt, locale)}</time></dd>
      </dl>
      <div
        role="group"
        aria-label={t('permission.inputLabel', { tool: r.toolName })}
        tabIndex={0}
        className={`max-h-40 overflow-auto rounded ${FOCUS_RING_INSET}`}
        style={{ background: COLORS.holoBg05 }}
      >
        <pre className="m-0 p-1 whitespace-pre-wrap break-all">{visibleInput(r.inputPreview)}</pre>
      </div>
      {r.inputTruncated && (
        <p className="m-0 break-all" style={{ color: COLORS.textMuted }}>{t('permission.truncated', { sha: r.inputSha256 })}</p>
      )}
      {state === 'sent' ? (
        <div className="flex items-center gap-2 flex-wrap">
          <p className="m-0 flex-1">
            {row.action === 'approve' ? t('permission.sent.approve') : row.action === 'deny' ? t('permission.sent.deny') : t('permission.sent.other')}
          </p>
          <button
            type="button"
            className={button}
            style={buttonStyle}
            aria-label={t('permission.dismissName', { tool: r.toolName, session })}
            onClick={() => onDismiss(r.nonce)}
          >
            {t('permission.dismiss')}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          {(['approve', 'deny'] as const).map(action => {
            const visible = t(action === 'approve' ? 'permission.approve' : 'permission.deny')
            return (
              <button
                key={action}
                type="button"
                className={button}
                style={sending ? { ...buttonStyle, opacity: 0.6 } : buttonStyle}
                aria-label={name(visible)}
                aria-disabled={sending || undefined}
                onClick={() => { if (!sending) onDecide(r.nonce, action) }}
              >
                {visible}
              </button>
            )
          })}
          {sending && <p className="m-0" style={{ color: COLORS.textMuted }}>{t('permission.sending')}</p>}
        </div>
      )}
    </div>
  )
}
