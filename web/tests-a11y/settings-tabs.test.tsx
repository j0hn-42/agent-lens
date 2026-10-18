// #533: the Settings dialog is split into four tabs (ARIA tabs pattern) instead of one long scroll. The content and the rules
// of each setting are unchanged; only where they sit changes. Driven with real key events, so removing a handler fails a test.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act, renderHook } from '@testing-library/react'

import { SettingsDialog, type SettingsDialogProps } from '@/components/agent-visualizer/settings-dialog'
import { useDialogsState } from '@/hooks/use-dialogs-state'
import { setLocaleChoice } from '@/lib/locale'
import { MESSAGES } from '@/lib/messages'
import { visibleSettingsTabs } from '@/lib/settings-tabs'
import { DEFAULT_RULES } from '@/lib/notification-rules'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  setLocaleChoice('auto')
  window.localStorage.clear()
  window.sessionStorage.clear()
})

const noop = () => {}
const props = (over: Partial<SettingsDialogProps> = {}): SettingsDialogProps => ({
  open: true, onClose: noop,
  hexGrid: true, onHexGridChange: noop,
  muted: false, onToggleMute: noop,
  showMode: 'active', onShowModeChange: noop,
  singleKeyEnabled: true, onSingleKeyEnabledChange: noop,
  onOpenShortcuts: noop,
  onResetPrefs: noop,
  presentation: { active: false, onActiveChange: noop, options: { subtitles: true, mask: false, follow: false }, onOptionChange: noop },
  announcements: { level: 'all', onLevelChange: noop },
  notifications: { state: 'off', onToggle: noop, rules: DEFAULT_RULES, onRulesChange: noop },
  ...over,
})

const NAMES = ['General', 'Sessions and presentation', 'Notifications and announcements', 'Keyboard and preferences']
const tabs = (view: ReturnType<typeof render>) => view.getAllByRole('tab')
const selected = (view: ReturnType<typeof render>) => view.getByRole('tab', { selected: true })
const key = (el: Element, k: string) => act(() => { fireEvent.keyDown(el, { key: k }) })

test('one tablist named in the active language, four tabs in order, one panel named by its tab', () => {
  const view = render(<SettingsDialog {...props()} />)
  const list = view.getByRole('tablist', { name: 'Settings sections' })
  assert.deepEqual(tabs(view).map(t => t.textContent), NAMES)
  for (const t of tabs(view)) assert.ok(list.contains(t))
  const panel = view.getByRole('tabpanel')
  assert.equal(panel.getAttribute('aria-labelledby'), selected(view).id)
  assert.equal(selected(view).getAttribute('aria-controls'), panel.id)
  assert.equal(selected(view).textContent, 'General')
  // Only the active panel is exposed; the others are rendered but hidden
  assert.equal(view.getAllByRole('tabpanel').length, 1)
  assert.equal(document.querySelectorAll('[role="tabpanel"][hidden]').length, 3)
})

test('the tablist is a single tab stop: roving tabindex on the selected tab', () => {
  const view = render(<SettingsDialog {...props()} />)
  assert.deepEqual(tabs(view).map(t => t.getAttribute('tabindex')), ['0', '-1', '-1', '-1'])
  fireEvent.click(tabs(view)[2])
  assert.deepEqual(tabs(view).map(t => t.getAttribute('tabindex')), ['-1', '-1', '0', '-1'])
})

test('Left / Right move and select (wrapping), Home / End go to the ends; focus follows', async () => {
  const view = render(<SettingsDialog {...props()} />)
  const first = tabs(view)[0]
  first.focus()
  await key(first, 'ArrowRight')
  assert.equal(selected(view).textContent, NAMES[1])
  assert.equal(document.activeElement, selected(view))
  await key(selected(view), 'End')
  assert.equal(selected(view).textContent, NAMES[3])
  assert.equal(document.activeElement, selected(view))
  await key(selected(view), 'ArrowRight')
  assert.equal(selected(view).textContent, NAMES[0], 'Right on the last tab wraps to the first')
  await key(selected(view), 'ArrowLeft')
  assert.equal(selected(view).textContent, NAMES[3], 'Left on the first tab wraps to the last')
  await key(selected(view), 'Home')
  assert.equal(selected(view).textContent, NAMES[0])
  assert.equal(document.activeElement, selected(view))
})

