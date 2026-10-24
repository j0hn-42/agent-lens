'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { GlassCard } from './glass-card'
import { CloseButton, stopPropagationHandlers } from './shared-ui'
import { ThemeSelect } from './theme-select'
import { useLocale, useT, type LocaleChoice } from '@/lib/locale'
import { parseCostThreshold, type NotificationRules } from '@/lib/notification-rules'
import type { NotifyState } from '@/hooks/use-attention-alerts'
import type { PresentationOptions } from '@/lib/presentation'
import { FOCUS_RING } from '@/lib/focus-ring'
import { ANNOUNCE_LEVELS, type AnnounceLevel } from '@/lib/ui-preferences'
import { ACTIVE_WINDOW_MINUTES, type ShowMode } from '@/lib/show-mode'
import { DEFAULT_SETTINGS_TAB, SETTINGS_TAB_LABEL, visibleSettingsTabs, type SettingsTab } from '@/lib/settings-tabs'
import { useModalDialog } from '@/hooks/use-modal-dialog'

export interface SettingsDialogProps {
  /** Whether the dialog is open; renders nothing when false */
  open: boolean
  onClose: () => void
  /**
   * Selected tab (#533). Given with onTabChange by the visualizer, which keeps it in memory for the page and opens a tab
   * from the palette; left out, the dialog keeps its own (still remembered while it stays mounted).
   */
  tab?: SettingsTab
  onTabChange?: (tab: SettingsTab) => void
  hexGrid: boolean
  onHexGridChange: (show: boolean) => void
  /** Sound effects are muted (the audio store only exposes a toggle) */
  muted: boolean
  onToggleMute: () => void
  /** 'Show: active / all' (#372): one mode for the inactive agents and the finished sessions */
  showMode: ShowMode
  onShowModeChange: (mode: ShowMode) => void
  singleKeyEnabled: boolean
  onSingleKeyEnabledChange: (enabled: boolean) => void
  /** Opens the keyboard shortcuts dialog (this dialog closes first) */
  onOpenShortcuts: () => void
  /**
   * #372 (owner's decision): opens the View popover of the canvas controls (Freeze motion, Calm by layer, Pin cards, Hide
   * unanswered calls after), this dialog closing first. Those settings stay under the canvas, one press away from it
   * (WCAG 2.2.2); General only points to them. The row is left out when absent.
   */
  onOpenViewControls?: () => void
  /** Restores the defaults of the preference blob (#372); the 'Reset preferences' button is left out when absent */
  onResetPrefs?: () => void
  /** Presentation mode (#245) and its three options; the section is left out when absent */
  presentation?: {
    active: boolean
    onActiveChange: (active: boolean) => void
    options: PresentationOptions
    onOptionChange: (key: keyof PresentationOptions, value: boolean) => void
  }
  /** Verbosity of the live announcements (#379); the section is left out when absent */
  announcements?: {
    level: AnnounceLevel
    onLevelChange: (level: AnnounceLevel) => void
  }
  /** Quota gauges of the top bar (#467); the switch is left out when absent */
  quota?: {
    show: boolean
    onShowChange: (show: boolean) => void
  }
  /** Notification channel and rules (#225); the section is left out when absent */
  notifications?: {
    state: NotifyState
    onToggle: () => void
    rules: NotificationRules
    onRulesChange: (rules: NotificationRules) => void
  }
}

function SwitchRow({ label, help, extraHelp, checked, onChange }: {
  label: string
  help: string
  /** A second help sentence, in its own line */
  extraHelp?: string
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
        <span className="block text-2xs" style={{ color: COLORS.textMuted }}>{help}</span>
        {extraHelp && <span className="block text-2xs" style={{ color: COLORS.textMuted }}>{extraHelp}</span>}
      </label>
    </div>
  )
}

/** Native select: keyboard operable, named by its label. Each language is written in its own language. */
function LanguageSelect({ id, choice, onChange, autoLabel, frLabel, enLabel }: {
  id: string
  choice: LocaleChoice
  onChange: (choice: LocaleChoice) => void
  autoLabel: string
  frLabel: string
  enLabel: string
}) {
  return (
    <select
      id={id}
      value={choice}
      onChange={e => onChange(e.target.value as LocaleChoice)}
      className={`min-h-6 cursor-pointer rounded px-1.5 py-0.5 text-2xs font-mono ${FOCUS_RING}`}
      style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary, colorScheme: 'inherit' }}
    >
      <option value="auto" style={{ background: COLORS.surface, color: COLORS.ink }}>{autoLabel}</option>
      <option value="fr" lang="fr" style={{ background: COLORS.surface, color: COLORS.ink }}>{frLabel}</option>
      <option value="en" lang="en" style={{ background: COLORS.surface, color: COLORS.ink }}>{enLabel}</option>
    </select>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="mb-3">
      <h3 className="m-0 mb-1 text-2xs font-mono uppercase tracking-wider" style={{ color: COLORS.textMuted }}>
        {title}
      </h3>
      {children}
    </section>
  )
}

