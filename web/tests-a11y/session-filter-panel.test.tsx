// Session list: search, project / runtime filter (#125) and per-session attention marker (#126).
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, within } from '@testing-library/react'

import { SessionListPanel, type SessionListAgent } from '@/components/agent-visualizer/session-list-panel'
import type { SessionInfo } from '@/lib/bridge-types'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const noop = () => {}
const NOW = 5000
const sessions: SessionInfo[] = [
  { id: 'a', label: 'fix login', status: 'active', startTime: 0, lastActivityTime: 30, runtime: 'claude', projectId: 'pa', projectName: 'alpha' },
  { id: 'b', label: 'refactor api', status: 'active', startTime: 0, lastActivityTime: 20, runtime: 'codex', projectId: 'pb', projectName: 'beta' },
  { id: 'c', label: 'docs', status: 'active', startTime: 0, lastActivityTime: 10, runtime: 'claude', projectId: 'pb', projectName: 'beta' },
]
const agent = (id: string, sessionId: string, state: string, name = id): SessionListAgent =>
  ({ id, sessionId, parentKey: null, name, state, tokensUsed: 1, spawnTime: 1, lastEventAt: Date.now() }) as SessionListAgent

function panel(extra: Partial<React.ComponentProps<typeof SessionListPanel>> = {}, agents: SessionListAgent[] = []) {
  return (
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="__all__" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={new Map(agents.map(a => [a.id, a]))}
      selectedAgentId={null} onSelectAgent={noop} now={NOW} observedSessionIds={new Set(['a', 'b', 'c'])} {...extra}
    />
  )
}
const sessionLabels = (c: HTMLElement) => [...c.querySelectorAll('[data-closable-id]')].map(el => el.getAttribute('data-closable-id'))

test('search: a labelled field narrows the list and an unmatched text shows the empty match', () => {
  const { container, getByRole, getAllByText } = render(panel())
  assert.deepEqual(sessionLabels(container), ['a', 'b', 'c'])
  const input = getByRole('searchbox', { name: 'Search sessions' })
  fireEvent.change(input, { target: { value: 'API' } })
  assert.deepEqual(sessionLabels(container), ['b'])
  fireEvent.change(input, { target: { value: 'nothing here' } })
  assert.deepEqual(sessionLabels(container), [])
  assert.equal(getAllByText('No matching sessions').length, 2, 'visible empty state and live announcement')
  assert.match(container.querySelector('[data-panel-announcer]')!.textContent ?? '', /No matching sessions/)
})

test('search: also finds a session by the name of one of its agents', () => {
  const { container, getByRole } = render(panel({}, [agent('c:m', 'c', 'thinking', 'Reviewer')]))
  fireEvent.change(getByRole('searchbox', { name: 'Search sessions' }), { target: { value: 'review' } })
  assert.deepEqual(sessionLabels(container), ['c'])
})

test('filter: project and runtime selects combine, and the clear button resets everything', () => {
  const { container, getByRole, queryByRole } = render(panel())
  fireEvent.change(getByRole('combobox', { name: 'Filter by project' }), { target: { value: 'pb' } })
  assert.deepEqual(sessionLabels(container), ['b', 'c'])
  fireEvent.change(getByRole('combobox', { name: 'Filter by runtime' }), { target: { value: 'claude' } })
  assert.deepEqual(sessionLabels(container), ['c'])
  assert.match(container.textContent ?? '', /canvas still shows every session/, 'the canvas is said to be unfiltered')
  fireEvent.click(getByRole('button', { name: 'Clear filter' }))
  assert.deepEqual(sessionLabels(container), ['a', 'b', 'c'])
  assert.equal(queryByRole('button', { name: 'Clear filter' }), null)
})

test('filter: the parent keeps the project / runtime and gets the changes', () => {
  const changes: unknown[] = []
  const { container, getByRole, rerender } = render(panel({ filterProject: 'pa', filterRuntime: null, onFilterChange: c => changes.push(c) }))
  assert.deepEqual(sessionLabels(container), ['a'], 'a stored filter applies at once')
  fireEvent.change(getByRole('combobox', { name: 'Filter by runtime' }), { target: { value: 'codex' } })
  assert.deepEqual(changes, [{ runtime: 'codex' }])
  rerender(panel({ filterProject: 'gone', filterRuntime: null }))
  assert.deepEqual(sessionLabels(container), ['a', 'b', 'c'], 'a stored project nobody has any more does not empty the list')
})

test('attention: a session row says in words how many agents wait or failed, even when folded', () => {
  const { container } = render(panel({}, [
    agent('a:m', 'a', 'waiting_permission'), agent('a:n', 'a', 'error'), agent('b:m', 'b', 'thinking'),
  ]))
  const rowA = container.querySelector('[data-closable-id="a"]') as HTMLElement
  assert.match(within(rowA).getByTestId('session-attention').textContent ?? '', /1 waiting \/ 1 error/)
  assert.equal(within(container.querySelector('[data-closable-id="b"]') as HTMLElement).queryByTestId('session-attention'), null)
})

test('attention: a stale waiting agent is not reported as blocked', () => {
  const stale = { ...agent('a:m', 'a', 'waiting_permission'), lastEventAt: Date.now() - 60 * 60 * 1000 }
  const { container } = render(panel({}, [stale]))
  assert.equal(container.querySelector('[data-testid="session-attention"]'), null)
})
