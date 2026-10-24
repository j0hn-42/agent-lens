// #366: the tokens and costs of the Sessions panel (agent row, branch, session and family totals) are lower bounds when the
// relay could not replay events of a session they count; nothing changes when no loss is known.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { render, cleanup } from '@testing-library/react'

import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import type { FreshnessClock } from '@/hooks/use-freshness-clock'
import { ROLLUP_INCOMPLETE_TEXT } from '@/lib/cost-rollup'
import type { SessionInfo } from '@/lib/bridge-types'

const T0 = 1_000_000_000_000
const noop = () => {}

beforeEach(() => { mock.timers.enable({ apis: ['setInterval'] }) })
afterEach(() => { cleanup(); mock.timers.reset() })

const clock: FreshnessClock = { getNow: () => T0, subscribe: () => () => {} }

const sessions: SessionInfo[] = [
  { id: 's1', label: 'First', status: 'active', startTime: 0, lastActivityTime: 3, teamName: 'T' },
  { id: 's2', label: 'Second', status: 'active', startTime: 0, lastActivityTime: 2, teamName: 'T' },
]
const mk = (id: string, sessionId: string, parentKey: string | null, tokensUsed: number, spawnTime = 1) =>
  [id, { id, sessionId, parentKey, name: id.split(':')[1], state: 'idle', tokensUsed, tokenStatus: 'available' as const, spawnTime, lastEventAt: T0 }] as const
const agents = new Map([mk('s1:main', 's1', null, 1_000_000), mk('s1:sub', 's1', 's1:main', 500_000, 2), mk('s2:main', 's2', null, 250_000)])

function panel(replayLost?: ReadonlyMap<string, number>) {
  return render(
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="s1" sessionsWithActivity={new Set(['s1', 's2'])}
      onSelectSession={noop} onCloseSession={noop} agents={agents as never} selectedAgentId={null} onSelectAgent={noop}
      teams={new Map([['T', { members: [{ name: 'main' }] } as never]])} now={10_000} freshnessClock={clock}
      replayLost={replayLost}
    />,
  )
}

/** Text of the agent rows of one session (its token and cost cells included), in order */
const cellLabels = (container: HTMLElement, sessionId: string) =>
  [...container.querySelectorAll(`[data-row-key^="agent:${sessionId}:"]`)].map(row => row.textContent ?? '')

test('no loss: every total reads as before, no "(incomplete)" and no "≥"', () => {
  const { container } = panel()
  const text = container.textContent!
  assert.equal(text.includes(ROLLUP_INCOMPLETE_TEXT), false)
  assert.equal(text.includes('≥'), false)
  const other = panel(new Map([['elsewhere', 4]])).container.textContent!
  assert.equal(other.includes(ROLLUP_INCOMPLETE_TEXT), false, 'a loss of a session the panel does not count changes nothing')
})

// Tokens are context readings (absolute): under a loss they are marked "?" and "(incomplete)", never "≥"; the costs keep
// the lower-bound mark of every other cost surface
test('a loss on s1: its agents, branch, session and family totals are incomplete, with the reason spelled out', () => {
  const { container } = panel(new Map([['s1', 4]]))
  const text = container.textContent!
  assert.ok(text.includes(ROLLUP_INCOMPLETE_TEXT), text)
  assert.match(text, /could not replay events of a session this total counts/)
  assert.match(text, /may differ/)
  assert.ok(container.querySelector('[aria-label*="last reading (incomplete)"], [title*="last reading"]') || /last reading \(incomplete\)/.test(container.innerHTML), 'the token cell spells it out')
  const rows = cellLabels(container, 's1')
  assert.equal(rows.length, 2, JSON.stringify(rows))
  for (const row of rows) {
    assert.match(row, /\d(\.\d)?[kM]\?/, `the tokens of an agent row of s1 are marked incomplete: ${row}`)
    assert.doesNotMatch(row, /≥\d(\.\d)?[kM]/, `never a lower bound on tokens: ${row}`)
  }
  for (const row of cellLabels(container, 's2')) assert.equal(row.includes('≥'), false, `the agent of s2 lost nothing: ${row}`)
})

test('a loss on s2 only: the rows of s1 stay plain, the family that counts s2 is incomplete', () => {
  const { container } = panel(new Map([['s2', 4]]))
  for (const row of cellLabels(container, 's1')) assert.equal(row.includes('≥'), false, `s1 row unchanged: ${row}`)
  for (const row of cellLabels(container, 's2')) assert.match(row, /\d(\.\d)?[kM]\?/, `s2 row is incomplete: ${row}`)
  assert.ok(container.textContent!.includes(ROLLUP_INCOMPLETE_TEXT), 'the family total counts s2')
})