/**
 * 'Reset preferences' (#372): two native buttons, nothing is reset before the second one. The help says what is reset and
 * what is kept. Focus moves to the confirmation, and back to the reset button after a cancel or a reset.
 */
function ResetSection({ onReset, signature, shown }: { onReset: () => void; signature: string; shown: boolean }) {
  const t = useT()
  const helpId = useId()
  const askId = useId()
  const [asking, setAsking] = useState(false)
  const [done, setDone] = useState(false)
  // Signature of the preferences right after the reset; null until the render that follows the click.
  const baseline = useRef<string | null>(null)
  useEffect(() => {
    if (!done) return
    if (baseline.current === null) baseline.current = signature
    else if (baseline.current !== signature) setDone(false)
  }, [done, signature])
  const resetRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const focusNext = useRef<'confirm' | 'reset' | null>(null)
  // Leaving its tab cancels the confirmation (#533): nothing is reset, and the focus stays where the user moved it
  useEffect(() => {
    if (shown) return
    focusNext.current = null
    setAsking(false)
  }, [shown])
  useEffect(() => {
    if (focusNext.current === 'confirm') confirmRef.current?.focus()
    else if (focusNext.current === 'reset') resetRef.current?.focus()
    focusNext.current = null
  }, [asking])
  const buttonStyle = { background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }
  const buttonClass = `min-h-6 rounded px-2 py-1 text-2xs font-mono ${FOCUS_RING}`
  return (
    <Section title={t('settings.section.reset')}>
      <p id={helpId} className="m-0 mb-1 text-2xs font-mono" style={{ color: COLORS.textMuted }}>{t('settings.reset.help')}</p>
      {asking ? (
        <div role="group" aria-labelledby={askId} className="flex flex-wrap items-center gap-2">
          <span id={askId} className="text-2xs font-mono" style={{ color: COLORS.textPrimary }}>{t('settings.reset.ask')}</span>
          <button
            ref={confirmRef}
            type="button"
            className={buttonClass}
            style={buttonStyle}
            onClick={() => { onReset(); baseline.current = null; setDone(true); focusNext.current = 'reset'; setAsking(false) }}
          >
            {t('settings.reset.confirm')}
          </button>
          <button
            type="button"
            className={buttonClass}
            style={buttonStyle}
            onClick={() => { focusNext.current = 'reset'; setAsking(false) }}
          >
            {t('settings.reset.cancel')}
          </button>
        </div>
      ) : (
        <button
          ref={resetRef}
          type="button"
          aria-describedby={helpId}
          className={buttonClass}
          style={buttonStyle}
          onClick={() => { setDone(false); focusNext.current = 'confirm'; setAsking(true) }}
        >
          {t('settings.reset')}
        </button>
      )}
      <p role="status" className="m-0 mt-1 text-2xs font-mono" style={{ color: COLORS.textMuted }}>
        {done ? t('settings.reset.done') : ''}
      </p>
    </Section>
  )
}

/** Native select named by its label and described by its help: keyboard operable, no custom widget. */
function AnnouncementsSection({ announcements }: { announcements: NonNullable<SettingsDialogProps['announcements']> }) {
  const t = useT()
  const selectId = useId()
  const helpId = useId()
  return (
    <Section title={t('settings.section.announcements')}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1 text-xs font-mono">
        <label htmlFor={selectId} style={{ color: COLORS.textPrimary }}>{t('settings.announce.level')}</label>
        <select
          id={selectId}
          value={announcements.level}
          aria-describedby={helpId}
          onChange={e => {
            const level = ANNOUNCE_LEVELS.find(l => l === e.target.value)
            if (level) announcements.onLevelChange(level)
          }}
          className={`min-h-6 cursor-pointer rounded px-1.5 py-0.5 text-2xs font-mono ${FOCUS_RING}`}
          style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary, colorScheme: 'inherit' }}
        >
          {ANNOUNCE_LEVELS.map(level => (
            <option key={level} value={level} style={{ background: COLORS.surface, color: COLORS.ink }}>{t(`settings.announce.level.${level}`)}</option>
          ))}
        </select>
      </div>
      <p id={helpId} className="m-0 text-2xs font-mono" style={{ color: COLORS.textMuted }}>{t('settings.announce.help')}</p>
    </Section>
  )
}

