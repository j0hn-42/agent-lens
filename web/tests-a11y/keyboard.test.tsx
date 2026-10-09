// Keyboard scenarios (issue #43): pure-function level plus real DOM targets from jsdom.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { shouldHandleShortcut } from '@/hooks/use-keyboard-shortcuts'
import { nextTabIndex, scrubberKeyTarget } from '@/lib/chrome-utils'
import { nextMenuIndex } from '@/lib/menu-nav'
import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import { showAllSessions } from './sessions-filter-helpers'
import { compareViolations, validateKnownViolations } from './axe-compare'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

function keyEvent(key: string, target: Element | null, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) {
  return { key, target, ctrlKey: false, metaKey: false, altKey: false, ...mods }
}

function el(html: string): Element {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host.firstElementChild as Element
}

test('Space on a focused button never triggers the global play/pause shortcut', () => {
  const button = el('<button>Play</button>')
  assert.equal(shouldHandleShortcut(keyEvent(' ', button), true), false)
  assert.equal(shouldHandleShortcut(keyEvent(' ', document.body), true), true)
})

test('single-key shortcuts are ignored in text fields, dialogs and tabs', () => {
  for (const html of ['<input />', '<textarea></textarea>', '<div role="dialog"><span>x</span></div>', '<div contenteditable="true"></div>']) {
    const target = el(html)
    const inner = target.firstElementChild ?? target
    assert.equal(shouldHandleShortcut(keyEvent('f', inner), true), false, html)
  }
  assert.equal(shouldHandleShortcut(keyEvent('f', el('<button role="tab">t</button>')), true), false)
})

test('Escape still closes panels from buttons but not from text fields or dialogs', () => {
  assert.equal(shouldHandleShortcut(keyEvent('Escape', el('<button>b</button>')), false), true)
  assert.equal(shouldHandleShortcut(keyEvent('Escape', el('<input />')), true), false)
  assert.equal(shouldHandleShortcut(keyEvent('Escape', el('<div role="dialog"><button>x</button></div>').firstElementChild), true), false)
})

test('modifier combos are never captured (WCAG 2.1.4)', () => {
  for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
    assert.equal(shouldHandleShortcut(keyEvent('f', document.body, { [mod]: true }), true), false, mod)
  }
})

test('single-key shortcuts can be disabled by preference, Escape stays available', () => {
  assert.equal(shouldHandleShortcut(keyEvent('t', document.body), false), false)
  assert.equal(shouldHandleShortcut(keyEvent('Escape', document.body), false), true)
})

test('tab keyboard model: arrows wrap, Home/End jump, other keys are ignored', () => {
  assert.equal(nextTabIndex(0, 'ArrowLeft', 3), 2)
  assert.equal(nextTabIndex(2, 'ArrowRight', 3), 0)
  assert.equal(nextTabIndex(1, 'Home', 3), 0)
  assert.equal(nextTabIndex(1, 'End', 3), 2)
  assert.equal(nextTabIndex(1, 'Enter', 3), null)
  assert.equal(nextTabIndex(0, 'ArrowRight', 0), null)
})

test('menu keyboard model: arrows wrap, other keys are ignored', () => {
  assert.equal(nextMenuIndex(0, 3, 'ArrowUp'), 2)
  assert.equal(nextMenuIndex(2, 3, 'ArrowDown'), 0)
  assert.equal(nextMenuIndex(0, 3, 'x'), null)
})

test('scrubber responds to arrow keys and stays within [0, total]', () => {
  const right = scrubberKeyTarget('ArrowRight', false, 5, 10)
  const left = scrubberKeyTarget('ArrowLeft', false, 5, 10)
  assert.ok(right !== null && right > 5)
  assert.ok(left !== null && left < 5)
  assert.equal(scrubberKeyTarget('Home', false, 5, 10), 0)
  assert.equal(scrubberKeyTarget('End', false, 5, 10), 10)
  assert.equal(scrubberKeyTarget('a', false, 5, 10), null)
  assert.equal(scrubberKeyTarget('ArrowLeft', true, 1, 10), 0)
})

test('sessions panel: arrows move between rows, one row is in the tab order, clicks select', () => {
  const selected: string[] = []
  const pickedAgents: string[] = []
  const sessions = ['a', 'b'].map((id, i) => ({
    id, label: `S${id}`, status: 'active' as const, startTime: i, lastActivityTime: 10 - i,
  }))
  const agents = new Map([
    ['a:main', { id: 'a:main', sessionId: 'a', parentKey: null, name: 'main', state: 'thinking', tokensUsed: 10, spawnTime: 1 }],
    ['a:sub', { id: 'a:sub', sessionId: 'a', parentKey: 'a:main', name: 'sub', state: 'idle', kind: 'subagent' as const, tokensUsed: 5, spawnTime: 2 }],
  ])
  const { container, getByRole } = render(
    <SessionListPanel
      visible onClose={() => {}} sessions={sessions} selectedSessionId="a" sessionsWithActivity={new Set()}
      onSelectSession={id => selected.push(id)} onCloseSession={() => {}}
      agents={agents} selectedAgentId={null} onSelectAgent={id => pickedAgents.push(id)} now={5000}
    />,
  )
  showAllSessions({ getByRole })
  const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-row-main]'))
  // All sessions, session a, main, sub, session b (agents sit under their session)
  assert.equal(rows.length, 5)
  assert.equal(rows.filter(r => r.tabIndex === 0).length, 1, 'roving tabindex over the session rows')
  assert.equal(rows[1].getAttribute('aria-current'), 'true')
  rows[1].focus()
  fireEvent.keyDown(rows[1], { key: 'ArrowDown' })
  assert.equal(document.activeElement, rows[2])
  fireEvent.keyDown(rows[2], { key: 'End' })
  assert.equal(document.activeElement, rows[4])
  fireEvent.keyDown(rows[4], { key: 'Home' })
  assert.equal(document.activeElement, rows[0])
  fireEvent.click(rows[4])
  fireEvent.click(rows[3])
  assert.deepEqual(selected, ['b'])
  assert.deepEqual(pickedAgents, ['a:sub'])
  // ArrowLeft folds the agents of the focused session
  fireEvent.keyDown(rows[1], { key: 'ArrowLeft' })
  // The folded agents stay mounted (for the animation) but are inert: only reachable rows remain
  assert.equal(Array.from(container.querySelectorAll('[data-row-main]')).filter(r => !r.closest('[inert]')).length, 3)
  getByRole('button', { name: 'Expand agents of Sa' })
})

