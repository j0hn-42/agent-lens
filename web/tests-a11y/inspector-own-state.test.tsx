// Inspector (#57): a selected peer shows its OWN freshness, clock and errors, a vanished selection says so,
// and a rapid selection change never leaves the previous node's values on screen.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, within } from '@testing-library/react'

import { AgentDetailCard, AgentGoneCard } from '@/components/agent-visualizer/agent-detail-card'
import { createFreshnessClock } from '@/hooks/use-freshness-clock'
import { STALE_AFTER_MS } from '@/lib/canvas-constants'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const NOW = 1_700_000_000_000
const clock = createFreshnessClock({ now: () => NOW, isHidden: () => true })

const base = { state: 'thinking' as const, tokensUsed: 1, tokensMax: 10, toolCalls: 0, timeAlive: 1 }
const anchor = { ...base, id: 's1:main', name: 'Anchor', lastEventAt: NOW, freshnessSource: 'live' as const, sessionLabel: 'repo-a' }
const peer = { ...base, id: 's2:main', name: 'Peer', lastEventAt: NOW - 5 * STALE_AFTER_MS, freshnessSource: 'live' as const, sessionLabel: 'repo-b' }

const noop = () => {}

test('peer card: own stale freshness, own last event and own errors, not the anchor ones', () => {
  const v = render(<AgentDetailCard agent={peer} toolErrors={3} onClose={noop} freshnessClock={clock} />)
  const d = within(v.getByRole('dialog'))
  assert.equal(d.getByTestId('inspector-freshness').textContent, 'No longer reporting')
  assert.match(d.getByTestId('inspector-last-event').textContent ?? '', /^last event \d\d:\d\d:\d\d$/)
  assert.equal(d.getByTestId('inspector-errors').textContent, '3 tool errors')
  assert.ok(d.getByText(/^last known state: /), 'a stale node only shows its last known state')
  assert.ok(d.getByText('repo-b'))
  assert.equal(d.queryByText('repo-a'), null)
})

test('rapid selection change: the card for the new node replaces every value of the previous one', () => {
  const v = render(<AgentDetailCard key={anchor.id} agent={anchor} toolErrors={0} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.getByTestId('inspector-freshness').textContent, 'Live')
  for (const [a, errs] of [[peer, 2], [anchor, 0], [peer, 2], [peer, 2]] as const) {
    v.rerender(<AgentDetailCard key={a.id} agent={a} toolErrors={errs} onClose={noop} freshnessClock={clock} />)
    assert.equal(v.getByTestId('inspector-freshness').textContent, a === peer ? 'No longer reporting' : 'Live')
    assert.equal(v.getByTestId('inspector-errors').textContent, a === peer ? '2 tool errors' : '0 tool errors')
    assert.ok(v.getByText(a.sessionLabel))
    assert.equal(v.getAllByRole('dialog').length, 1)
  }
})

test('a node never observed says so, even when its session has live events', () => {
  const ghost = { ...base, id: 's3:main', name: 'Ghost' }
  const v = render(<AgentDetailCard agent={ghost} toolErrors={0} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.getByTestId('inspector-freshness').textContent, 'Not observed yet')
  assert.equal(v.getByTestId('inspector-last-event').textContent, 'no event observed')
})

test('gone card: explicit message naming the node, announced politely, closable', () => {
  let closed = 0
  const v = render(<AgentGoneCard name="Peer" onClose={() => { closed++ }} />)
  const msg = v.getByTestId('inspector-gone')
  assert.equal(msg.textContent, 'Peer is no longer listed')
  assert.equal(msg.getAttribute('role'), 'status')
  v.getByRole('button').click()
  assert.equal(closed, 1)
  v.rerender(<AgentGoneCard name={null} onClose={noop} />)
  assert.equal(v.getByTestId('inspector-gone').textContent, 'This node is no longer listed')
})

test('gone card: Escape closes it through onEscape (or onClose), and does not bubble', () => {
  let escaped = 0
  let closed = 0
  let bubbled = 0
  const v = render(<div onKeyDown={() => { bubbled++ }}><AgentGoneCard name="Peer" onClose={() => { closed++ }} onEscape={() => { escaped++ }} /></div>)
  v.getByRole('dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  assert.equal(escaped, 1)
  assert.equal(closed, 0)
  assert.equal(bubbled, 0)
  v.rerender(<div><AgentGoneCard name="Peer" onClose={() => { closed++ }} /></div>)
  v.getByRole('dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  assert.equal(closed, 1)
})
