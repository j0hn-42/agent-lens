'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING, FOCUS_RING_INSET } from '@/lib/focus-ring'
import { Button } from '@/components/ui/button'
import { CONTROL_ALL } from '@/lib/control-chars'
import { visibleInput, type PermissionRequestMessage } from '@/lib/bridge-types'
import { formatPermissionTime, inputSummary, remainingSeconds } from '@/lib/permission-requests'
import { useLocale, useT } from '@/lib/locale'
import type { MessageKey } from '@/lib/messages'
import type { PermissionAction } from '@/lib/bridge-types'
import { usePermissionRequests, type PermissionNotice, type PermissionRow } from '@/hooks/use-vscode-bridge'
import { PERMISSION_HEIGHT_VAR, PERMISSION_OPEN_ATTR } from '@/lib/mobile-view'
import { RedirectDialog } from './permission-redirect-dialog'

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
  /** Told whether at least one card is shown (the first-run tour offer yields to a pending decision) */
  onShownChange?: (shown: boolean) => void
}

/**
 * Operator decisions inside VS Code (#240, PR 4): each PermissionRequest the extension holds is shown in full (tool,
 * session, input, deadline) with Approve, Deny and Redirect buttons (#387: Redirect opens a dialog for the text
 * Claude receives with the deny). A click sends one decision; the row then says it was sent. It says applied only
 * for a deny or redirect whose refusal was then observed live (an error end of that very call); an approval is never
 * claimed applied. Outside VS Code nothing is rendered.
 * No global shortcut, no focus taken: news is announced in a polite live region.
 */
