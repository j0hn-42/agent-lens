'use client'

/**
 * Confirmation dialog of an agent launch on an issue (#229, docs/launch-security.md). It shows, as plain text, what
 * the relay will be asked to do (repository, issue, role, title, command, caps), takes the relay token pasted from
 * its console, and sends POST /launch or POST /launch/<id>/stop. The token lives in this component's state only:
 * never in storage nor in a URL, and it is gone when the dialog closes (unmount). Every state shown is a fact the
 * relay reported (launchStateLabel).
 */
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { CONTROL_ALL } from '@/lib/control-chars'
import { FOCUS_RING } from '@/lib/focus-ring'
import { stopPropagationHandlers } from '@/lib/menu-utils'
import {
  LAUNCH_WALL_CLOCK_MIN, activeLaunchFor, isLaunchEnded, latestLaunchFor, launchCommandPreview, launchStateLabel,
  postLaunch, postStop, type FetchLike, type LaunchView,
} from '@/lib/launch-client'
import { GlassCard } from './glass-card'
import { INSPECTOR_KEEP_ATTR } from './shared-ui'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])'

export interface LaunchDialogProps {
  repo: string
  issue: number
  role: string
  /** Issue title as listed by the relay (untrusted: shown as escaped text, control characters removed) */
  title: string
  maxConcurrent: number
  launches: ReadonlyMap<string, LaunchView>
  /** Origin of the relay API ('' = the page is served by the relay) */
  origin: string
  onClose: () => void
  /** Injected in tests; defaults to window.fetch */
  fetchFn?: FetchLike
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init)

