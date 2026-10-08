// #36 D8 consumers in the shell: a second same-named team lives under the key `name@leadSession`; the
// Sessions panel must show the display name (never the key), give each same-named team its own sessions,
// hide lead-only teams, and feed-utils must resolve the team of the agent's session.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'

import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import { teamColorOf } from '@/lib/feed-utils'
import type { TeamSummary } from '@/lib/agent-types'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const teams = new Map<string, TeamSummary>([
  ['alpha', { name: 'alpha', leadSessionId: 'L1', members: [{ name: 'dev', sessionId: 'L1', color: '#ff0000' }] }],
  ['alpha@L3', { name: 'alpha', leadSessionId: 'L3', members: [{ name: 'dev', sessionId: 'L3', color: '#00ff00' }] }],
])

const session = (id: string, label: string, teamName?: string) =>
  ({ id, label, status: 'active' as const, startTime: 0, lastActivityTime: 10, ...(teamName ? { teamName } : {}) })

function panel(sessions: ReturnType<typeof session>[], t: Map<string, TeamSummary>, counts: Map<string, number>, working: Map<string, number>) {
  const r = render(
    <SessionListPanel
      visible onClose={() => {}} sessions={sessions as never} selectedSessionId={null}
      sessionsWithActivity={new Set()} onSelectSession={() => {}} onCloseSession={() => {}}
      agents={new Map()} selectedAgentId={null} onSelectAgent={() => {}}
      teams={t} teamMemberCounts={counts} teamWorking={working} now={5000}
    />,
  )
  return Array.from(r.container.querySelectorAll<HTMLElement>('[data-row-main]')).map(el => el.textContent ?? '')
}

test('team rows show the display name, not the map key of a second same-named team', () => {
  const rows = panel([], teams, new Map([['alpha', 1], ['alpha@L3', 2]]), new Map([['alpha', 0], ['alpha@L3', 1]]))
  for (const t of rows) assert.ok(!t.includes('@L3'), `row shows the raw key: ${t}`)
  assert.ok(rows.some(t => t.includes('Team alpha: 2 members, 1 working')), JSON.stringify(rows))
  assert.ok(rows.some(t => t.includes('Team alpha: 1 member, 0 working')), JSON.stringify(rows))
})

test('teamColorOf resolves the team the agent session takes part in', () => {
  const agent = { name: 'dev', sessionId: 'L3', teamName: 'alpha' }
  assert.equal(teamColorOf(agent, teams), '#00ff00')
  assert.equal(teamColorOf({ ...agent, sessionId: 'L1' }, teams), '#ff0000')
})

test('each same-named team lists its own lead session right after its team row', () => {
  const rows = panel(
    [session('L1', 'first lead', 'alpha'), session('L3', 'third lead', 'alpha')],
    teams, new Map([['alpha', 1], ['alpha@L3', 1]]), new Map([['alpha', 0], ['alpha@L3', 0]]),
  )
  const idx = (needle: string) => rows.findIndex(t => t.includes(needle))
  const teamRows = rows.map((t, i) => (t.startsWith('Team alpha') ? i : -1)).filter(i => i >= 0)
  assert.equal(teamRows.length, 2, JSON.stringify(rows))
  assert.equal(idx('first lead'), teamRows[0] + 1, 'L1 sits under the first team')
  assert.equal(idx('third lead'), teamRows[1] + 1, 'L3 sits under the second team')
})

test('a lead-only team (no teammates) gets no team row and its session is listed as a plain session', () => {
  const solo = new Map<string, TeamSummary>([
    ['session-ab12', { name: 'session-ab12', leadSessionId: 'S1', members: [] }],
  ])
  const rows = panel([session('S1', 'solo work', 'session-ab12')], solo, new Map([['session-ab12', 0]]), new Map([['session-ab12', 0]]))
  assert.equal(rows.length, 2, JSON.stringify(rows))
  assert.ok(rows[1].includes('solo work'))
  assert.ok(!rows.some(t => t.includes('0 members') || t.startsWith('Team ')), JSON.stringify(rows))
})