test('sessions panel: the Active only button is aria-pressed="true" by default', () => {
  const { getByRole } = render(
    <SessionListPanel
      visible onClose={() => {}} sessions={[]} selectedSessionId={null} sessionsWithActivity={new Set()}
      onSelectSession={() => {}} onCloseSession={() => {}} agents={new Map()} selectedAgentId={null} onSelectAgent={() => {}} now={5000}
    />,
  )
  assert.equal(getByRole('button', { name: 'Active only' }).getAttribute('aria-pressed'), 'true')
})

test('sessions panel: the Active only toggle hides finished sessions and keeps the selected one', () => {
  const sessions = [
    { id: 'live', label: 'Live one', status: 'active' as const, startTime: 0, lastActivityTime: 5 },
    { id: 'old', label: 'Old one', status: 'completed' as const, startTime: 0, lastActivityTime: 1 },
    { id: 'sel', label: 'Selected old', status: 'completed' as const, startTime: 0, lastActivityTime: 2 },
  ]
  const { getByRole, queryByText } = render(
    <SessionListPanel
      visible onClose={() => {}} sessions={sessions} selectedSessionId="sel" sessionsWithActivity={new Set()}
      onSelectSession={() => {}} onCloseSession={() => {}} agents={new Map()} selectedAgentId={null} onSelectAgent={() => {}} now={5000}
      observedSessionIds={new Set(['live'])}
    />,
  )
  const toggle = getByRole('button', { name: 'Active only' })
  assert.equal(toggle.getAttribute('aria-pressed'), 'true', 'the Active only filter is on by default')
  assert.equal(queryByText('Old one'), null)
  assert.ok(queryByText('Live one'))
  assert.ok(queryByText('Selected old'), 'the selected session stays listed')
  fireEvent.click(toggle)
  assert.equal(toggle.getAttribute('aria-pressed'), 'false')
  assert.ok(queryByText('Old one'), 'turning the filter off lists finished sessions again')
  assert.ok(queryByText('Live one'))
  assert.ok(queryByText('Selected old'))
})

test('sessions panel: the Active only toggle also hides an active session nobody has heard from', () => {
  const sessions = [
    { id: 'live', label: 'Live one', status: 'active' as const, startTime: 0, lastActivityTime: 5 },
    { id: 'ghost', label: 'Ghost one', status: 'active' as const, startTime: 0, lastActivityTime: 4 },
  ]
  const { getByRole, queryByText } = render(
    <SessionListPanel
      visible onClose={() => {}} sessions={sessions} selectedSessionId="live" sessionsWithActivity={new Set()}
      onSelectSession={() => {}} onCloseSession={() => {}} agents={new Map()} selectedAgentId={null} onSelectAgent={() => {}} now={5000}
      observedSessionIds={new Set(['live'])}
    />,
  )
  assert.equal(getByRole('button', { name: 'Active only' }).getAttribute('aria-pressed'), 'true')
  assert.ok(queryByText('Live one'))
  assert.equal(queryByText('Ghost one'), null, 'an unobserved session is not counted as active')
  fireEvent.click(getByRole('button', { name: 'Active only' }))
  assert.ok(queryByText('Ghost one'), 'listed once the filter is off')
  assert.ok(queryByText('Live one'))
})

test('sessions panel: a session row shows its name, model and time, not its workspace nor a CC badge', () => {
  const sessions = [{ id: 's1', label: 'Refactor payments', status: 'active' as const, startTime: 0, lastActivityTime: 0, workspace: 'shop', runtime: 'claude' as const }]
  const { getByText, getAllByText, queryByText } = render(
    <SessionListPanel
      visible onClose={() => {}} sessions={sessions} selectedSessionId="s1" sessionsWithActivity={new Set()}
      sessionModels={new Map([['s1', 'claude-opus-4-6-20250514']])}
      onSelectSession={() => {}} onCloseSession={() => {}} agents={new Map()} selectedAgentId={null} onSelectAgent={() => {}} now={180_000}
    />,
  )
  getByText('Refactor payments')
  getByText('Opus 4.6')
  assert.ok(getAllByText('3 min ago').length >= 1, 'stacked line and Activity column')
  assert.equal(queryByText('shop'), null)
  assert.equal(queryByText('CC'), null)
})

test('known-violation helpers: new violations and stale entries are both reported', () => {
  const known = [{ scenario: 's', rule: 'old-rule', issue: 1 }, { scenario: 's', rule: 'kept', issue: 2 }]
  assert.deepEqual(compareViolations('s', ['kept', 'brand-new'], known), { unexpected: ['brand-new'], stale: ['old-rule'] })
  assert.deepEqual(compareViolations('other', [], known), { unexpected: [], stale: [] })
  assert.equal(validateKnownViolations([{ scenario: 's', rule: 'r', issue: 0 }]).length, 1)
  assert.equal(validateKnownViolations([{ scenario: 's', rule: 'r', issue: 3 }, { scenario: 's', rule: 'r', issue: 3 }]).length, 1)
})