export function LaunchDialog({ repo, issue, role, title, maxConcurrent, launches, origin, onClose, fetchFn = defaultFetch }: LaunchDialogProps) {
  const titleId = useId()
  const tokenId = useId()
  const tokenHelpId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [token, setToken] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [mounted, setMounted] = useState(false)

  const active = activeLaunchFor(launches, repo, issue)
  const latest = latestLaunchFor(launches, repo, issue)
  const cleanTitle = title.replace(CONTROL_ALL, ' ').trim()

  useEffect(() => { setMounted(true) }, [])

  // Initial focus on "Annuler" (the safe choice); focus goes back to the trigger on close
  useEffect(() => {
    if (!mounted) return
    const previous = document.activeElement as HTMLElement | null
    cancelRef.current?.focus({ preventScroll: true })
    return () => {
      setToken('')
      if (previous && previous !== document.body && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [mounted])

  // Native listeners: the backdrop and the dialog container are not interactive elements (jsx-a11y)
  useEffect(() => {
    const backdrop = backdropRef.current
    const dialog = ref.current
    if (!mounted || !backdrop || !dialog) return
    const onBackdropMouseDown = (e: MouseEvent) => {
      e.stopPropagation()
      if (e.target === e.currentTarget) onCloseRef.current()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCloseRef.current()
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
    backdrop.addEventListener('mousedown', onBackdropMouseDown)
    dialog.addEventListener('keydown', onKeyDown)
    return () => {
      backdrop.removeEventListener('mousedown', onBackdropMouseDown)
      dialog.removeEventListener('keydown', onKeyDown)
    }
  }, [mounted])

  const needToken = (): boolean => {
    if (token.trim()) return true
    setMessage({ text: 'Collez d’abord le jeton affiché sur la console du relais.', error: true })
    return false
  }

  const launch = async () => {
    if (pending || active || !needToken()) return
    setPending(true)
    setMessage({ text: 'Demande envoyée au relais…', error: false })
    const out = await postLaunch(fetchFn, origin, { repo, issue, role }, token)
    setPending(false)
    setMessage(out.ok
      ? { text: out.launch ? `Accepté par le relais : ${launchStateLabel(out.launch)}.` : 'Accepté par le relais.', error: false }
      : { text: out.message, error: true })
  }

  const stop = async () => {
    if (pending || !active || !needToken()) return
    setPending(true)
    setMessage({ text: 'Demande d’arrêt envoyée au relais…', error: false })
    const out = await postStop(fetchFn, origin, active.id, token)
    setPending(false)
    setMessage(out.ok ? { text: 'Arrêt demandé : l’état changera quand le relais aura vu la fin du processus.', error: false } : { text: out.message, error: true })
  }

  if (!mounted) return null

  const rowLabel = 'shrink-0 w-24'
  const content = (
    <div
      ref={backdropRef}
      {...stopPropagationHandlers}
      {...{ [INSPECTOR_KEEP_ATTR]: '' }}
      className="fixed inset-0 flex items-center justify-center p-3"
      style={{ zIndex: Z.contextMenu + 1, background: 'rgba(0, 0, 0, 0.5)' }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        lang="fr"
        tabIndex={-1}
        className="max-h-[calc(100vh-24px)] w-[480px] max-w-[calc(100vw-24px)] overflow-y-auto outline-none"
        data-testid="launch-dialog"
      >
        <GlassCard visible={true}>
          <h2 id={titleId} className="m-0 mb-3 text-xs font-mono font-semibold" style={{ color: COLORS.textPrimary }}>
            Lancer un agent sur l&apos;issue #{issue}
          </h2>
          <dl className="m-0 flex flex-col gap-1 text-[11px] font-mono" style={{ color: COLORS.textPrimary }}>
            <div className="flex gap-2"><dt className={rowLabel} style={{ color: COLORS.textMuted }}>Dépôt</dt><dd className="m-0 min-w-0 break-all">{repo}</dd></div>
            <div className="flex gap-2"><dt className={rowLabel} style={{ color: COLORS.textMuted }}>Issue</dt><dd className="m-0">#{issue}</dd></div>
            <div className="flex gap-2"><dt className={rowLabel} style={{ color: COLORS.textMuted }}>Rôle</dt><dd className="m-0 break-all">agent:{role}</dd></div>
            <div className="flex gap-2"><dt className={rowLabel} style={{ color: COLORS.textMuted }}>Titre</dt><dd className="m-0 min-w-0 break-words">{cleanTitle || '(sans titre)'}</dd></div>
            <div className="flex gap-2">
              <dt className={rowLabel} style={{ color: COLORS.textMuted }}>Commande</dt>
              <dd className="m-0 min-w-0"><code className="break-all whitespace-pre-wrap" data-testid="launch-command">{launchCommandPreview({ repo, issue, role })}</code></dd>
            </div>
            <div className="flex gap-2">
              <dt className={rowLabel} style={{ color: COLORS.textMuted }}>Plafonds</dt>
              <dd className="m-0">
                {maxConcurrent} lancement{maxConcurrent > 1 ? 's' : ''} simultané{maxConcurrent > 1 ? 's' : ''} au plus, {LAUNCH_WALL_CLOCK_MIN} min par lancement
              </dd>
            </div>
          </dl>

          <div className="mt-3 flex flex-col gap-1 text-[11px] font-mono">
            <label htmlFor={tokenId} style={{ color: COLORS.textPrimary }}>Jeton du relais</label>
            <input
              id={tokenId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={e => setToken(e.target.value)}
              aria-describedby={tokenHelpId}
              className={`min-h-6 rounded px-1 py-0.5 ${FOCUS_RING}`}
              style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
            />
            <p id={tokenHelpId} className="m-0" style={{ color: COLORS.textMuted }}>
              Affiché sur la console du relais à son démarrage. Gardé en mémoire tant que ce dialogue est ouvert, jamais enregistré.
            </p>
          </div>

          <div role="status" aria-live="polite" className="mt-3 text-[11px] font-mono" data-testid="launch-status">
            {latest && (
              <p className="m-0" style={{ color: COLORS.textPrimary }}>
                État : {launchStateLabel(latest)}
                {isLaunchEnded(latest) && latest.worktreePath && (
                  <span className="block break-all" style={{ color: COLORS.textMuted }}>Worktree conservé : {latest.worktreePath}</span>
                )}
              </p>
            )}
            {message && <p className="m-0" style={{ color: message.error ? COLORS.error : COLORS.textMuted }}>{message.text}</p>}
          </div>

          <div className="mt-3 flex justify-end gap-2 text-xs font-mono">
            <button
              ref={cancelRef}
              type="button"
              onClick={() => onCloseRef.current()}
              className={`min-h-6 rounded px-2 py-1 ${FOCUS_RING}`}
              style={{ border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
            >
              Annuler
            </button>
            {active ? (
              <button
                type="button"
                onClick={() => { void stop() }}
                aria-disabled={pending || undefined}
                className={`min-h-6 rounded px-2 py-1 ${FOCUS_RING}`}
                style={{ border: `1px solid ${COLORS.error}`, color: COLORS.error }}
              >
                Arrêter
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { void launch() }}
                aria-disabled={pending || undefined}
                className={`min-h-6 rounded px-2 py-1 ${FOCUS_RING}`}
                style={{ border: `1px solid ${COLORS.controlBorder}`, background: COLORS.toggleInactive, color: COLORS.textPrimary }}
              >
                Lancer
              </button>
            )}
          </div>
        </GlassCard>
      </div>
    </div>
  )
  return createPortal(content, document.body)
}
