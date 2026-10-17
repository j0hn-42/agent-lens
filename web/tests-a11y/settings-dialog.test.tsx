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
  showFinished: false, onShowFinishedChange: noop,
  hideInactive: true, onHideInactiveChange: noop,
  singleKeyEnabled: true, onSingleKeyEnabledChange: noop,
  onOpenShortcuts: noop,
  ...over,
})

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
  for (const name of ['Hex grid', 'Sound effects', 'Show finished sessions', 'Hide inactive agents', 'Enable single-key shortcuts']) {
    assert.ok(view.getByRole('switch', { name: new RegExp(name) }), name)
  }
  assert.ok(view.getByRole('combobox', { name: 'Theme' }))
})

test('toggling a switch reports the new value; sound is shown inverted from muted', () => {
  const changes: string[] = []
  const view = render(<SettingsDialog {...dialogProps({
    muted: true,
    onHexGridChange: v => changes.push(`hex:${v}`),
    onToggleMute: () => changes.push('mute'),
    onHideInactiveChange: v => changes.push(`hide:${v}`),
  })} />)
  const sound = view.getByRole('switch', { name: /Sound effects/ }) as HTMLInputElement
  assert.equal(sound.checked, false)
  fireEvent.click(sound)
  fireEvent.click(view.getByRole('switch', { name: /Hex grid/ }))
  fireEvent.click(view.getByRole('switch', { name: /Hide inactive agents/ }))
  assert.deepEqual(changes, ['mute', 'hex:false', 'hide:false'])
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
  assert.equal(view.queryByRole('combobox', { name: 'Announcement level' }), null)
  cleanup()
  const levels: string[] = []
  const shown = render(<SettingsDialog {...dialogProps({ announcements: { level: 'all', onLevelChange: l => levels.push(l) } })} />)
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
