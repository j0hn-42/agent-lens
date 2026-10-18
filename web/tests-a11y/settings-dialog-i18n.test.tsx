// #247: the settings dialog is translatable; a language selector (native select) switches it live.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { SettingsDialog, type SettingsDialogProps } from '@/components/agent-visualizer/settings-dialog'
import { setLocaleChoice } from '@/lib/locale'
import { LOCALE_STORAGE_KEY, MESSAGES, translate } from '@/lib/messages'
import { DEFAULT_RULES } from '@/lib/notification-rules'
import { SETTINGS_TAB_LABEL, type SettingsTab } from '@/lib/settings-tabs'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  setLocaleChoice('auto')
  window.localStorage.clear()
})

const noop = () => {}
const props = (over: Partial<SettingsDialogProps> = {}): SettingsDialogProps => ({
  open: true, onClose: noop,
  hexGrid: true, onHexGridChange: noop,
  muted: false, onToggleMute: noop,
  showMode: 'active', onShowModeChange: noop,
  singleKeyEnabled: true, onSingleKeyEnabledChange: noop,
  onOpenShortcuts: noop,
  notifications: { state: 'off', onToggle: noop, rules: DEFAULT_RULES, onRulesChange: noop },
  ...over,
})
/** Settings sit in tabs since #533: show the panel of a tab, named in French */
const showFrTab = (view: ReturnType<typeof render>, tab: SettingsTab) => fireEvent.click(view.getByRole('tab', { name: MESSAGES.fr[SETTINGS_TAB_LABEL[tab]] }))
const channel = (state: 'on' | 'off' | 'denied' | 'unsupported') => ({ notifications: { state, onToggle: noop, rules: DEFAULT_RULES, onRulesChange: noop } })

test('a language selector offers automatic, French and English, named in the current language', () => {
  const view = render(<SettingsDialog {...props()} />)
  const select = view.getByRole('combobox', { name: MESSAGES.en['settings.language'] }) as HTMLSelectElement
  assert.equal(select.value, 'auto')
  const options = Array.from(select.options).map(o => [o.value, o.textContent])
  assert.deepEqual(options, [['auto', MESSAGES.en['settings.language.auto']], ['fr', 'Français'], ['en', 'English']])
  // each language is written in its own language, and says so to a screen reader
  assert.equal(select.options[1].getAttribute('lang'), 'fr')
  assert.equal(select.options[2].getAttribute('lang'), 'en')
})

test('choosing French relabels the dialog at once, stores the choice and sets lang', () => {
  const view = render(<SettingsDialog {...props()} />)
  assert.equal(view.getByRole('dialog').getAttribute('lang'), 'en')
  fireEvent.change(view.getByRole('combobox', { name: 'Language' }), { target: { value: 'fr' } })
  assert.equal(window.localStorage.getItem(LOCALE_STORAGE_KEY), 'fr')
  const dialog = view.getByRole('dialog', { name: MESSAGES.fr['settings.title'] })
  assert.equal(dialog.getAttribute('lang'), 'fr')
  const select = view.getByRole('combobox', { name: MESSAGES.fr['settings.language'] }) as HTMLSelectElement
  assert.equal(select.value, 'fr')
  assert.ok(view.getByRole('combobox', { name: MESSAGES.fr['settings.theme'] }))
  assert.ok(view.getByRole('button', { name: MESSAGES.fr['common.close'] }))
  assert.ok(view.getByRole('tablist', { name: MESSAGES.fr['settings.tabs'] }))
  // One tab at a time (#533): its switches and its sections, named in French
  const byTab: Array<[SettingsTab, Array<'settings.hexGrid' | 'settings.sound' | 'show.hideInactive' | 'settings.singleKey' | 'settings.notify.enable'>, Array<'settings.section.appearance' | 'settings.section.sound' | 'settings.section.sessions' | 'settings.section.notifications' | 'settings.section.keyboard'>]> = [
    ['general', ['settings.hexGrid', 'settings.sound'], ['settings.section.appearance', 'settings.section.sound']],
    ['sessions', ['show.hideInactive'], ['settings.section.sessions']],
    ['notifications', ['settings.notify.enable'], ['settings.section.notifications']],
    ['keyboard', ['settings.singleKey'], ['settings.section.keyboard']],
  ]
  for (const [tab, switches, regions] of byTab) {
    showFrTab(view, tab)
    for (const key of switches) {
      const label = translate('fr', key, { n: 10 }).replace(/[()]/g, '\\$&')
      assert.ok(view.getByRole('switch', { name: new RegExp(label) }), `${tab}: ${key}`)
    }
    for (const key of regions) assert.ok(view.getByRole('region', { name: MESSAGES.fr[key] }), `${tab}: ${key}`)
  }
  assert.ok(view.getByRole('button', { name: MESSAGES.fr['settings.shortcuts'] }))
  showFrTab(view, 'general')
  assert.equal(view.queryByRole('switch', { name: /Hex grid/ }), null)
})

test('the stored choice is read when the dialog opens, and "automatic" goes back to the browser', () => {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, 'fr')
  const view = render(<SettingsDialog {...props()} />)
  assert.ok(view.getByRole('dialog', { name: MESSAGES.fr['settings.title'] }))
  fireEvent.change(view.getByRole('combobox', { name: MESSAGES.fr['settings.language'] }), { target: { value: 'auto' } })
  assert.equal(window.localStorage.getItem(LOCALE_STORAGE_KEY), null)
  assert.ok(view.getByRole('dialog', { name: MESSAGES.en['settings.title'] }))
})

test('the cost threshold error is translated and still announced', () => {
  setLocaleChoice('fr')
  const view = render(<SettingsDialog {...props(channel('on'))} />)
  showFrTab(view, 'notifications')
  const amount = view.getByRole('spinbutton', { name: MESSAGES.fr['settings.notify.threshold'] })
  fireEvent.change(amount, { target: { value: '0' } })
  assert.equal(view.getByRole('alert').textContent, MESSAGES.fr['settings.notify.invalid'])
})

test('a blocked or unavailable channel says so in French', () => {
  setLocaleChoice('fr')
  const denied = render(<SettingsDialog {...props(channel('denied'))} />)
  showFrTab(denied, 'notifications')
  assert.ok(denied.getByText(MESSAGES.fr['settings.notify.denied']))
  denied.unmount()
  const unsupported = render(<SettingsDialog {...props(channel('unsupported'))} />)
  showFrTab(unsupported, 'notifications')
  assert.ok(unsupported.getByText(MESSAGES.fr['settings.notify.unsupported']))
})