test('each tab holds the sections decided in #533, every setting stays reachable', () => {
  const view = render(<SettingsDialog {...props({ quota: { show: true, onShowChange: noop } })} />)
  const expect: Array<[string, string[], RegExp[]]> = [
    ['General', ['Appearance', 'Sound'], [/Hex grid/, /Quota gauges/, /Sound effects/]],
    ['Sessions and presentation', ['Sessions and agents', 'Presentation'], [/Active only \(10 min\)/, /Presentation mode/, /Subtitles of transitions/, /Mask sensitive data/, /Follow the active agent/]],
    ['Notifications and announcements', ['Notifications', 'Screen reader announcements'], [/Enable notifications/, /Agent waiting for a permission/, /Agent in error/, /Session finished/, /Cost threshold reached/]],
    ['Keyboard and preferences', ['Keyboard', 'Preferences'], [/Enable single-key shortcuts/]],
  ]
  for (const [tab, regions, switches] of expect) {
    fireEvent.click(view.getByRole('tab', { name: tab }))
    const panel = view.getByRole('tabpanel', { name: tab })
    assert.deepEqual(Array.from(panel.querySelectorAll('section')).map(s => s.getAttribute('aria-label')), regions, tab)
    for (const name of switches) assert.ok(view.getByRole('switch', { name }), `${tab}: ${name}`)
  }
  fireEvent.click(view.getByRole('tab', { name: 'General' }))
  assert.ok(view.getByRole('combobox', { name: 'Theme' }))
  assert.ok(view.getByRole('combobox', { name: 'Language' }))
  fireEvent.click(view.getByRole('tab', { name: 'Notifications and announcements' }))
  assert.ok(view.getByRole('spinbutton', { name: 'Cost threshold (USD)' }))
  assert.ok(view.getByRole('combobox', { name: 'Announcement level' }))
  fireEvent.click(view.getByRole('tab', { name: 'Keyboard and preferences' }))
  assert.ok(view.getByRole('button', { name: 'View keyboard shortcuts' }))
  assert.ok(view.getByRole('button', { name: 'Reset preferences' }))
})

test('a tab with nothing to show is left out (no notifications nor announcements)', () => {
  const view = render(<SettingsDialog {...props({ notifications: undefined, announcements: undefined })} />)
  assert.deepEqual(tabs(view).map(t => t.textContent), [NAMES[0], NAMES[1], NAMES[3]])
})

test('the tab names follow the language, and the dialog keeps its lang', () => {
  setLocaleChoice('fr')
  const view = render(<SettingsDialog {...props()} />)
  assert.ok(view.getByRole('tablist', { name: MESSAGES.fr['settings.tabs'] }))
  assert.deepEqual(tabs(view).map(t => t.textContent), ['Général', 'Sessions et présentation', 'Notifications et annonces', 'Clavier et préférences'])
  assert.equal(view.getByRole('dialog').getAttribute('lang'), 'fr')
})

test('focus goes to the selected tab on open; Tab goes Close, tab, then the panel, and the trap skips hidden panels', async () => {
  const view = render(<SettingsDialog {...props()} />)
  assert.equal(document.activeElement, selected(view), 'the selected tab has the focus when the dialog opens')
  const dialog = view.getByRole('dialog')
  const close = view.getByRole('button', { name: 'Close' })
  // DOM order = focus order: Close, the tablist (one stop), then the controls of the active panel
  const order = Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select'))
    .filter(el => el.tabIndex >= 0 && !el.closest('[hidden]'))
  assert.equal(order[0], close)
  assert.equal(order[1], selected(view))
  assert.equal(order[2], view.getByRole('combobox', { name: 'Theme' }))
  // Shift+Tab on the first control wraps to the last control of the ACTIVE panel, not of a hidden one
  close.focus()
  await act(() => { fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }) })
  assert.equal(document.activeElement, order[order.length - 1])
  assert.equal((document.activeElement as HTMLElement).closest('[hidden]'), null)
  // Tab on the last one wraps to Close
  await act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Tab' }) })
  assert.equal(document.activeElement, close)
})

test('Escape still closes the dialog from a tab', async () => {
  let closed = 0
  const view = render(<SettingsDialog {...props({ onClose: () => { closed++ } })} />)
  await key(selected(view), 'Escape')
  assert.equal(closed, 1)
})

