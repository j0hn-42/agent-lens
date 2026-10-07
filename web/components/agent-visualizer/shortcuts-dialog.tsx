'use client'

import { useEffect, useId, useRef } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { SHORTCUTS, SHORTCUT_GROUPS } from '@/lib/shortcuts'
import { GlassCard } from './glass-card'
import { CloseButton, stopPropagationHandlers } from './shared-ui'

export interface ShortcutsDialogProps {
  /** Whether the dialog is open; renders nothing when false */
  open: boolean
  onClose: () => void
  /** Current value of the "single-key shortcuts" preference */
  singleKeyEnabled: boolean
  /** Persist the preference (the `updateSingleKeyShortcuts` callback from the visualizer) */
  onSingleKeyEnabledChange: (enabled: boolean) => void
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Modal "Keyboard shortcuts" dialog (opened with `?`). Focus is trapped while open,
 * Escape closes it and focus returns to the previously focused element.
 */
export function ShortcutsDialog({ open, onClose, singleKeyEnabled, onSingleKeyEnabledChange }: ShortcutsDialogProps) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const switchId = useId()
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    ref.current?.focus({ preventScroll: true })
    return () => {
      if (previous && previous !== document.body && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [open])

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCloseRef.current()
      return
    }
    if (e.key !== 'Tab' || !ref.current) return
    const nodes = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (nodes.length === 0) {
      e.preventDefault()
      return
    }
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      {...stopPropagationHandlers}
      className="fixed inset-0 flex items-center justify-center p-3"
      style={{ zIndex: Z.contextMenu + 1, background: 'rgba(0, 0, 0, 0.5)' }}
      onMouseDown={e => { e.stopPropagation(); if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="max-h-[calc(100vh-24px)] w-[420px] max-w-[calc(100vw-24px)] overflow-y-auto outline-none"
      >
        <GlassCard visible={true}>
          <div className="mb-3 flex items-center justify-between">
            <h2 id={titleId} className="m-0 text-xs font-mono font-semibold" style={{ color: COLORS.textPrimary }}>
              Keyboard shortcuts
            </h2>
            <CloseButton onClick={onClose} />
          </div>

          {SHORTCUT_GROUPS.map(group => (
            <section key={group} aria-label={group} className="mb-3">
              <h3 className="m-0 mb-1 text-[11px] font-mono uppercase tracking-wider" style={{ color: COLORS.textMuted }}>
                {group}
              </h3>
              <ul className="m-0 list-none p-0">
                {SHORTCUTS.filter(s => s.group === group).map(s => (
                  <li key={s.key} className="flex items-center justify-between gap-3 py-0.5 text-xs font-mono">
                    <span style={{ color: COLORS.textPrimary }}>{s.description}</span>
                    <kbd
                      className="min-w-6 rounded px-1.5 py-0.5 text-center text-[11px]"
                      style={{ background: COLORS.holoBg10, border: `1px solid ${COLORS.glassBorder}`, color: COLORS.textPrimary }}
                    >
                      {s.display}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <div className="flex items-start gap-2 border-t pt-3" style={{ borderColor: COLORS.glassBorder }}>
            <input
              id={switchId}
              type="checkbox"
              role="switch"
              checked={singleKeyEnabled}
              onChange={e => onSingleKeyEnabledChange(e.target.checked)}
              className="mt-0.5 h-4 w-4 min-h-6 min-w-6 cursor-pointer"
            />
            <label htmlFor={switchId} className="cursor-pointer text-xs font-mono" style={{ color: COLORS.textPrimary }}>
              Enable single-key shortcuts
              <span className="block text-[11px]" style={{ color: COLORS.textMuted }}>
                Turn off if letter keys conflict with assistive technology. Esc and ? always work.
              </span>
            </label>
          </div>
        </GlassCard>
      </div>
    </div>
  )
}
