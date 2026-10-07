// #36 D8 consumers in the shell: a second same-named team lives under the key `name@leadSession`; the
// tabs must show the display name, never the key, and feed-utils must resolve the team of the agent's session.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'

import { SessionTabs } from '@/components/agent-visualizer/session-tabs'
import { teamColorOf } from '@/lib/feed-utils'
import { teamSelectionId } from '@/lib/bridge-types'
import type { TeamSummary } from '@/lib/agent-types'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const teams = new Map<string, TeamSummary>([
  ['alpha', { name: 'alpha', leadSessionId: 'L1', members: [{ name: 'dev', sessionId: 'L1', color: '#ff0000' }] }],
  ['alpha@L3', { name: 'alpha', leadSessionId: 'L3', members: [{ name: 'dev', sessionId: 'L3', color: '#00ff00' }] }],
])

test('team tabs show the display name, not the map key of a second same-named team', () => {
  const r = render(
    <SessionTabs
      sessions={[]} selectedSessionId={null} sessionsWithActivity={new Set()}
      onSelectSession={() => {}} onCloseSession={() => {}}
      teams={teams}
      teamMemberCounts={new Map([['alpha', 1], ['alpha@L3', 2]])}
      teamWorking={new Map([['alpha', 0], ['alpha@L3', 1]])}
    />,
  )
  const tabs = r.getAllByRole('tab')
  assert.equal(tabs.length, 3)
  for (const t of tabs) assert.ok(!t.textContent?.includes('@L3'), `tab shows the raw key: ${t.textContent}`)
  // the second team's tab still reads its own counts (looked up by key) and selects by key
  const second = tabs[2]
  assert.ok(second.textContent?.includes('Team alpha: 2 members, 1 working'), second.textContent ?? '')
  assert.equal(second.id, `session-tab-${teamSelectionId('alpha@L3')}`)
})

test('teamColorOf resolves the team the agent session takes part in', () => {
  const agent = { name: 'dev', sessionId: 'L3', teamName: 'alpha' }
  assert.equal(teamColorOf(agent, teams), '#00ff00')
  assert.equal(teamColorOf({ ...agent, sessionId: 'L1' }, teams), '#ff0000')
})

test('a session tab under a second same-named team announces the display name and sits under its own team tab', () => {
  const r = render(
    <SessionTabs
      sessions={[
        { id: 'L1', label: 'first lead', status: 'active', spawnTime: 0, teamName: 'alpha' },
        { id: 'L3', label: 'third lead', status: 'active', spawnTime: 0, teamName: 'alpha' },
      ] as never}
      selectedSessionId={null} sessionsWithActivity={new Set()}
      onSelectSession={() => {}} onCloseSession={() => {}}
      teams={teams}
      teamMemberCounts={new Map([['alpha', 1], ['alpha@L3', 1]])}
      teamWorking={new Map([['alpha', 0], ['alpha@L3', 0]])}
    />,
  )
  const ids = r.getAllByRole('tab').map(t => t.id)
  // All, team alpha, its lead L1, team alpha@L3, its lead L3
  assert.deepEqual(ids, [
    'session-tab-__all__',
    `session-tab-${teamSelectionId('alpha')}`, 'session-tab-L1',
    `session-tab-${teamSelectionId('alpha@L3')}`, 'session-tab-L3',
  ])
  const l3 = r.getAllByRole('tab').find(t => t.id === 'session-tab-L3')!
  const sr = Array.from(l3.querySelectorAll('.sr-only')).map(e => e.textContent ?? '').join('')
  assert.ok(sr.includes('team alpha,'), sr)
  assert.ok(!sr.includes('@L3'), `the sr-only text leaks the raw key: ${sr}`)
})

test('a lead-only team (no teammates) gets no team tab and its session is listed as a plain session', () => {
  const solo = new Map<string, TeamSummary>([
    ['session-ab12', { name: 'session-ab12', leadSessionId: 'S1', members: [] }],
  ])
  const r = render(
    <SessionTabs
      sessions={[{ id: 'S1', label: 'solo work', status: 'active', spawnTime: 0, teamName: 'session-ab12' }] as never}
      selectedSessionId={null} sessionsWithActivity={new Set()}
      onSelectSession={() => {}} onCloseSession={() => {}}
      teams={solo} teamMemberCounts={new Map([['session-ab12', 0]])} teamWorking={new Map([['session-ab12', 0]])}
    />,
  )
  assert.deepEqual(r.getAllByRole('tab').map(t => t.id), ['session-tab-__all__', 'session-tab-S1'])
  assert.ok(!(r.container.textContent ?? '').includes('0 members'))
})
