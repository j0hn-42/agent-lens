// 'Show: active / all' (#372) in the top bar: one native toggle, "Hide inactive", replaces 'Hide inactive agents' and
// 'Show finished sessions (N)'. aria-pressed = the inactive ones are hidden. Its accessible name starts with the visible
// label and says only what applies to the view (sessions only in All sessions); the rule and the 10-minute window of
// the session filter are in the tooltip. In All, while it hides finished sessions, it says how many (the count the
// former 'Show finished sessions (N)' carried), and so does More, behind which it is (one-line bar). Its place in the Tab
// order does not depend on its state or on the view.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { TopBar, TOPBAR_MORE_ID, type TopBarProps } from '@/components/agent-visualizer/top-bar'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import { setLocaleChoice } from '@/lib/locale'
import { LOCALES, translate } from '@/lib/messages'
import type { ShowMode } from '@/lib/show-mode'
import { setMobileView } from './mobile-media'
import { openMore } from './topbar-more'

afterEach(() => {
  setMobileView(false)
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

const NAME_ALL = 'Hide inactive: agents and sessions'
const NAME_ONE = 'Hide inactive: agents'
const describedText = (el: HTMLElement) => (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
  .map(id => document.getElementById(id)?.textContent ?? '').join(' ')
/** Accessible name given by aria-label or aria-labelledby */
const labelOf = (el: HTMLElement) => el.getAttribute('aria-label') ?? (el.getAttribute('aria-labelledby') ?? '').split(' ').filter(Boolean)
  .map(id => document.getElementById(id)?.textContent ?? '').join(' ')

test('one native toggle, short name, pressed while the inactive ones are hidden', () => {
  const calls: ShowMode[] = []
  const { getByRole, rerender } = render(<TopBar {...base} showMode="active" onChangeShowMode={m => calls.push(m)} />)
  openMore() // the filters are behind More (one-line bar)
  const btn = getByRole('button', { name: NAME_ALL })
  assert.equal(btn.tagName, 'BUTTON')
  assert.equal(btn.getAttribute('type'), 'button', 'native button: Enter and Space work without a key handler')
  assert.equal(btn.textContent, 'Hide inactive', 'the visible label claims no time window')
  assert.ok(NAME_ALL.startsWith(btn.textContent ?? '\u0000'), '2.5.3: the name starts with the visible label')
  // The rule is in the tooltip, not repeated in the name
  assert.match(btn.getAttribute('title') ?? '', /10 minutes/)
  assert.doesNotMatch(NAME_ALL, /minute/)
  assert.equal(btn.getAttribute('aria-pressed'), 'true')
  fireEvent.click(btn)
  assert.deepEqual(calls, ['all'])
  rerender(<TopBar {...base} showMode="all" onChangeShowMode={m => calls.push(m)} />)
  const off = getByRole('button', { name: NAME_ALL })
  assert.equal(off.getAttribute('aria-pressed'), 'false')
  fireEvent.click(off)
  assert.deepEqual(calls, ['all', 'active'])
})

test('in a single session the name and the tooltip speak of agents only: no session is hidden there', () => {
  const view = render(<TopBar {...base} selectedSessionId="s1" showMode="active" onChangeShowMode={noop} finishedSessionCount={3} />)
  openMore() // the filters are behind More (one-line bar)
  const btn = view.getByRole('button', { name: NAME_ONE })
  assert.equal(btn.textContent, 'Hide inactive')
  assert.doesNotMatch(btn.getAttribute('title') ?? '', /session|minute/)
  assert.equal(btn.getAttribute('aria-describedby'), null, 'no hidden-session count outside All sessions')
})

test('All sessions, inactive hidden: the number of finished sessions hidden is described and in the tooltip', () => {
  const { getByRole, rerender } = render(<TopBar {...base} showMode="active" onChangeShowMode={noop} finishedSessionCount={3} />)
  openMore() // the filters are behind More (one-line bar)
  const btn = getByRole('button', { name: NAME_ALL })
  assert.equal(describedText(btn), 'Finished sessions hidden: 3')
  assert.match(btn.getAttribute('title') ?? '', /Finished sessions hidden: 3/)
  // Shown: nothing hidden, no count claimed
  rerender(<TopBar {...base} showMode="all" onChangeShowMode={noop} finishedSessionCount={3} />)
  assert.equal(getByRole('button', { name: NAME_ALL }).getAttribute('aria-describedby'), null)
  assert.doesNotMatch(getByRole('button', { name: NAME_ALL }).getAttribute('title') ?? '', /hidden: \d/)
  // None finished: no count either
  rerender(<TopBar {...base} showMode="active" onChangeShowMode={noop} finishedSessionCount={0} />)
  assert.equal(getByRole('button', { name: NAME_ALL }).getAttribute('aria-describedby'), null)
})

test('folded, More names the filter with the number of finished sessions it hides in All', () => {
  setMobileView(true)
  const view = render(<TopBar {...base} showMode="active" onChangeShowMode={noop} finishedSessionCount={3} onToggleFullscreen={noop} />)
  openMore() // the filters are behind More (one-line bar)
  const more = view.container.querySelector<HTMLButtonElement>(`#${TOPBAR_MORE_ID}`)!
  assert.match(labelOf(more), /\(Hide inactive · finished sessions hidden: 3\)$/)
  assert.match(more.textContent ?? '', /1 filter/, 'one filter, however many sessions it hides')
  view.unmount()
  // In a single session the count does not apply
  const one = render(<TopBar {...base} selectedSessionId="s1" showMode="active" onChangeShowMode={noop} finishedSessionCount={3} onToggleFullscreen={noop} />)
  openMore() // the filters are behind More (one-line bar)
  const more1 = one.container.querySelector<HTMLButtonElement>(`#${TOPBAR_MORE_ID}`)!
  assert.match(labelOf(more1), /\(Hide inactive\)$/)
})

test('the two former filter buttons are gone, in the All view and in a session', () => {
  for (const selectedSessionId of [ALL_SESSIONS_ID, 's1']) {
    const view = render(<TopBar {...base} selectedSessionId={selectedSessionId} showMode="active" onChangeShowMode={noop} />)
    openMore() // the filters are behind More (one-line bar)
    assert.ok(view.queryByRole('button', { name: /Hide inactive agents|Show finished sessions|Active only/ }) === null, 'no former filter button')
    assert.equal(view.getAllByRole('button', { name: /^Hide inactive/ }).length, 1, 'one control, also in a single session')
    view.unmount()
  }
})

test('stable Tab order: the control keeps its place whatever its state and the view', () => {
  const position = (mode: ShowMode, selectedSessionId: string) => {
    const view = render(<TopBar {...base} selectedSessionId={selectedSessionId} showMode={mode} onChangeShowMode={noop} finishedSessionCount={2} />)
    openMore() // the filters are behind More (one-line bar)
    const buttons = view.getAllByRole('button')
    const at = buttons.findIndex(b => (b.getAttribute('aria-label') ?? '').startsWith('Hide inactive'))
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
  test(`the control speaks ${locale}: label, name, tooltip, count, lang`, () => {
    setLocaleChoice(locale)
    const view = render(<TopBar {...base} showMode="active" onChangeShowMode={noop} finishedSessionCount={4} />)
    openMore() // the filters are behind More (one-line bar)
    const name = translate(locale, 'show.hideInactive.name.all')
    const btn = view.getByRole('button', { name })
    assert.equal(btn.textContent, translate(locale, 'show.hideInactive'))
    assert.ok(name.startsWith(btn.textContent ?? '\u0000'))
    assert.ok((btn.getAttribute('title') ?? '').startsWith(translate(locale, 'show.hideInactive.title.all', { n: 10 })))
    assert.equal(describedText(btn), translate(locale, 'show.hideInactive.count', { n: 4 }))
    assert.equal(btn.closest('[lang]')?.getAttribute('lang'), locale)
  })
}

test('without a handler the control is not drawn (no dead button)', () => {
  const view = render(<TopBar {...base} showMode="active" />)
  openMore() // the filters are behind More (one-line bar)
  assert.ok(view.queryByRole('button', { name: /^Hide inactive/ }) === null)
})
