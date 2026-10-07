// Issues #58 and #59 through the real components: branch/family cost totals in the sessions panel,
// and the live "active for X" chrono of the detail card.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import React, { Profiler } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import axe from 'axe-core'

import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import { ActiveTimeStat } from '@/components/agent-visualizer/active-time-stat'
import { AgentDetailCard } from '@/components/agent-visualizer/agent-detail-card'
import type { FreshnessClock } from '@/hooks/use-freshness-clock'
import { STALE_AFTER_MS } from '@/lib/canvas-constants'
import { ACTIVE_UNKNOWN_TEXT } from '@/lib/active-time'
import { ROLLUP_INCOMPLETE_TEXT } from '@/lib/cost-rollup'
import type { SessionInfo } from '@/lib/bridge-types'

const T0 = 1_000_000_000_000
const noop = () => {}

beforeEach(() => { mock.timers.enable({ apis: ['setInterval'] }) })
afterEach(() => { cleanup(); mock.timers.reset() })

function fakeClock(): FreshnessClock & { advance(ms: number): void } {
  let now = T0
  const listeners = new Set<() => void>()
  return {
    getNow: () => now,
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l) } },
    advance(ms) { now += ms; act(() => { for (const l of [...listeners]) l() }) },
  }
}

async function axeViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => v.id)
}

// ─── Costs (#58) ─────────────────────────────────────────────────────────────

const sessions: SessionInfo[] = [
  { id: 's1', label: 'First', status: 'active', startTime: 0, lastActivityTime: 3, teamName: 'T' },
  { id: 's2', label: 'Second', status: 'active', startTime: 0, lastActivityTime: 2, teamName: 'T' },
]
const mk = (id: string, sessionId: string, parentKey: string | null, tokensUsed: unknown, spawnTime = 1) =>
  [id, { id, sessionId, parentKey, name: id.split(':')[1], state: 'idle', tokensUsed, spawnTime, lastEventAt: T0 }] as const

function panel(agents: Map<string, never>, clock: FreshnessClock) {
  return (
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="s1" sessionsWithActivity={new Set(['s1', 's2'])}
      onSelectSession={noop} onCloseSession={noop} agents={agents as never} selectedAgentId={null} onSelectAgent={noop}
      teams={new Map([['T', { members: [] } as never]])} now={10_000} freshnessClock={clock}
    />
  )
}

test('panel: a parent shows its branch total, a session its total, a team the family total', () => {
  const agents = new Map([
    mk('s1:main', 's1', null, 1_000_000), mk('s1:sub', 's1', 's1:main', 500_000, 2), mk('s2:main', 's2', null, 250_000),
  ])
  const { container } = render(panel(agents as never, fakeClock()))
  const text = container.textContent!
  assert.ok(text.includes('branch total, '), 'the orchestrator row carries a branch total')
  assert.ok(text.includes('$9.00 · 1.5M'), 'main + sub-agent priced once each')
  assert.ok(text.includes('session total, '), 'session row total')
  assert.ok(text.includes('family total, '), 'team row total')
  assert.ok(text.includes('$10.50 · 1.7M'), 'family = both sessions, nothing counted twice')
  assert.equal(text.includes(ROLLUP_INCOMPLETE_TEXT), false)
})

test('panel: an unknown token count shows the incomplete badge in words on every level that contains it', () => {
  const agents = new Map([mk('s1:main', 's1', null, 1000), mk('s1:sub', 's1', 's1:main', undefined, 2)])
  const { container } = render(panel(agents as never, fakeClock()))
  assert.ok(container.textContent!.includes(ROLLUP_INCOMPLETE_TEXT))
  assert.ok(container.textContent!.includes('Incomplete total'), 'screen reader explanation')
})

test('axe: panel with totals and an incomplete badge', async () => {
  const agents = new Map([mk('s1:main', 's1', null, 1000), mk('s1:sub', 's1', 's1:main', null, 2), mk('s2:main', 's2', null, 5)])
  const { container } = render(panel(agents as never, fakeClock()))
  assert.deepEqual(await axeViolations(container), [])
})

// ─── Active time (#59) ───────────────────────────────────────────────────────

test('chrono: advances without re-rendering, from the monotonic clock only', () => {
  const clock = fakeClock()
  let mono = 0
  let wall = T0 + 10_000
  let renders = 0
  const agent = { state: 'thinking' as const, activeSince: T0, lastEventAt: T0 }
  const { getByTestId } = render(
    <Profiler id="x" onRender={() => { renders++ }}>
      <ActiveTimeStat agent={agent} freshnessClock={clock} now={() => wall} monotonic={() => mono} />
    </Profiler>,
  )
  assert.equal(getByTestId('active-time').textContent, 'active for 0:10')
  const base = renders
  mono += 5000
  wall += 3_600_000   // the wall clock jumps by an hour: the chrono ignores it
  act(() => { mock.timers.tick(1000) })
  assert.equal(getByTestId('active-time').textContent, 'active for 0:15')
  mono += 20_000
  act(() => { mock.timers.tick(1000) })
  assert.equal(getByTestId('active-time').textContent, 'active for 0:35')
  assert.equal(renders, base, 'no React render per tick')
})

test('chrono: when the source stops being fresh the counter is replaced by "unknown", not frozen or kept running', () => {
  const clock = fakeClock()
  let mono = 0
  const agent = { state: 'thinking' as const, activeSince: T0, lastEventAt: T0 }
  const { getByTestId } = render(<ActiveTimeStat agent={agent} freshnessClock={clock} now={() => T0} monotonic={() => mono} />)
  assert.equal(getByTestId('active-time').textContent, 'active for 0:00')
  mono += 60_000
  clock.advance(STALE_AFTER_MS + 1)
  assert.equal(getByTestId('active-time').textContent, ACTIVE_UNKNOWN_TEXT)
  act(() => { mock.timers.tick(5000) })
  assert.equal(getByTestId('active-time').textContent, ACTIVE_UNKNOWN_TEXT, 'the interval is gone')
})

test('chrono: a paused agent shows its closed total, a never-working one shows unknown', () => {
  const clock = fakeClock()
  const paused = render(<ActiveTimeStat agent={{ state: 'complete' as const, activeMs: 95_000, lastEventAt: T0 }} freshnessClock={clock} />)
  assert.equal(paused.getByTestId('active-time').textContent, '1:35 active')
  cleanup()
  const never = render(<ActiveTimeStat agent={{ state: 'idle' as const, lastEventAt: T0 }} freshnessClock={clock} />)
  assert.equal(never.getByTestId('active-time').textContent, ACTIVE_UNKNOWN_TEXT)
})

test('detail card shows the active time line and passes axe', async () => {
  const agent = {
    id: 'a', name: 'alpha', state: 'complete' as const, tokensUsed: 1, tokensMax: 100, toolCalls: 0, timeAlive: 5,
    activeMs: 4000, lastEventAt: Date.now(),
  }
  const { container } = render(<AgentDetailCard agent={agent} onClose={noop} />)
  assert.ok(container.textContent!.includes('0:04 active'))
  assert.deepEqual(await axeViolations(container), [])
})
