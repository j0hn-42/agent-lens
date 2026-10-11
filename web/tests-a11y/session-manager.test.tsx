// Session manager (#246): sort by activity, folder prefix on tabs, keyboard rename, cleanup, axe.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import axe from 'axe-core'

import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import type { SessionInfo } from '@/lib/bridge-types'
import type { TeamSummary } from '@/lib/agent-types'
import { showAllSessions } from './sessions-filter-helpers'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const noop = () => {}
const NOW = 100_000
const mk = (id: string, label: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, label, status: 'active', startTime: 0, lastActivityTime: 10, runtime: 'claude', ...extra })

const sessions: SessionInfo[] = [
  mk('old', 'older work', { lastActivityTime: 1_000, projectId: 'pa', projectName: 'alpha' }),
  mk('new', 'newest work', { lastActivityTime: 90_000, projectId: 'pa', projectName: 'alpha' }),
  mk('mid', 'middle work', { lastActivityTime: 50_000, projectId: 'pb', projectName: 'beta' }),
  mk('done', 'finished work', { status: 'completed', lastActivityTime: 95_000, projectId: 'pb', projectName: 'beta' }),
]

function panel(extra: Partial<React.ComponentProps<typeof SessionListPanel>> = {}) {
  const list = extra.sessions ?? sessions
  return (
    <SessionListPanel
      visible onClose={noop} sessions={list} selectedSessionId="__all__" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={new Map()} selectedAgentId={null} onSelectAgent={noop}
      now={NOW} observedSessionIds={new Set(list.map(s => s.id))} {...extra}
    />
  )
}
const order = (c: HTMLElement) => [...c.querySelectorAll('[data-closable-id]')].map(el => el.getAttribute('data-closable-id'))
const nameOf = (c: HTMLElement, id: string) => c.querySelector(`[data-closable-id="${id}"] .truncate`)?.textContent
const row = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-row-key="session:${id}"]`)!

const crew = new Map<string, TeamSummary>([['crew', { name: 'crew', leadSessionId: 'new', members: [] } as unknown as TeamSummary]])
const crewSessions = [
  mk('new', 'newest work', { lastActivityTime: 90_000, projectId: 'pa', projectName: 'alpha', teamName: 'crew' }),
  mk('mid', 'middle work', { lastActivityTime: 50_000, projectId: 'pb', projectName: 'beta', teamName: 'crew' }),
]
const crewPanel = (extra: Partial<React.ComponentProps<typeof SessionListPanel>> = {}) =>
  panel({ sessions: crewSessions, teams: crew, teamMemberCounts: new Map([['crew', 2]]), ...extra })

test('sort: sessions are listed most recent activity first, active before finished, grouped by project', () => {
  const view = render(panel())
  showAllSessions(view)
  assert.deepEqual(order(view.container), ['new', 'old', 'mid', 'done'])
})

test('folder prefix: a session listed under a team (no project heading) names its folder when several are open', () => {
  const { container } = render(crewPanel())
  assert.equal(nameOf(container, 'new'), 'alpha / newest work')
  assert.equal(nameOf(container, 'mid'), 'beta / middle work')
})

test('folder prefix: not repeated under a project heading, nor with a single folder', () => {
  const grouped = render(panel())
  assert.equal(nameOf(grouped.container, 'new'), 'newest work', 'the heading already names the folder')
  cleanup()
  const single = render(panel({ sessions: [sessions[0], sessions[1]] }))
  assert.equal(nameOf(single.container, 'new'), 'newest work')
})

const handler = (calls: Array<[string, string]>) => (id: string, name: string) => { calls.push([id, name]) }

test('rename by keyboard: F2 opens a named field, Enter saves, focus returns to the row', async () => {
  const calls: Array<[string, string]> = []
  const { container, getByRole } = render(panel({ onRenameSession: handler(calls) }))
  row(container, 'new').focus()
  fireEvent.keyDown(row(container, 'new'), { key: 'F2' })
  const input = getByRole('textbox', { name: 'New name for session newest work' }) as HTMLInputElement
  assert.equal(document.activeElement, input)
  fireEvent.change(input, { target: { value: 'my label' } })
  fireEvent.submit(input.closest('form')!)
  assert.deepEqual(calls, [['new', 'my label']])
  assert.equal(container.querySelector('input[type="text"]'), null, 'the field is gone')
  await new Promise(r => setTimeout(r, 40))
  assert.equal(document.activeElement, row(container, 'new'))
  assert.match(container.querySelector('[data-panel-announcer]')!.textContent ?? '', /Session renamed to my label/)
})

test('rename by keyboard: Escape cancels without saving; an empty name restores the original', () => {
  const calls: Array<[string, string]> = []
  const { container, getByRole } = render(panel({ onRenameSession: handler(calls) }))
  fireEvent.keyDown(row(container, 'old'), { key: 'F2' })
  fireEvent.keyDown(getByRole('textbox', { name: /New name for session/ }), { key: 'Escape' })
  assert.deepEqual(calls, [])
  assert.equal(container.querySelector('input[type="text"]'), null)
  fireEvent.keyDown(row(container, 'old'), { key: 'F2' })
  const input = getByRole('textbox', { name: /New name for session/ })
  fireEvent.change(input, { target: { value: '   ' } })
  fireEvent.submit(input.closest('form')!)
  assert.deepEqual(calls, [['old', '   ']], 'the model turns an empty name into "restore"')
  assert.match(container.querySelector('[data-panel-announcer]')!.textContent ?? '', /Original name restored/)
})

test('rename: the pencil button has an accessible name and no pencil exists without a rename handler', () => {
  const { getByRole, queryByRole, rerender } = render(panel({ onRenameSession: noop }))
  assert.ok(getByRole('button', { name: 'Rename session newest work' }))
  rerender(panel())
  assert.equal(queryByRole('button', { name: /^Rename session/ }), null)
})

test('rename: the field disappears when its session vanishes while editing, and is not resurrected', () => {
  const calls: Array<[string, string]> = []
  const onRenameSession = handler(calls)
  const { container, getByRole, rerender } = render(panel({ onRenameSession }))
  fireEvent.keyDown(row(container, 'new'), { key: 'F2' })
  assert.ok(getByRole('textbox', { name: /New name for session/ }))
  rerender(panel({ sessions: sessions.filter(s => s.id !== 'new'), onRenameSession }))
  assert.equal(container.querySelector('input[type="text"]'), null)
  rerender(panel({ onRenameSession }))
  assert.equal(container.querySelector('input[type="text"]'), null, 'the edit is not resurrected')
  assert.deepEqual(calls, [])
})

test('axe: prefixed team rows with a rename field open have no violation', async () => {
  const { container } = render(crewPanel({ onRenameSession: noop }))
  fireEvent.keyDown(row(container, 'mid'), { key: 'F2' })
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  assert.deepEqual(results.violations.map(v => v.id), [])
})
