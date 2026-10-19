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

test('silent agent: the card says for how long, with its last known state, and is not shown when fresh', () => {
  const silent = { ...base, id: 's4:main', name: 'Quiet', lastEventAt: NOW - 7 * 60_000 - 5_000, freshnessSource: 'live' as const }
  const v = render(<AgentDetailCard agent={silent} toolErrors={0} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.getByTestId('inspector-silence').textContent, 'last known state: Thinking, silent for 7 min')
  v.rerender(<AgentDetailCard agent={anchor} toolErrors={0} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.queryByTestId('inspector-silence'), null)
  v.rerender(<AgentDetailCard agent={peer} toolErrors={0} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.queryByTestId('inspector-silence'), null, 'stale for under five minutes: only the last known state')
})

test('pending permission: told apart from silence, and never shown for a history status', () => {
  const waiting = { ...base, id: 's5:main', name: 'Asker', state: 'waiting_permission' as const, lastEventAt: NOW - 9 * 60_000, freshnessSource: 'live' as const }
  const v = render(<AgentDetailCard agent={waiting} toolErrors={0} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.getByTestId('inspector-silence').textContent, 'waiting for permission for 9 min')
  v.rerender(<AgentDetailCard agent={{ ...waiting, freshnessSource: 'history' }} toolErrors={0} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.queryByTestId('inspector-silence'), null)
})

test('history status (#361): never "Live", and the clock is the time the history was received', () => {
  const replayed = { ...base, id: 's6:main', name: 'Replayed', lastEventAt: NOW, freshnessSource: 'history' as const }
  const v = render(<AgentDetailCard agent={replayed} toolErrors={0} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.getByTestId('inspector-freshness').textContent, 'From history')
  assert.match(v.getByTestId('inspector-last-event').textContent ?? '', /^history received \d\d:\d\d:\d\d$/)
  assert.ok(v.getByText('last known state: Thinking'), 'its state is only the last known one, from the moment it is received')
  // 40 min later: still "From history", never "No longer reporting" (it was never seen reporting)
  const old = { ...replayed, lastEventAt: NOW - 40 * 60_000 }
  v.rerender(<AgentDetailCard agent={old} toolErrors={0} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.getByTestId('inspector-freshness').textContent, 'From history')
  assert.equal(v.queryByTestId('inspector-silence'), null)
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

test('replay loss (#366): tool count and tool errors read "at least", a zero is never clean', () => {
  const a = { ...anchor, toolCalls: 4 }
  const v = render(<AgentDetailCard agent={a} toolErrors={0} replayLost={6} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.getByTestId('inspector-errors').textContent, 'no tool error observed (incomplete)')
  assert.ok(v.getByText('at least 4 tools'))
  v.rerender(<AgentDetailCard agent={a} toolErrors={2} replayLost={6} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.getByTestId('inspector-errors').textContent, 'at least 2 tool errors')
  assert.ok(v.getByText(/at least 6 earlier events were not replayed/))
  v.rerender(<AgentDetailCard agent={a} toolErrors={0} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.getByTestId('inspector-errors').textContent, '0 tool errors')
  assert.ok(v.getByText('4 tools'))
  assert.equal(v.queryByText(/not replayed/), null)
})

test('replay loss (#366): the context window is the last reading, incomplete (an absolute reading: no "at least", no "≥")', () => {
  const a = { ...anchor, tokensUsed: 150_000, tokensMax: 200_000, tokenStatus: 'available' as const }
  const v = render(<AgentDetailCard agent={a} toolErrors={0} replayLost={6} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.getByTestId('inspector-context').textContent, '150k / 200k (75%) (last reading, incomplete)')
  v.rerender(<AgentDetailCard agent={a} toolErrors={0} onClose={noop} freshnessClock={clock} />)
  assert.equal(v.getByTestId('inspector-context').textContent, '150k / 200k (75%)')
})
