// Settings dialog: the gear button opens a modal that groups the existing preferences.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { SettingsDialog, type SettingsDialogProps } from '@/components/agent-visualizer/settings-dialog'
import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}

const dialogProps = (over: Partial<SettingsDialogProps> = {}): SettingsDialogProps => ({
  open: true, onClose: noop,
  hexGrid: true, onHexGridChange: noop,
  muted: false, onToggleMute: noop,
  showMode: 'active', onShowModeChange: noop,
  singleKeyEnabled: true, onSingleKeyEnabledChange: noop,
  onOpenShortcuts: noop,
  ...over,
})

/** The settings sit in tabs since #533: show the panel that holds the setting under test */
const showTab = (view: ReturnType<typeof render>, name: string) => fireEvent.click(view.getByRole('tab', { name }))

const topBarProps: TopBarProps = {
  sessions: [{ id: 's1', label: 'one', status: 'active', startTime: 1, lastActivityTime: 2 }],
  selectedSessionId: ALL_SESSIONS_ID, sessionsWithActivity: new Set(),
  showSessions: false, onToggleSessions: noop, isVSCode: false, connectionStatus: 'connected',
  activeAgentCount: 1, doneAgentCount: 0, totalTokens: 10, totalCost: 0,
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, showStats: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, onToggleMute: noop, onOpenShortcuts: noop,
}

test('renders nothing when closed', () => {
  const view = render(<SettingsDialog {...dialogProps({ open: false })} />)
  assert.equal(view.queryByRole('dialog'), null)
})

test('is a labelled modal dialog with one named switch per setting', () => {
  const view = render(<SettingsDialog {...dialogProps()} />)
  const dialog = view.getByRole('dialog', { name: 'Settings' })
  assert.equal(dialog.getAttribute('aria-modal'), 'true')
  const byTab: Array<[string, string[]]> = [
    ['General', ['Hex grid', 'Sound effects']],
    ['Sessions and presentation', ['Active only \\(10 min\\)']],
    ['Keyboard and preferences', ['Enable single-key shortcuts']],
  ]
  for (const [tab, names] of byTab) {
    showTab(view, tab)
    for (const name of names) assert.ok(view.getByRole('switch', { name: new RegExp(name) }), `${tab}: ${name}`)
  }
  showTab(view, 'General')
  assert.ok(view.getByRole('combobox', { name: 'Theme' }))
})

test('toggling a switch reports the new value; sound is shown inverted from muted', () => {
  const changes: string[] = []
  const view = render(<SettingsDialog {...dialogProps({
    muted: true,
    onHexGridChange: v => changes.push(`hex:${v}`),
    onToggleMute: () => changes.push('mute'),
    onShowModeChange: v => changes.push(`show:${v}`),
  })} />)
  const sound = view.getByRole('switch', { name: /Sound effects/ }) as HTMLInputElement
  assert.equal(sound.checked, false)
  fireEvent.click(sound)
  fireEvent.click(view.getByRole('switch', { name: /Hex grid/ }))
  showTab(view, 'Sessions and presentation')
  // 'Show: active / all' (#372): checked = active only; unchecking it shows everything
  fireEvent.click(view.getByRole('switch', { name: /^Active only \(10 min\)/ }))
  assert.deepEqual(changes, ['mute', 'hex:false', 'show:all'])
})

test('the quota gauges switch reflects the preference and reports the new value (#467)', () => {
  const changes: boolean[] = []
  const view = render(<SettingsDialog {...dialogProps({ quota: { show: true, onShowChange: v => changes.push(v) } })} />)
  const quota = view.getByRole('switch', { name: /Quota gauges/ }) as HTMLInputElement
  assert.equal(quota.checked, true)
  assert.ok(view.getByText(/subscription quota/), 'a help sentence explains it')
  fireEvent.click(quota)
  assert.deepEqual(changes, [false])
  view.rerender(<SettingsDialog {...dialogProps({ quota: { show: false, onShowChange: v => changes.push(v) } })} />)
  assert.equal((view.getByRole('switch', { name: /Quota gauges/ }) as HTMLInputElement).checked, false)
})

test('the quota setting explains that Claude Code needs the status line wrapper, with the command (#467)', () => {
  const view = render(<SettingsDialog {...dialogProps({ quota: { show: true, onShowChange: () => {} } })} />)
  assert.ok(view.getByText(/node scripts\/setup\.js --statusline/), 'the enabling command is in the help')
  assert.ok(view.getByText(/without the status line wrapper|no quota is shown/i))
})

test('without the quota prop the dialog has no quota switch', () => {
  const view = render(<SettingsDialog {...dialogProps()} />)
  assert.equal(view.queryByRole('switch', { name: /Quota/ }), null)
})

test('Escape closes and focus returns to the trigger', () => {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  trigger.focus()
  let open = true
  const onClose = () => { open = false }
  const view = render(<SettingsDialog {...dialogProps({ onClose })} />)
  fireEvent.keyDown(view.getByRole('dialog'), { key: 'Escape' })
  assert.equal(open, false)
  view.rerender(<SettingsDialog {...dialogProps({ open: false, onClose })} />)
  assert.equal(document.activeElement, trigger)
})

test('"View keyboard shortcuts" closes settings then opens the shortcuts dialog', () => {
  const calls: string[] = []
  const view = render(<SettingsDialog {...dialogProps({ onClose: () => calls.push('close'), onOpenShortcuts: () => calls.push('shortcuts') })} />)
  showTab(view, 'Keyboard and preferences')
  fireEvent.click(view.getByRole('button', { name: 'View keyboard shortcuts' }))
  assert.deepEqual(calls, ['close', 'shortcuts'])
})