function NotificationsSection({ notifications }: { notifications: NonNullable<SettingsDialogProps['notifications']> }) {
  const { state, onToggle, rules, onRulesChange } = notifications
  const t = useT()
  const amountId = useId()
  const errorId = useId()
  const [draft, setDraft] = useState(String(rules.costThresholdUsd))
  const [invalid, setInvalid] = useState(false)
  const usable = state === 'on'
  const set = (patch: Partial<NotificationRules>) => onRulesChange({ ...rules, ...patch })
  const note = state === 'unsupported' ? t('settings.notify.unsupported')
    : state === 'denied' ? t('settings.notify.denied')
    : t('settings.notify.note')
  return (
    <Section title={t('settings.section.notifications')}>
      <SwitchRow
        label={t('settings.notify.enable')}
        help={note}
        checked={state === 'on'}
        onChange={() => { if (state !== 'unsupported' && state !== 'denied') onToggle() }}
      />
      <SwitchRow label={t('settings.notify.permission')} help={t('settings.notify.permission.help')} checked={rules.permission} onChange={v => set({ permission: v })} />
      <SwitchRow label={t('settings.notify.error')} help={t('settings.notify.error.help')} checked={rules.error} onChange={v => set({ error: v })} />
      <SwitchRow label={t('settings.notify.complete')} help={t('settings.notify.complete.help')} checked={rules.complete} onChange={v => set({ complete: v })} />
      <SwitchRow label={t('settings.notify.cost')} help={t('settings.notify.cost.help')} checked={rules.cost} onChange={v => set({ cost: v })} />
      <div className="flex items-center gap-2 py-1 pl-8 text-xs font-mono" style={{ color: COLORS.textPrimary }}>
        <label htmlFor={amountId}>{t('settings.notify.threshold')}</label>
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
        <p id={errorId} role="alert" className="m-0 pl-8 text-2xs font-mono" style={{ color: COLORS.error }}>
          {t('settings.notify.invalid')}
        </p>
      )}
      {!usable && state !== 'unsupported' && state !== 'denied' && (
        <p className="m-0 pl-8 text-2xs font-mono" style={{ color: COLORS.textMuted }}>{t('settings.notify.rulesPending')}</p>
      )}
    </Section>
  )
}

/**
 * Modal "Settings" dialog: one place for the preferences (theme, language, sound, hex grid, the Show mode
 * (active only / all), single-key shortcuts...). It only reads and writes their stores, it never persists anything
 * itself; 'Reset preferences' (#372) resets the preference blob only, as its help says.
 * Focus is trapped while open, Escape closes it and focus returns to the previously focused element.
 *
 * The sections sit in four tabs (#533, ARIA tabs pattern): one tablist, a single Tab stop with a roving tabindex, Left / Right
 * (wrapping) and Home / End move and select. Every panel stays rendered, the unselected ones `hidden`, so their state (a
 * threshold being typed) survives a tab change; the selected tab gets the focus when the dialog opens.
 */
