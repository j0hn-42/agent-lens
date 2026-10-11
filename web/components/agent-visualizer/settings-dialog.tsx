'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { GlassCard } from './glass-card'
import { CloseButton, stopPropagationHandlers } from './shared-ui'
import { ThemeSelect } from './theme-select'
import { parseCostThreshold, type NotificationRules } from '@/lib/notification-rules'
import type { NotifyState } from '@/hooks/use-attention-alerts'

export interface SettingsDialogProps {
  /** Whether the dialog is open; renders nothing when false */
  open: boolean
  onClose: () => void
  hexGrid: boolean
  onHexGridChange: (show: boolean) => void
  /** Sound effects are muted (the audio store only exposes a toggle) */
  muted: boolean
  onToggleMute: () => void
  /** 'All' view also lists finished sessions */
  showFinished: boolean
  onShowFinishedChange: (show: boolean) => void
  hideInactive: boolean
  onHideInactiveChange: (hide: boolean) => void
  singleKeyEnabled: boolean
  onSingleKeyEnabledChange: (enabled: boolean) => void
  /** Opens the keyboard shortcuts dialog (this dialog closes first) */
  onOpenShortcuts: () => void
  /** Notification channel and rules (#225); the section is left out when absent */
  notifications?: {
    state: NotifyState
    onToggle: () => void
    rules: NotificationRules
    onRulesChange: (rules: NotificationRules) => void
  }
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])'