test('the last tab is remembered while the page lives (closed and reopened), and never stored', () => {
  const view = render(<SettingsDialog {...props()} />)
  fireEvent.click(view.getByRole('tab', { name: 'Notifications and announcements' }))
  view.rerender(<SettingsDialog {...props({ open: false })} />)
  view.rerender(<SettingsDialog {...props()} />)
  assert.equal(selected(view).textContent, 'Notifications and announcements')
  assert.equal(window.localStorage.length, 0, 'nothing in local storage (the agent-lens:ui-prefs blob included)')
  assert.equal(window.sessionStorage.length, 0, 'nothing in session storage either')
})

test('a controlled tab (opened on a given tab) is selected and focused, and changes are reported', () => {
  const changes: string[] = []
  const view = render(<SettingsDialog {...props({ tab: 'keyboard', onTabChange: t => changes.push(t) })} />)
  assert.equal(selected(view).textContent, 'Keyboard and preferences')
  assert.equal(document.activeElement, selected(view))
  fireEvent.click(view.getByRole('tab', { name: 'General' }))
  assert.deepEqual(changes, ['general'])
})

test('useDialogsState: openSettingsTab opens on that tab; the tab is kept in memory across close and plain open', () => {
  const { result } = renderHook(() => useDialogsState())
  assert.equal(result.current.settingsTab, 'general')
  act(() => { result.current.openSettingsTab('notifications') })
  assert.equal(result.current.showSettings, true)
  assert.equal(result.current.settingsTab, 'notifications')
  act(() => { result.current.closeSettings() })
  act(() => { result.current.setSettingsTab('sessions') })
  act(() => { result.current.openSettings() })
  assert.equal(result.current.settingsTab, 'sessions', 'a plain open keeps the last tab')
  assert.equal(window.localStorage.length, 0)
  assert.equal(window.sessionStorage.length, 0)
})

test('switching tab while the reset confirmation is asked cancels it; nothing is reset', async () => {
  let resets = 0
  const view = render(<SettingsDialog {...props({ onResetPrefs: () => { resets++ } })} />)
  fireEvent.click(view.getByRole('tab', { name: 'Keyboard and preferences' }))
  fireEvent.click(view.getByRole('button', { name: 'Reset preferences' }))
  assert.ok(view.getByRole('button', { name: 'Reset now' }))
  await key(selected(view), 'ArrowLeft')
  assert.equal(selected(view).textContent, 'Notifications and announcements')
  assert.equal(document.activeElement, selected(view), 'focus stays on the tab, not pulled into a hidden panel')
  await key(selected(view), 'ArrowRight')
  assert.equal(view.queryByRole('button', { name: 'Reset now' }), null, 'the confirmation is gone')
  assert.ok(view.getByRole('button', { name: 'Reset preferences' }))
  assert.equal(resets, 0)
})

test('arrow, Home and End with Alt, Ctrl or Meta are left to the browser: no tab change, not prevented', async () => {
  const view = render(<SettingsDialog {...props()} />)
  const first = tabs(view)[0]
  first.focus()
  for (const mod of ['altKey', 'ctrlKey', 'metaKey'] as const) {
    for (const k of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
      const notPrevented = fireEvent.keyDown(first, { key: k, [mod]: true })
      assert.equal(notPrevented, true, `${mod}+${k} is not swallowed`)
      assert.equal(selected(view).textContent, NAMES[0], `${mod}+${k} does not change the tab`)
    }
  }
})

test('the palette offers the tabs the dialog shows: Notifications is left out without notifications and announcements', () => {
  assert.deepEqual(visibleSettingsTabs({ notifications: true, announcements: true }), ['general', 'sessions', 'notifications', 'keyboard'])
  assert.deepEqual(visibleSettingsTabs({ notifications: false, announcements: true }), ['general', 'sessions', 'notifications', 'keyboard'])
  assert.deepEqual(visibleSettingsTabs({ notifications: true, announcements: false }), ['general', 'sessions', 'notifications', 'keyboard'])
  assert.deepEqual(visibleSettingsTabs({ notifications: false, announcements: false }), ['general', 'sessions', 'keyboard'])
  const view = render(<SettingsDialog {...props({ notifications: undefined, announcements: undefined })} />)
  assert.deepEqual(tabs(view).map(t => t.textContent), [NAMES[0], NAMES[1], NAMES[3]], 'the dialog shows exactly that list')
})