export function SettingsDialog({
  open, onClose, tab, onTabChange, hexGrid, onHexGridChange, muted, onToggleMute, showMode, onShowModeChange,
  singleKeyEnabled, onSingleKeyEnabledChange, onOpenShortcuts, notifications, presentation, announcements, quota,
  onResetPrefs, onOpenViewControls,
}: SettingsDialogProps) {
  const { locale, choice, setChoice } = useLocale()
  const t = useT()
  const langId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const themeId = useId()
  const tabsId = useId()
  const viewHelpId = useId()
  const [ownTab, setOwnTab] = useState<SettingsTab>(tab ?? DEFAULT_SETTINGS_TAB)
  // A tab with nothing to show is left out (no notification channel and no announcement setting given)
  const tabs = visibleSettingsTabs({ notifications: Boolean(notifications), announcements: Boolean(announcements) })
  const wanted = tab ?? ownTab
  const current: SettingsTab = tabs.includes(wanted) ? wanted : DEFAULT_SETTINGS_TAB
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({})
  const select = (next: SettingsTab, focus: boolean) => {
    setOwnTab(next)
    onTabChange?.(next)
    if (focus) tabRefs.current[next]?.focus()
  }
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    // Alt+Arrow (browser back / forward), Ctrl or Meta + Home / End belong to the browser
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const at = tabs.indexOf(current)
    const next = e.key === 'ArrowRight' ? tabs[(at + 1) % tabs.length]
      : e.key === 'ArrowLeft' ? tabs[(at - 1 + tabs.length) % tabs.length]
      : e.key === 'Home' ? tabs[0]
      : e.key === 'End' ? tabs[tabs.length - 1]
      : null
    if (!next) return
    e.preventDefault()
    select(next, true)
  }
  const tabDomId = (id: SettingsTab) => `${tabsId}-tab-${id}`
  const panelDomId = (id: SettingsTab) => `${tabsId}-panel-${id}`
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // Every preference shown here: a change after a reset makes the "reset done" line untrue (#372).
  const prefsSignature = JSON.stringify([
    hexGrid, muted, showMode, singleKeyEnabled, locale, choice,
    presentation?.active, presentation?.options, announcements?.level, notifications?.state, notifications?.rules,
  ])

  // Focus on the selected tab when it opens (#533); Tab trapped, Escape closes, focus back to the trigger (#507)
  useModalDialog({
    open,
    dialogRef: ref,
    onClose: () => onCloseRef.current(),
    initialFocus: () => ref.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'),
    listen: 'dialog',
  })

  // Native listener rather than a JSX handler: the backdrop is not an interactive element, so jsx-a11y rejects
  // onMouseDown on it.
  useEffect(() => {
    const backdrop = backdropRef.current
    if (!open || !backdrop) return
    const onBackdropMouseDown = (e: MouseEvent) => {
      e.stopPropagation()
      if (e.target === e.currentTarget) onCloseRef.current()
    }
    backdrop.addEventListener('mousedown', onBackdropMouseDown)
    return () => backdrop.removeEventListener('mousedown', onBackdropMouseDown)
  }, [open])

  if (!open) return null

  return (
    <div
      ref={backdropRef}
      {...stopPropagationHandlers}
      className="fixed inset-0 flex items-start justify-center p-3"
      style={{ zIndex: Z.contextMenu + 1, background: 'rgba(0, 0, 0, 0.5)' }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        lang={locale}
        tabIndex={-1}
        className="max-h-[calc(100vh-24px)] w-[420px] max-w-[calc(100vw-24px)] overflow-y-auto outline-none"
      >
        <GlassCard visible={true}>
          <div className="mb-3 flex items-center justify-between">
            <h2 id={titleId} className="m-0 text-xs font-mono font-semibold" style={{ color: COLORS.textPrimary }}>
              {t('settings.title')}
            </h2>
            <CloseButton onClick={onClose} label={t('common.close')} />
          </div>

          {/* Labels may wrap on two lines; the list wraps too, never a sideways scroll (WCAG 1.4.10) */}
          <div role="tablist" aria-label={t('settings.tabs')} className="mb-3 flex flex-wrap gap-1 border-b" style={{ borderColor: COLORS.glassBorder }}>
            {tabs.map(id => {
              const isSelected = id === current
              return (
                <button
                  key={id}
                  ref={el => { tabRefs.current[id] = el }}
                  id={tabDomId(id)}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  aria-controls={panelDomId(id)}
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => select(id, false)}
                  onKeyDown={onTabKeyDown}
                  className={`-mb-px min-h-6 flex-auto rounded-t px-2 py-1 text-center text-2xs font-mono ${isSelected ? 'font-semibold' : ''} ${FOCUS_RING}`}
                  style={{
                    color: isSelected ? COLORS.textPrimary : COLORS.textMuted,
                    background: isSelected ? COLORS.tabSelectedBg : 'transparent',
                    // The selected tab is told by its weight and this underline as well as by its colour
                    borderBottom: `2px solid ${isSelected ? COLORS.accent : 'transparent'}`,
                  }}
                >
                  {t(SETTINGS_TAB_LABEL[id])}
                </button>
              )
            })}
          </div>

          <div role="tabpanel" id={panelDomId('general')} aria-labelledby={tabDomId('general')} hidden={current !== 'general'}>
          <Section title={t('settings.section.appearance')}>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1 text-xs font-mono">
              <label htmlFor={themeId} style={{ color: COLORS.textPrimary }}>{t('settings.theme')}</label>
              <ThemeSelect id={themeId} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1 text-xs font-mono">
              <label htmlFor={langId} style={{ color: COLORS.textPrimary }}>{t('settings.language')}</label>
              <LanguageSelect id={langId} choice={choice} onChange={setChoice} autoLabel={t('settings.language.auto')} frLabel={t('settings.language.fr')} enLabel={t('settings.language.en')} />
            </div>
            <SwitchRow label={t('settings.hexGrid')} help={t('settings.hexGrid.help')} checked={hexGrid} onChange={onHexGridChange} />
            {quota && <SwitchRow label={t('settings.quota')} help={t('settings.quota.help')} extraHelp={t('settings.quota.setup')} checked={quota.show} onChange={quota.onShowChange} />}
          </Section>

          <Section title={t('settings.section.sound')}>
            <SwitchRow label={t('settings.sound')} help={t('settings.sound.help')} checked={!muted} onChange={() => onToggleMute()} />
          </Section>

          {onOpenViewControls && (
            // #372: a link row on the model of 'View keyboard shortcuts', not a copy of the View controls
            <Section title={t('settings.section.view')}>
              <p id={viewHelpId} className="m-0 mb-1 text-2xs font-mono" style={{ color: COLORS.textMuted }}>{t('settings.view.help')}</p>
              <button
                type="button"
                aria-describedby={viewHelpId}
                onClick={() => { onClose(); onOpenViewControls() }}
                className={`min-h-6 rounded px-2 py-1 text-2xs font-mono underline ${FOCUS_RING}`}
                style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
              >
                {t('settings.view.open')}
              </button>
            </Section>
          )}
          </div>

          <div role="tabpanel" id={panelDomId('sessions')} aria-labelledby={tabDomId('sessions')} hidden={current !== 'sessions'}>

          <Section title={t('settings.section.sessions')}>
            {/* 'Show: active / all' (#372): the same label as the top bar control, the threshold in the help; off = all */}
            <SwitchRow
              label={t('show.hideInactive')}
              help={t('settings.show.hideInactive.help', { n: ACTIVE_WINDOW_MINUTES })}
              checked={showMode === 'active'}
              onChange={on => onShowModeChange(on ? 'active' : 'all')}
            />
          </Section>

          {presentation && (
            <Section title={t('settings.section.presentation')}>
              <SwitchRow
                label={t('settings.presentation')}
                help={t('settings.presentation.help')}
                checked={presentation.active}
                onChange={presentation.onActiveChange}
              />
              <SwitchRow
                label={t('settings.presentation.subtitles')}
                help={t('settings.presentation.subtitles.help')}
                checked={presentation.options.subtitles}
                onChange={v => presentation.onOptionChange('subtitles', v)}
              />
              <SwitchRow
                label={t('settings.presentation.mask')}
                help={t('settings.presentation.mask.help')}
                checked={presentation.options.mask}
                onChange={v => presentation.onOptionChange('mask', v)}
              />
              <SwitchRow
                label={t('settings.presentation.follow')}
                help={t('settings.presentation.follow.help')}
                checked={presentation.options.follow}
                onChange={v => presentation.onOptionChange('follow', v)}
              />
            </Section>
          )}

          </div>

          {tabs.includes('notifications') && (
            <div role="tabpanel" id={panelDomId('notifications')} aria-labelledby={tabDomId('notifications')} hidden={current !== 'notifications'}>
              {notifications && <NotificationsSection notifications={notifications} />}
              {announcements && <AnnouncementsSection announcements={announcements} />}
            </div>
          )}

          <div role="tabpanel" id={panelDomId('keyboard')} aria-labelledby={tabDomId('keyboard')} hidden={current !== 'keyboard'}>

          <Section title={t('settings.section.keyboard')}>
            <SwitchRow
              label={t('settings.singleKey')}
              help={t('settings.singleKey.help')}
              checked={singleKeyEnabled}
              onChange={onSingleKeyEnabledChange}
            />
            <button
              type="button"
              onClick={() => { onClose(); onOpenShortcuts() }}
              className={`mt-1 min-h-6 rounded px-2 py-1 text-2xs font-mono underline ${FOCUS_RING}`}
              style={{ background: COLORS.toggleInactive, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
            >
              {t('settings.shortcuts')}
            </button>
          </Section>

          {onResetPrefs && <ResetSection onReset={onResetPrefs} signature={prefsSignature} shown={current === 'keyboard'} />}
          </div>
        </GlassCard>
      </div>
    </div>
  )
}