function SwitchRow({ label, help, checked, onChange }: {
  label: string
  help: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const id = useId()
  return (
    <div className="flex items-start gap-2 py-1">
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 min-h-6 min-w-6 cursor-pointer"
      />
      <label htmlFor={id} className="cursor-pointer text-xs font-mono" style={{ color: COLORS.textPrimary }}>
        {label}
        <span className="block text-[11px]" style={{ color: COLORS.textMuted }}>{help}</span>
      </label>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="mb-3">
      <h3 className="m-0 mb-1 text-[11px] font-mono uppercase tracking-wider" style={{ color: COLORS.textMuted }}>
        {title}
      </h3>
      {children}
    </section>
  )
}

function NotificationsSection({ notifications }: { notifications: NonNullable<SettingsDialogProps['notifications']> }) {
  const { state, onToggle, rules, onRulesChange } = notifications
  const amountId = useId()
  const errorId = useId()
  const [draft, setDraft] = useState(String(rules.costThresholdUsd))
  const [invalid, setInvalid] = useState(false)
  const usable = state === 'on'
  const set = (patch: Partial<NotificationRules>) => onRulesChange({ ...rules, ...patch })
  const note = state === 'unsupported' ? 'Notifications are not available in this environment.'
    : state === 'denied' ? 'Notifications are blocked in the browser settings.'
    : 'Browser: shown while this tab is hidden. VS Code: shown unless this panel has the focus.'
  return (
    <Section title="Notifications">
      <SwitchRow
        label="Enable notifications"
        help={note}
        checked={state === 'on'}
        onChange={() => { if (state !== 'unsupported' && state !== 'denied') onToggle() }}
      />
      <SwitchRow label="Agent waiting for a permission" help="An agent starts waiting for you to allow a tool." checked={rules.permission} onChange={v => set({ permission: v })} />
      <SwitchRow label="Agent in error" help="An agent reports an error." checked={rules.error} onChange={v => set({ error: v })} />
      <SwitchRow label="Session finished" help="A session you were watching ends. Sessions already finished when loaded are not announced." checked={rules.complete} onChange={v => set({ complete: v })} />
      <SwitchRow label="Cost threshold reached" help="The session cost crosses the amount below, once. The message keeps the qualification of the figure (at least, estimated)." checked={rules.cost} onChange={v => set({ cost: v })} />
      <div className="flex items-center gap-2 py-1 pl-8 text-xs font-mono" style={{ color: COLORS.textPrimary }}>
        <label htmlFor={amountId}>Cost threshold (USD)</label>
        <input
          id={amountId}
          type="number"
          min={0.01}
          step="any"
          inputMode="decimal"
          value={draft}
          disabled={!rules.cost}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          onChange={e => {
            setDraft(e.target.value)
            const amount = parseCostThreshold(e.target.value)
            setInvalid(amount === null)
            if (amount !== null) set({ costThresholdUsd: amount })
          }}
          className="min-h-6 w-24 rounded px-1 py-0.5"
          style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
        />
      </div>
      {invalid && (
        <p id={errorId} role="alert" className="m-0 pl-8 text-[11px] font-mono" style={{ color: COLORS.error }}>
          Invalid amount: enter a number above 0.
        </p>
      )}
      {!usable && state !== 'unsupported' && state !== 'denied' && (
        <p className="m-0 pl-8 text-[11px] font-mono" style={{ color: COLORS.textMuted }}>The rules apply once notifications are enabled.</p>
      )}
    </Section>
  )
}

/**
 * Modal "Settings" dialog: one place for the preferences that already persist under their own
 * keys (theme, sound, hex grid, finished sessions, inactive agents, single-key shortcuts).
 * It only reads and writes those stores, it never persists anything itself.
 * Focus is trapped while open, Escape closes it and focus returns to the previously focused element.
 */
export function SettingsDialog({
  open, onClose, hexGrid, onHexGridChange, muted, onToggleMute, showFinished, onShowFinishedChange,
  hideInactive, onHideInactiveChange, singleKeyEnabled, onSingleKeyEnabledChange, onOpenShortcuts, notifications,
}: SettingsDialogProps) {
  const ref = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const themeId = useId()
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

  // Native listeners rather than JSX handlers: the backdrop and the dialog container are not
  // interactive elements, so jsx-a11y rejects onMouseDown/onKeyDown on them.
  useEffect(() => {
    const backdrop = backdropRef.current
    const dialog = ref.current
    if (!open || !backdrop || !dialog) return
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
      if (e.key !== 'Tab' || !dialog) return
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (nodes.length === 0) {
        e.preventDefault()
        return
      }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    backdrop.addEventListener('mousedown', onBackdropMouseDown)
    dialog.addEventListener('keydown', onKeyDown)
    return () => {
      backdrop.removeEventListener('mousedown', onBackdropMouseDown)
      dialog.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!open) return null

  return (
    <div
      ref={backdropRef}
      {...stopPropagationHandlers}
      className="fixed inset-0 flex items-center justify-center p-3"
      style={{ zIndex: Z.contextMenu + 1, background: 'rgba(0, 0, 0, 0.5)' }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="max-h-[calc(100vh-24px)] w-[420px] max-w-[calc(100vw-24px)] overflow-y-auto outline-none"
      >
        <GlassCard visible={true}>
          <div className="mb-3 flex items-center justify-between">
            <h2 id={titleId} className="m-0 text-xs font-mono font-semibold" style={{ color: COLORS.textPrimary }}>
              Settings
            </h2>
            <CloseButton onClick={onClose} />
          </div>

          <Section title="Appearance">
            <div className="flex items-center justify-between gap-3 py-1 text-xs font-mono">
              <label htmlFor={themeId} style={{ color: COLORS.textPrimary }}>Theme</label>
              <ThemeSelect id={themeId} />
            </div>
            <SwitchRow label="Hex grid" help="Show the hexagonal grid behind the graph (G)." checked={hexGrid} onChange={onHexGridChange} />
          </Section>

          <Section title="Sound">
            <SwitchRow label="Sound effects" help="Play sounds for agent and tool activity (M)." checked={!muted} onChange={() => onToggleMute()} />
          </Section>

          <Section title="Sessions and agents">
            <SwitchRow
              label="Show finished sessions"
              help="The 'All' view also lists sessions that finished more than 10 minutes ago."
              checked={showFinished}
              onChange={onShowFinishedChange}
            />
            <SwitchRow
              label="Hide inactive agents"
              help="Idle and complete agents are removed from the canvas."
              checked={hideInactive}
              onChange={onHideInactiveChange}
            />
          </Section>

          {notifications && <NotificationsSection notifications={notifications} />}

          <Section title="Keyboard">
            <SwitchRow
              label="Enable single-key shortcuts"
              help="Turn off if letter keys conflict with assistive technology. Esc and ? always work."
              checked={singleKeyEnabled}
              onChange={onSingleKeyEnabledChange}
            />
            <button
              type="button"
              onClick={() => { onClose(); onOpenShortcuts() }}
              className="mt-1 min-h-6 rounded px-2 py-1 text-[11px] font-mono underline"
              style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
            >
              View keyboard shortcuts
            </button>
          </Section>
        </GlassCard>
      </div>
    </div>
  )
}
