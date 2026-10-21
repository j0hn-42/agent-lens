'use client'

import { Z } from '@/lib/agent-types'
import { SCENE } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/focus-ring'
import { useLocale, useT } from '@/lib/locale'

/**
 * Caption of the latest transition (presentation mode). It is for the audience: a status role without a live
 * region, so a screen reader is not interrupted by every change (the mode itself is announced elsewhere).
 */
export function PresentationSubtitle({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <div
      role="status"
      aria-live="off"
      aria-label="Presentation subtitle"
      data-testid="presentation-subtitle"
      className="pointer-events-none fixed left-1/2 max-w-[min(90vw,48rem)] -translate-x-1/2 rounded-md px-4 py-2 text-center font-mono text-base font-semibold"
      style={{ bottom: 96, zIndex: Z.controlBar + 1, background: 'var(--lens-scrim)', color: SCENE.textPrimary, border: `1px solid ${SCENE.textPrimary}` }}
    >
      {text}
    </div>
  )
}

/** Visible marker of the mode and its exit; the mode also stops with V or Escape. */
export function PresentationBadge({ onStop }: { onStop: () => void }) {
  const t = useT()
  const { locale } = useLocale()
  // No aria-label: the name is the visible text (WCAG 2.5.3); the language of the interface is declared on the button,
  // which covers its text and its tooltip (WCAG 3.1.2).
  return (
    <button
      type="button"
      onClick={onStop}
      lang={locale}
      title={t('presentation.badge.title')}
      className={`fixed left-1/2 -translate-x-1/2 rounded-md px-3 py-1 font-mono text-xs ${FOCUS_RING}`}
      style={{ top: 'calc(var(--topbar-h, 48px) + 8px)', zIndex: Z.controlBar + 1, background: 'var(--lens-scrim)', color: SCENE.textPrimary, border: `1px solid ${SCENE.textPrimary}` }}
    >
      {t('presentation.badge')}
    </button>
  )
}
