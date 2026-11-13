// Burrow agent list: one Tab stop (roving tabindex), arrow keys move the focus, Enter selects, sessions are grouped.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { BurrowAgentList } from '@/components/agent-visualizer/burrow-agent-list'
import type { BurrowRow } from '@/lib/burrow/burrow-sync'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const row = (id: string, name: string, sessionId?: string): BurrowRow =>
  ({ id, name, presence: 'in', room: 'lounge', state: 'idle', stale: false, parentId: null, depth: 0, sessionId: sessionId ?? 's1' })

function setup(rows: BurrowRow[], onClick: (id: string) => void = () => {}) {
  return render(
    <BurrowAgentList label="Burrow agents" rows={rows} selectedAgentId={null} rowLabel={(r) => r.name}
      groupLabel={(s) => `Session ${s}`} onAgentClick={onClick} onAgentHover={() => {}} />,
  )
}

const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-burrow-agent-list] button'))

test('the list is a single Tab stop: one button is tabbable, the others have tabindex -1', () => {
  setup([row('a', 'alpha'), row('b', 'beta'), row('c', 'gamma')])
  assert.deepEqual(buttons().map((b) => b.tabIndex), [0, -1, -1])
})

test('ArrowDown, ArrowUp, Home and End move the focus between rows and the tab stop follows', () => {
  setup([row('a', 'alpha'), row('b', 'beta'), row('c', 'gamma')])
  buttons()[0].focus()
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  assert.equal(document.activeElement?.textContent, 'beta')
  assert.deepEqual(buttons().map((b) => b.tabIndex), [-1, 0, -1])
  fireEvent.keyDown(document.activeElement!, { key: 'End' })
  assert.equal(document.activeElement?.textContent, 'gamma')
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  assert.equal(document.activeElement?.textContent, 'gamma', 'no wrap past the last row')
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
  assert.equal(document.activeElement?.textContent, 'beta')
  fireEvent.keyDown(document.activeElement!, { key: 'Home' })
  assert.equal(document.activeElement?.textContent, 'alpha')
})

test('Enter on the focused row selects it (a button: Enter and Space fire its click)', () => {
  const picked: string[] = []
  setup([row('a', 'alpha'), row('b', 'beta')], (id) => picked.push(id))
  buttons()[0].focus()
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  fireEvent.click(document.activeElement!)
  assert.deepEqual(picked, ['b'])
})

test('a long name is truncated on screen, the title carries it in full', () => {
  const long = 'x'.repeat(120)
  setup([row('a', long)])
  const b = buttons()[0]
  assert.equal(b.title, long)
  assert.ok(b.className.includes('truncate'))
})

test('rows of several sessions are grouped under a session heading; one session has none', () => {
  setup([row('a', 'alpha', 's1'), row('b', 'beta', 's1'), row('c', 'gamma', 's2')])
  const heads = Array.from(document.querySelectorAll('[data-burrow-session]')).map((h) => h.textContent)
  assert.deepEqual(heads, ['Session s1', 'Session s2'])
  assert.equal(buttons().length, 3)
  cleanup()
  setup([row('a', 'alpha', 's1'), row('b', 'beta', 's1')])
  assert.equal(document.querySelectorAll('[data-burrow-session]').length, 0)
})