export function PermissionRequests({ sessionLabel, onShownChange }: PermissionRequestsProps) {
  const { available, rows, notice, decide, dismiss } = usePermissionRequests()
  const shown = rows.length > 0
  useEffect(() => {
    onShownChange?.(shown)
    return () => onShownChange?.(false)
  }, [shown, onShownChange])
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
      // Leaving for outside the panel, or for nowhere (click on a non focusable area): the user left. Only a focused
      // element removed from the page by a re-render keeps the focus claim, so it can be restored.
      const to = e.relatedTarget as Node | null
      if (to && el.contains(to)) return
      if ((e.target as Node).isConnected) focusRef.current = { inside: false, nonce: null }
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

  // An open drawer spans the viewport below 768 px and would sit under the card: while a card is shown, publish its
  // height (--permission-h) and flag the page, so the drawer starts below the card and scrolls in what is left
  // (SlidingPanel). The card never covers a drawer control or its focus (#548).
  const hasRows = rows.length > 0
  useEffect(() => {
    const el = containerRef.current
    const root = document.documentElement
    if (!el || !hasRows || typeof ResizeObserver === 'undefined') return
    const publish = () => root.style.setProperty(PERMISSION_HEIGHT_VAR, `${Math.ceil(el.getBoundingClientRect().height)}px`)
    root.setAttribute(PERMISSION_OPEN_ATTR, '')
    publish()
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    return () => { ro.disconnect(); root.style.removeProperty(PERMISSION_HEIGHT_VAR); root.removeAttribute(PERMISSION_OPEN_ATTR) }
  }, [available, hasRows])

  /** Focus target when the redirect dialog closes after its Redirect button went away */
  const focusPanel = useCallback((nonce: string) => {
    const row = containerRef.current?.querySelector<HTMLElement>(`[data-nonce="${nonce}"]`)
    const target = row?.querySelector<HTMLElement>('button') ?? headingRef.current
    target?.focus({ preventScroll: true })
  }, [])

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
      data-permission-requests=""
      className="absolute right-3 flex flex-col gap-2 max-h-[60vh] max-md:max-h-[30vh] overflow-y-auto pointer-events-none"
      style={{ zIndex: Z.controlBar + 6, top: 'var(--topbar-h, 3.75rem)', width: 'min(28rem, calc(100% - 1.5rem))' }}
    >
      <section aria-labelledby={headingId} className="flex flex-col gap-2">
        <h2
          id={headingId}
          data-permission-head=""
          ref={headingRef}
          tabIndex={-1}
          className={rows.length ? `m-0 text-[11px] font-mono font-semibold tracking-wider pointer-events-auto rounded ${FOCUS_RING}` : 'sr-only'}
          style={{ color: COLORS.panelLabel }}
        >
          {rows.length ? t('permission.title') : t('permission.titleEmpty')}
        </h2>
        {rows.length > 0 && (
          <p data-permission-head="" className="m-0 text-[11px] font-mono pointer-events-auto rounded px-2 py-1" style={{ color: COLORS.textMuted, background: COLORS.panelBg }}>
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
            onFocusPanel={focusPanel}
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
  if (n.kind === 'applied') {
    return t('permission.withSubject', { subject: subject(n.request), text: t(n.action === 'redirect' ? 'permission.applied.redirect' : 'permission.applied.deny') })
  }
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
  onDecide: (nonce: string, action: PermissionAction, message?: string) => void
  onDismiss: (nonce: string) => void
  onFocusPanel: (nonce: string) => void
}

const SENT_KEYS: Record<PermissionAction, MessageKey> = {
  approve: 'permission.sent.approve',
  deny: 'permission.sent.deny',
  redirect: 'permission.sent.redirect',
}

function sentText(row: PermissionRow, t: ReturnType<typeof useT>): string {
  if (row.applied && row.action === 'redirect') return t('permission.applied.redirect')
  if (row.applied && row.action === 'deny') return t('permission.applied.deny')
  return row.action ? t(SENT_KEYS[row.action]) : t('permission.sent.other')
}

/** Whole seconds left before a deadline, re-read every second while the row is on screen (not a live region) */
function useSecondsLeft(expiresAt: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return remainingSeconds(expiresAt, now)
}

/** Decorative marks so Approve and Deny differ by shape, not by colour alone (#374) */
function DecisionIcon({ action }: { action: PermissionAction }) {
  return (
    <svg aria-hidden="true" focusable="false" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {action === 'approve' ? <path d="M1.5 5.5 4 8l4.5-6" /> : action === 'deny' ? <path d="M2 2l6 6M8 2 2 8" /> : <path d="M1.5 5h7M6 2.5 8.5 5 6 7.5" />}
    </svg>
  )
}

function RequestRow({ row, subject, session, locale, t, onDecide, onDismiss, onFocusPanel }: RequestRowProps) {
  const { request: r, state } = row
  const titleId = useId()
  const [redirecting, setRedirecting] = useState(false)
  // The dialog only exists while the request can still be answered
  const dialogOpen = redirecting && state === 'waiting'
  useEffect(() => { if (state !== 'waiting') setRedirecting(false) }, [state])
  const summary = inputSummary(r)
  const name = (action: string) => summary
    ? t('permission.actionName', { action, tool: r.toolName, summary, session })
    : t('permission.actionNameShort', { action, tool: r.toolName, session })
  const sending = state === 'sending'
  const secondsLeft = useSecondsLeft(r.expiresAt)
  const countdown = secondsLeft > 0
    ? t('permission.deadlineIn', {
        time: secondsLeft >= 60
          ? t('permission.deadlineMin', { min: Math.floor(secondsLeft / 60), sec: String(secondsLeft % 60).padStart(2, '0') })
          : t('permission.deadlineSec', { sec: secondsLeft }),
      })
    : ''

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
        <dd className="m-0"><time dateTime={new Date(r.expiresAt).toISOString()}>{formatPermissionTime(r.expiresAt, locale)}</time>{countdown && <span> ({countdown})</span>}</dd>
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
          <p className="m-0 flex-1">{sentText(row, t)}</p>
          <Button
            variant="decision"
            aria-label={t('permission.dismissName', { tool: r.toolName, session })}
            onClick={() => onDismiss(r.nonce)}
          >
            {t('permission.dismiss')}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          {(['approve', 'deny', 'redirect'] as const).map(action => {
            const visible = t(action === 'approve' ? 'permission.approve' : action === 'deny' ? 'permission.deny' : 'permission.redirect')
            // Approve: solid border, check. Deny: dashed border, cross. Redirect: dotted border, arrow. Same text colour, so the cue is not colour
            const shape = { border: action === 'approve' ? `2px solid ${COLORS.controlBorder}` : `1px ${action === 'deny' ? 'dashed' : 'dotted'} ${COLORS.controlBorder}` }
            return (
              <Button
                key={action}
                variant="decision"
                className="inline-flex items-center gap-1"
                style={sending ? { ...shape, opacity: 0.6 } : shape}
                aria-label={name(visible)}
                aria-disabled={sending || undefined}
                aria-haspopup={action === 'redirect' ? 'dialog' : undefined}
                onClick={() => {
                  if (sending) return
                  if (action === 'redirect') setRedirecting(true)
                  else onDecide(r.nonce, action)
                }}
              >
                <DecisionIcon action={action} />
                {visible}
              </Button>
            )
          })}
          {sending && <p className="m-0" style={{ color: COLORS.textMuted }}>{t('permission.sending')}</p>}
        </div>
      )}
      {dialogOpen && (
        <RedirectDialog
          request={r}
          session={session}
          onSend={message => { setRedirecting(false); onDecide(r.nonce, 'redirect', message) }}
          onCancel={() => setRedirecting(false)}
          focusFallback={() => onFocusPanel(r.nonce)}
        />
      )}
    </div>
  )
}
