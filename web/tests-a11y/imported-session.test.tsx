// Imported transcripts in the Sessions panel (#294, track 1): the provenance is visible and spoken on the row,
// imported sessions get their own group and project filter entry, and the panel stays keyboard- and axe-clean.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import axe from 'axe-core'
import { showAllSessions } from './sessions-filter-helpers'

import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import type { FreshnessClock } from '@/hooks/use-freshness-clock'
import { sanitizeSessionInfo, IMPORTED_PROJECT_ID, IMPORTED_PROJECT_NAME, type SessionInfo } from '@/lib/bridge-types'
import { SESSION_IMPORTED_TEXT, SESSION_IMPORTED_HELP } from '@/lib/session-model'

const T0 = 1_000_000_000_000
const noop = () => {}

beforeEach(() => { mock.timers.enable({ apis: ['setInterval'] }) })
afterEach(() => { cleanup(); mock.timers.reset() })

const raw: SessionInfo[] = [
  { id: 'local', label: 'payments-api', status: 'active', startTime: T0 - 60_000, lastActivityTime: T0 - 1000, projectId: 'p1', projectName: 'payments' },
  { id: 'cloud', label: 'Fix the cloud bug', status: 'completed', startTime: T0 - 900_000, lastActivityTime: T0 - 600_000, imported: true, importedAt: T0 - 5000, cwd: '/home/user/cloud-repo' },
]
const sessions = raw.map(sanitizeSessionInfo)

function clock(): FreshnessClock {
  return { getNow: () => T0, subscribe: () => () => {} }
}

function panel(selected = 'local') {
  return (
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId={selected} sessionsWithActivity={new Set(['cloud'])}
      onSelectSession={noop} onCloseSession={noop} agents={new Map() as never}
      selectedAgentId={null} onSelectAgent={noop} now={T0} freshnessClock={clock()}
    />
  )
}

test('an imported session row shows and speaks its provenance, never an active state', () => {
  const view = render(panel())
  showAllSessions(view)
  const row = view.container.querySelector<HTMLElement>('[data-row-key="session:cloud"]')
  assert.ok(row, 'the imported session is listed')
  assert.ok(row.textContent!.includes(SESSION_IMPORTED_TEXT), 'the provenance is written on the row and in its accessible name')
  assert.ok(row.textContent!.includes(SESSION_IMPORTED_HELP), 'screen readers hear why')
  assert.ok(!/\bactive\b/.test(row.textContent!.replace(SESSION_IMPORTED_HELP, '')), 'never announced as active')
  assert.ok(row.querySelector(`[title="${SESSION_IMPORTED_HELP}"]`), 'the visible text has a tooltip')
})

test('imported sessions are grouped under their own heading and can be filtered on', () => {
  const view = render(panel())
  showAllSessions(view)
  const headings = [...view.container.querySelectorAll('li')].map(li => li.textContent).filter(t => t?.startsWith('Project '))
  assert.ok(headings.includes(`Project ${IMPORTED_PROJECT_NAME}`), `headings: ${headings.join(', ')}`)
  const select = view.getByRole('combobox', { name: 'Filter by project' }) as HTMLSelectElement
  assert.ok([...select.options].some(o => o.value === IMPORTED_PROJECT_ID && o.textContent === IMPORTED_PROJECT_NAME))
  fireEvent.change(select, { target: { value: IMPORTED_PROJECT_ID } })
  assert.ok(view.container.querySelector('[data-row-key="session:cloud"]'))
  assert.equal(view.container.querySelector('[data-row-key="session:local"]'), null)
})

test('axe: a list with an imported session has no violation', async () => {
  const view = render(panel('cloud'))
  const results = await axe.run(view.container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  assert.deepEqual(results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`), [])
})
