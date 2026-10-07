// Keyboard scenarios (issue #43): pure-function level plus real DOM targets from jsdom.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { shouldHandleShortcut } from '@/hooks/use-keyboard-shortcuts'
import { nextTabIndex, scrubberKeyTarget } from '@/lib/chrome-utils'
import { nextMenuIndex } from '@/lib/menu-nav'
import { SessionTabs } from '@/components/agent-visualizer/session-tabs'
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

test('session tabs: ArrowRight selects the next tab and only one tab is in the tab order', () => {
  const selected: string[] = []
  const sessions = ['a', 'b', 'c'].map((id, i) => ({
    id, label: `S${id}`, status: 'active' as const, startTime: i, lastActivityTime: i,
  }))
  const { getAllByRole } = render(
    <SessionTabs
      sessions={sessions} selectedSessionId="a" sessionsWithActivity={new Set()}
      onSelectSession={id => selected.push(id)} onCloseSession={() => {}}
    />,
  )
  const tabs = getAllByRole('tab')
  assert.equal(tabs.filter(t => t.tabIndex === 0).length, 1, 'roving tabindex')
  fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })
  fireEvent.keyDown(tabs[0], { key: 'End' })
  assert.deepEqual(selected, ['b', 'c'])
})

test('known-violation helpers: new violations and stale entries are both reported', () => {
  const known = [{ scenario: 's', rule: 'old-rule', issue: 1 }, { scenario: 's', rule: 'kept', issue: 2 }]
  assert.deepEqual(compareViolations('s', ['kept', 'brand-new'], known), { unexpected: ['brand-new'], stale: ['old-rule'] })
  assert.deepEqual(compareViolations('other', [], known), { unexpected: [], stale: [] })
  assert.equal(validateKnownViolations([{ scenario: 's', rule: 'r', issue: 0 }]).length, 1)
  assert.equal(validateKnownViolations([{ scenario: 's', rule: 'r', issue: 3 }, { scenario: 's', rule: 'r', issue: 3 }]).length, 1)
})
