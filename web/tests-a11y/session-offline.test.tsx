// #367: relay offline, the Sessions panel neither says "active" nor lets the duration grow.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import axe from 'axe-core'

import { SessionListPanel } from '@/components/agent-visualizer/session-list-panel'
import type { FreshnessClock } from '@/hooks/use-freshness-clock'
import type { SessionInfo } from '@/lib/bridge-types'
import { SESSION_OFFLINE_TEXT } from '@/lib/session-model'

const T0 = 1_000_000_000_000
const noop = () => {}
afterEach(() => cleanup())

const sessions: SessionInfo[] = [
  { id: 's1', label: 'payments-api', status: 'active', startTime: T0 - 72 * 60_000, lastActivityTime: T0 - 67 * 60_000 },
]
const agents = new Map([
  ['s1:main', { id: 's1:main', sessionId: 's1', parentKey: null, name: 'orchestrator', state: 'thinking', tokensUsed: 1, tokenStatus: 'available', spawnTime: 1, lastEventAt: T0 - 67 * 60_000 }],
])
const clock: FreshnessClock = { getNow: () => T0, subscribe: () => () => {} }

function panel(relayOffline?: boolean) {
  return (
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="s1" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={agents as never} selectedAgentId={null} onSelectAgent={noop}
      now={T0} freshnessClock={clock} observedSessionIds={new Set(['s1'])} relayOffline={relayOffline}
    />
  )
}

const row = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-row-key="session:s1"]')!

test('online, an observed active session reads "active" and its duration runs to now', () => {
  const { container } = render(panel())
  const r = row(container)
  assert.match(r.textContent ?? '', /^active,/)
  assert.equal(r.querySelector('[data-column="time"]')?.textContent?.includes('1h 12m'), true)
})

test('relay offline, the row says "status unknown (relay offline)" and the duration stops at the last activity', async () => {
  const { container } = render(panel(true))
  const r = row(container)
  assert.doesNotMatch(r.textContent ?? '', /(^|\W)active,/)
  assert.ok((r.textContent ?? '').includes(SESSION_OFFLINE_TEXT), r.textContent ?? '')
  const time = r.querySelector('[data-column="time"]')!
  assert.ok(time.textContent?.includes('5m 00s'), time.textContent ?? '')
  const results = await axe.run(container, { rules: { region: { enabled: false } } })
  assert.deepEqual(results.violations.map(v => v.id), [])
})
