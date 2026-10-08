// Session list: filter by the branch recorded by the sessions (#125). A session without a recorded
// branch is never guessed one; with no branch at all, no branch control is offered.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import axe from 'axe-core'

import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import type { SessionInfo } from '@/lib/bridge-types'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const noop = () => {}
const base: SessionInfo[] = [
  { id: 'a', label: 'fix login', status: 'active', startTime: 0, lastActivityTime: 30, runtime: 'claude' },
  { id: 'b', label: 'refactor api', status: 'active', startTime: 0, lastActivityTime: 20, runtime: 'claude' },
  { id: 'c', label: 'docs', status: 'active', startTime: 0, lastActivityTime: 10, runtime: 'claude' }, // no recorded branch
]
const withBranches: SessionInfo[] = [{ ...base[0], branch: 'feat/login' }, { ...base[1], branch: 'main' }, base[2]]

function panel(sessions: SessionInfo[], extra: Partial<React.ComponentProps<typeof SessionListPanel>> = {}) {
  return (
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="__all__" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={new Map()}
      selectedAgentId={null} onSelectAgent={noop} now={5000} observedSessionIds={new Set(['a', 'b', 'c'])} {...extra}
    />
  )
}
const ids = (c: HTMLElement) => [...c.querySelectorAll('[data-closable-id]')].map(el => el.getAttribute('data-closable-id'))

test('no branch control when no session records a branch (nothing guessed)', () => {
  const { queryByRole } = render(panel(base))
  assert.equal(queryByRole('combobox', { name: /Filter by branch/ }), null)
})

test('the select lists the recorded branches only, narrows the list, and Clear filter resets it', () => {
  const { container, getByRole } = render(panel(withBranches))
  const select = getByRole('combobox', { name: /Filter by branch/ }) as HTMLSelectElement
  assert.deepEqual([...select.options].map(o => o.value), ['', 'feat/login', 'main'])
  fireEvent.change(select, { target: { value: 'main' } })
  assert.deepEqual(ids(container), ['b'], 'the session without a branch is not matched')
  fireEvent.click(getByRole('button', { name: 'Clear filter' }))
  assert.deepEqual(ids(container), ['a', 'b', 'c'])
})

test('the search also finds a session by its branch, and the parent gets the choice', () => {
  const changes: unknown[] = []
  const { container, getByRole } = render(panel(withBranches, { onFilterChange: c => changes.push(c) }))
  fireEvent.change(getByRole('searchbox', { name: 'Search sessions' }), { target: { value: 'feat/log' } })
  assert.deepEqual(ids(container), ['a'])
  fireEvent.change(getByRole('searchbox', { name: 'Search sessions' }), { target: { value: '' } })
  fireEvent.change(getByRole('combobox', { name: /Filter by branch/ }), { target: { value: 'feat/login' } })
  assert.deepEqual(changes, [{ branch: 'feat/login' }])
})

test('a stored branch that no session has any more does not empty the list', () => {
  const { container } = render(panel(withBranches, { filterBranch: 'deleted-branch' }))
  assert.deepEqual(ids(container), ['a', 'b', 'c'])
})

test('axe: the filtered session list with the branch select has no violation', async () => {
  const { container, getByRole } = render(panel(withBranches))
  fireEvent.change(getByRole('combobox', { name: /Filter by branch/ }), { target: { value: 'main' } })
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  assert.deepEqual(results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`), [])
})