test('top bar gear button opens settings, and is absent without a handler', () => {
  let opened = 0
  const view = render(<TopBar {...topBarProps} onOpenSettings={() => { opened++ }} />)
  const gear = view.getByRole('button', { name: 'Settings' })
  assert.equal(gear.getAttribute('aria-haspopup'), 'dialog')
  fireEvent.click(gear)
  assert.equal(opened, 1)
  view.rerender(<TopBar {...topBarProps} />)
  assert.equal(view.queryByRole('button', { name: 'Settings' }), null)
})

test('announcements (#379): a named select with its help, reporting the chosen level; absent without the prop', () => {
  const view = render(<SettingsDialog {...dialogProps()} />)
  assert.equal(view.queryByRole('tab', { name: 'Notifications and announcements' }), null, 'no tab without its settings')
  assert.equal(document.querySelector('select[aria-describedby]'), null, 'no announcement select, hidden panels included')
  cleanup()
  const levels: string[] = []
  const shown = render(<SettingsDialog {...dialogProps({ announcements: { level: 'all', onLevelChange: l => levels.push(l) } })} />)
  showTab(shown, 'Notifications and announcements')
  const select = shown.getByRole('combobox', { name: 'Announcement level' }) as HTMLSelectElement
  assert.equal(select.value, 'all')
  assert.deepEqual(Array.from(select.options).map(o => o.textContent), ['Every change', 'Important only'])
  const help = document.getElementById(select.getAttribute('aria-describedby') ?? '')
  const helpText = help?.textContent ?? ''
  assert.ok(/the canvas announces only/.test(helpText), 'the help scopes the level to the canvas, the only region that reads it')
  assert.ok(/connection, session and panel messages are still read/.test(helpText), 'the help says the other live regions are unchanged')
  assert.ok(/never dropped/.test(helpText) && /the rest are counted/.test(helpText), 'the help says urgent states beyond three are counted, not each read')
  assert.ok(!/always announced/.test(helpText), 'no claim that each urgent state is read')
  fireEvent.change(select, { target: { value: 'important' } })
  assert.deepEqual(levels, ['important'])
})

test('reset preferences (#372): asks first, says what it resets and keeps, then calls the reset once; absent without the prop', () => {
  const none = render(<SettingsDialog {...dialogProps()} />)
  showTab(none, 'Keyboard and preferences')
  assert.equal(none.queryByRole('button', { name: 'Reset preferences' }), null)
  cleanup()
  let resets = 0
  const view = render(<SettingsDialog {...dialogProps({ onResetPrefs: () => { resets++ } })} />)
  showTab(view, 'Keyboard and preferences')
  const reset = view.getByRole('button', { name: 'Reset preferences' })
  const help = document.getElementById(reset.getAttribute('aria-describedby') ?? '')?.textContent ?? ''
  assert.ok(/Theme, language, notifications and presentation are kept/.test(help), 'the help names what is not reset')
  assert.ok(/the View menu \(Freeze motion, Calm background, links, agents, effects, Pin cards, Hide unanswered calls after\), and mutes the sound/.test(help), 'the help names the View menu and the sound, reset since #372')
  assert.ok(/the Active only filter/.test(help), 'the help names the view filter it resets')
  fireEvent.click(reset)
  assert.equal(resets, 0, 'nothing is reset before the confirmation')
  const confirm = view.getByRole('button', { name: 'Reset now' })
  assert.equal(document.activeElement, confirm, 'focus moves to the confirmation')
  fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
  assert.equal(resets, 0)
  assert.equal(document.activeElement, view.getByRole('button', { name: 'Reset preferences' }), 'cancel gives the focus back')
  fireEvent.click(view.getByRole('button', { name: 'Reset preferences' }))
  fireEvent.click(view.getByRole('button', { name: 'Reset now' }))
  assert.equal(resets, 1)
  assert.equal(view.getByRole('status').textContent, 'Preferences reset to their defaults')
  assert.equal(document.activeElement, view.getByRole('button', { name: 'Reset preferences' }))
})

test('reset confirmation (#372): the question names the group of the two buttons', () => {
  const view = render(<SettingsDialog {...dialogProps({ onResetPrefs: noop })} />)
  showTab(view, 'Keyboard and preferences')
  fireEvent.click(view.getByRole('button', { name: 'Reset preferences' }))
  const group = view.getByRole('group', { name: 'Restore these preferences to their defaults?' })
  assert.ok(group.contains(view.getByRole('button', { name: 'Reset now' })))
  assert.ok(group.contains(view.getByRole('button', { name: 'Cancel' })))
})

test('reset done line (#372): disappears as soon as a preference changes afterwards, so it never states something false', () => {
  const props = dialogProps({ onResetPrefs: noop })
  const view = render(<SettingsDialog {...props} />)
  showTab(view, 'Keyboard and preferences')
  fireEvent.click(view.getByRole('button', { name: 'Reset preferences' }))
  fireEvent.click(view.getByRole('button', { name: 'Reset now' }))
  assert.equal(view.getByRole('status').textContent, 'Preferences reset to their defaults')
  view.rerender(<SettingsDialog {...props} />)
  assert.equal(view.getByRole('status').textContent, 'Preferences reset to their defaults', 'an unrelated re-render keeps it')
  view.rerender(<SettingsDialog {...props} showMode={props.showMode === 'active' ? 'all' : 'active'} />)
  assert.equal(view.getByRole('status').textContent, '')
})
