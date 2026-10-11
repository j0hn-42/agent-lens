// Loop detection and health verdict (#230): the inspector says the verdict in words with its evidence,
// the session row speaks up only for a proven loop, and both stay accessible.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, within } from '@testing-library/react'
import axe from 'axe-core'

import { AgentDetailCard } from '@/components/agent-visualizer/agent-detail-card'
import { SessionListPanel, type SessionListAgent } from '@/components/agent-visualizer/session-list-panel'
import { createFreshnessClock } from '@/hooks/use-freshness-clock'
import type { HealthVerdict } from '@/lib/loop-detection'
import type { SessionInfo } from '@/lib/bridge-types'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const NOW = 1_700_000_000_000
const clock = createFreshnessClock({ now: () => NOW, isHidden: () => true })
const noop = () => {}
const agent = { id: 's1:main', name: 'Main', state: 'thinking' as const, tokensUsed: 1, tokensMax: 10, toolCalls: 6, timeAlive: 1, sessionId: 's1', lastEventAt: NOW, freshnessSource: 'live' as const }

const loop: HealthVerdict = {
  status: 'loop', calls: 9, comparable: 9, dropped: 0,
  findings: [
    { kind: 'repeat', agentKey: 's1:main', toolName: 'Grep', count: 4, atLeast: false, toolUseIds: [] },
    { kind: 'edit-cycle', agentKey: 's1:main', path: '/repo/src/very/long/path/a.ts', count: 3, atLeast: true, toolUseIds: [] },
  ],
}
const unknown: HealthVerdict = { status: 'unknown', calls: 0, comparable: 0, dropped: 0, findings: [] }
const clear: HealthVerdict = { status: 'clear', calls: 5, comparable: 5, dropped: 0, findings: [] }

async function axeViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => v.id)
}

test('inspector: a loop is spelled out with each piece of evidence in a named list', async () => {
  const v = render(<AgentDetailCard agent={agent} health={loop} sessionHealth={loop} onClose={noop} freshnessClock={clock} />)
  const d = within(v.getByRole('dialog'))
  assert.match(d.getByTestId('inspector-health-verdict').textContent ?? '', /Loop observed/)
  const list = d.getByRole('list', { name: 'Loop evidence' })
  const items = within(list).getAllByRole('listitem').map(li => li.textContent)
  assert.deepEqual(items, [
    'Grep called 4× in a row with the same input',
    'read → edit → failure at least 3× on a.ts',
  ])
  assert.equal(within(list).getAllByRole('listitem')[1].getAttribute('title'), '/repo/src/very/long/path/a.ts', 'the full path is one hover away')
  assert.match(d.getByTestId('inspector-session-health').textContent ?? '', /Session: Loop observed/)
  assert.deepEqual(await axeViolations(v.container), [])
})

test('inspector: without enough activity it says so, and never claims a healthy agent', () => {
  const v = render(<AgentDetailCard agent={agent} health={unknown} onClose={noop} freshnessClock={clock} />)
  const text = v.getByTestId('inspector-health-verdict').textContent ?? ''
  assert.match(text, /Not enough activity to judge/)
  assert.ok(!/healthy/i.test(v.container.textContent ?? ''))
  assert.equal(v.queryByRole('list', { name: 'Loop evidence' }), null)
  assert.equal(v.queryByTestId('inspector-session-health'), null, 'no session verdict given, none shown')
})

test('inspector: no verdict passed, no health section (nothing shown without proof)', () => {
  const v = render(<AgentDetailCard agent={agent} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.queryByTestId('inspector-health'), null)
})

const sessions: SessionInfo[] = [
  { id: 's1', label: 'looping', status: 'active', startTime: 0, lastActivityTime: 30, runtime: 'claude' },
  { id: 's2', label: 'calm', status: 'active', startTime: 0, lastActivityTime: 20, runtime: 'claude' },
]
const listAgent = (id: string, sessionId: string): SessionListAgent =>
  ({ id, sessionId, parentKey: null, name: id, state: 'thinking', tokensUsed: 1, spawnTime: 1, lastEventAt: Date.now() }) as SessionListAgent

test('session row: a proven loop is part of the row button name; a clear or unknown verdict adds nothing', async () => {
  const v = render(
    <SessionListPanel
      visible onClose={noop} sessions={sessions} selectedSessionId="__all__" sessionsWithActivity={new Set()}
      onSelectSession={noop} onCloseSession={noop} agents={new Map([['s1:main', listAgent('s1:main', 's1')], ['s2:main', listAgent('s2:main', 's2')]])}
      selectedAgentId={null} onSelectAgent={noop} now={5000} observedSessionIds={new Set(['s1', 's2'])}
      health={new Map([['s1', loop], ['s2', clear]])}
    />,
  )
  const row1 = v.container.querySelector('[data-closable-id="s1"]') as HTMLElement
  const row2 = v.container.querySelector('[data-closable-id="s2"]') as HTMLElement
  assert.match(within(row1).getByTestId('session-health').textContent ?? '', /loop observed/)
  assert.equal(row1.tagName, 'BUTTON', 'reachable with the keyboard as part of the row button')
  assert.equal(within(row2).queryByTestId('session-health'), null)
  assert.deepEqual(await axeViolations(v.container), [])
})
