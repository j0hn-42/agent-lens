// 'Show: active / all' (#372) in the top bar: one native toggle replaces 'Hide inactive agents' and 'Show finished
// sessions (N)'. aria-pressed = active only; its accessible name starts with the visible label and states the exact
// threshold, in the interface language; its place in the Tab order does not depend on its state or on the view.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { TopBar, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import { setLocaleChoice } from '@/lib/locale'
import { LOCALES, translate } from '@/lib/messages'
import type { ShowMode } from '@/lib/show-mode'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  setLocaleChoice('auto')
})

const noop = () => {}
const base: TopBarProps = {
  sessions: [{ id: 's1', label: 'one', status: 'active', startTime: 1, lastActivityTime: 2 }],
  selectedSessionId: ALL_SESSIONS_ID, sessionsWithActivity: new Set(),
  showSessions: false, onToggleSessions: noop, isVSCode: false, connectionStatus: 'connected',
  activeAgentCount: 1, doneAgentCount: 0, totalTokens: 10, totalCost: 0,
  showFileAttention: false, showConversation: false, showCostOverlay: false, showTimeline: false, isMuted: false,
  onTogglePanel: noop, onToggleTimeline: noop, onToggleStats: noop, showStats: false, onToggleMute: noop, onOpenShortcuts: noop,
  notifyState: 'off', onToggleNotify: noop, onOpenSettings: noop,
}

const NAME_EN = 'Active only (10 min): hides agents whose turn is over and finished sessions with no event for 10 minutes'

test('one native toggle, named with the exact threshold, pressed while only the active ones are shown', () => {
  const calls: ShowMode[] = []
  const { getByRole, rerender } = render(<TopBar {...base} showMode="active" onChangeShowMode={m => calls.push(m)} />)
  const btn = getByRole('button', { name: NAME_EN })
  assert.equal(btn.tagName, 'BUTTON')
  assert.equal(btn.getAttribute('type'), 'button', 'native button: Enter and Space work without a key handler')
  assert.equal(btn.textContent, 'Active only (10 min)', 'the visible label states the threshold too')
  assert.ok(NAME_EN.startsWith(btn.textContent ?? '\u0000'), '2.5.3: the name starts with the visible label')
  assert.match(btn.getAttribute('title') ?? '', /10 minutes/)
  assert.equal(btn.getAttribute('aria-pressed'), 'true')
  fireEvent.click(btn)
  assert.deepEqual(calls, ['all'])
  rerender(<TopBar {...base} showMode="all" onChangeShowMode={m => calls.push(m)} />)
  const off = getByRole('button', { name: NAME_EN })
  assert.equal(off.getAttribute('aria-pressed'), 'false')
  fireEvent.click(off)
  assert.deepEqual(calls, ['all', 'active'])
})

test('the two former filter buttons are gone, in the All view and in a session', () => {
  for (const selectedSessionId of [ALL_SESSIONS_ID, 's1']) {
    const view = render(<TopBar {...base} selectedSessionId={selectedSessionId} showMode="active" onChangeShowMode={noop} />)
    assert.ok(view.queryByRole('button', { name: /Hide inactive agents|Show finished sessions/ }) === null, 'no former filter button')
    assert.equal(view.getAllByRole('button', { name: /^Active only \(10 min\)/ }).length, 1, 'one control, also in a single session')
    view.unmount()
  }
})

test('stable Tab order: the control keeps its place whatever its state and the view', () => {
  const position = (mode: ShowMode, selectedSessionId: string) => {
    const view = render(<TopBar {...base} selectedSessionId={selectedSessionId} showMode={mode} onChangeShowMode={noop} />)
    const buttons = view.getAllByRole('button')
    const at = buttons.findIndex(b => (b.getAttribute('aria-label') ?? '').startsWith('Active only'))
    const order = buttons.map(b => b.getAttribute('aria-label') ?? b.textContent ?? '')
    view.unmount()
    return { at, order }
  }
  const ref = position('active', ALL_SESSIONS_ID)
  assert.ok(ref.at > 0)
  for (const [mode, sel] of [['all', ALL_SESSIONS_ID], ['active', 's1'], ['all', 's1']] as const) {
    const p = position(mode, sel)
    assert.equal(p.at, ref.at, `${mode} / ${sel}`)
    assert.equal(p.order.length, ref.order.length, `${mode} / ${sel}: no button appears or disappears`)
  }
  // Right after Notifications, the other filter of row 1
  assert.equal(ref.order[ref.at - 1], 'Notifications')
})

for (const locale of LOCALES) {
  test(`the control speaks ${locale}: label, name with the threshold, tooltip, lang`, () => {
    setLocaleChoice(locale)
    const view = render(<TopBar {...base} showMode="active" onChangeShowMode={noop} />)
    const name = translate(locale, 'show.active.name', { n: 10 })
    const btn = view.getByRole('button', { name })
    assert.equal(btn.textContent, translate(locale, 'show.active', { n: 10 }))
    assert.ok(name.startsWith(btn.textContent ?? '\u0000'))
    assert.equal(btn.getAttribute('title'), translate(locale, 'show.active.title', { n: 10 }))
    assert.equal(btn.closest('[lang]')?.getAttribute('lang'), locale)
  })
}

test('without a handler the control is not drawn (no dead button)', () => {
  const view = render(<TopBar {...base} showMode="active" />)
  assert.ok(view.queryByRole('button', { name: /^Active only/ }) === null)
})
