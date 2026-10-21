import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  attentionTitle, baseTitle, newlyBlocked, nextAttentionTarget, summarizeAttention, type AttentionAgent,
} from '../web/lib/attention'
import { STALE_AFTER_MS } from '../web/lib/canvas-constants'

// Agents waiting for a permission or in error, counted across sessions (#126)

const NOW = 1_000_000
const a = (id: string, sessionId: string, state: string, ageMs = 1000): AttentionAgent => ({ id, sessionId, state, lastEventAt: NOW - ageMs })

test('attention: counts waiting and errors per session and overall', () => {
  const sum = summarizeAttention([
    a('s1:a', 's1', 'waiting_permission'), a('s1:b', 's1', 'thinking'),
    a('s2:a', 's2', 'error'), a('s2:b', 's2', 'waiting_permission'), a('s2:c', 's2', 'waiting_permission'),
  ], NOW)
  assert.equal(sum.waiting, 3)
  assert.equal(sum.errors, 1)
  assert.equal(sum.total, 4)
  assert.deepEqual(sum.bySession.get('s1'), { waiting: 1, errors: 0 })
  assert.deepEqual(sum.bySession.get('s2'), { waiting: 2, errors: 1 })
  assert.equal(sum.bySession.has('s3'), false)
  assert.equal(sum.blockedIds.size, 4)
})

test('attention: the first target is a waiting agent, else the first in error, else none', () => {
  assert.equal(summarizeAttention([a('e', 's', 'error'), a('w', 's', 'waiting_permission')], NOW).firstAgentId, 'w')
  assert.equal(summarizeAttention([a('e', 's', 'error')], NOW).firstAgentId, 'e')
  assert.equal(summarizeAttention([a('t', 's', 'thinking')], NOW).firstAgentId, null)
  assert.equal(summarizeAttention([], NOW).total, 0)
})

test('attention: a live permission still pending past the freshness window is counted, an expired history one is not', () => {
  const sum = summarizeAttention([a('old', 's', 'waiting_permission', STALE_AFTER_MS + 1), a('new', 's', 'waiting_permission')], NOW)
  assert.equal(sum.waiting, 2)
  assert.equal(sum.firstAgentId, 'old')
  const expired = { ...a('h', 's', 'waiting_permission', 16 * 60_000), freshnessSource: 'history' as const }
  assert.equal(summarizeAttention([expired], NOW).waiting, 0)
  const justReplayed = { ...a('h', 's', 'waiting_permission', 0), freshnessSource: 'history' as const }
  assert.equal(summarizeAttention([justReplayed], NOW).waiting, 0, 'a permission read from history is not proven pending (#361)')
  assert.equal(summarizeAttention([{ id: 'n', sessionId: 's', state: 'waiting_permission' }], NOW).total, 0, 'never observed')
})

test('attention: wording of the counter, the row and the tab title', () => {
  assert.equal(attentionTitle('Agent Lens', 3), '(3) Agent Lens')
  assert.equal(attentionTitle('Agent Lens', 0), 'Agent Lens')
  assert.equal(baseTitle('(12) Agent Lens'), 'Agent Lens')
  assert.equal(baseTitle('Agent Lens'), 'Agent Lens')
})

test('attention: only agents blocked since the last check are reported for a notification', () => {
  assert.deepEqual(newlyBlocked(new Set(['a']), new Set(['a', 'b'])), ['b'])
  assert.deepEqual(newlyBlocked(new Set(['a']), new Set(['a'])), [])
  assert.deepEqual(newlyBlocked(new Set(['a']), new Set()), [])
})

// "Next" on the counter (#377): every blocked agent is reachable, waiting ones first, in turn

test('attention: the jump order lists waiting agents first, then errors, each with its session', () => {
  const sum = summarizeAttention([a('e1', 's1', 'error'), a('w1', 's1', 'waiting_permission'), a('w2', 's2', 'waiting_permission'), a('t', 's1', 'thinking')], NOW)
  assert.deepEqual(sum.order, [
    { id: 'w1', sessionId: 's1' }, { id: 'w2', sessionId: 's2' }, { id: 'e1', sessionId: 's1' },
  ])
})

test('attention: next target cycles from the current one and wraps around', () => {
  const sum = summarizeAttention([a('w1', 's1', 'waiting_permission'), a('w2', 's2', 'waiting_permission'), a('e1', 's1', 'error')], NOW)
  assert.equal(nextAttentionTarget(sum, null)?.id, 'w1')
  assert.equal(nextAttentionTarget(sum, 'w1')?.id, 'w2')
  assert.equal(nextAttentionTarget(sum, 'w2')?.id, 'e1')
  assert.equal(nextAttentionTarget(sum, 'e1')?.id, 'w1')
  assert.deepEqual(nextAttentionTarget(sum, 'w1'), { id: 'w2', sessionId: 's2' })
})

test('attention: an unknown or no-longer-blocked current agent restarts at the first target', () => {
  const sum = summarizeAttention([a('w1', 's1', 'waiting_permission'), a('e1', 's1', 'error')], NOW)
  assert.equal(nextAttentionTarget(sum, 'gone')?.id, 'w1')
  assert.equal(nextAttentionTarget(summarizeAttention([], NOW), 'w1'), null)
})
