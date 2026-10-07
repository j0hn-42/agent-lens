import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_PAIR, isPairComplete, isPairSet, makePair, pickPairAgent, prunePair, messageMatchesPair, applyPair,
  pairChipLabel, pairAnnouncement, pairEmptyText, pairSpokenLabel,
} from '../web/lib/pair-filter'
import { getPair, setPair, pickPair, clearPair, subscribePair } from '../web/lib/pair-filter-store'

const names: Record<string, string> = { o: 'orchestrator', u: 'audit-ux', e: 'explore' }
const nameOf = (k: string) => names[k] ?? k

test('makePair ignores unusable keys', () => {
  assert.deepEqual(makePair('o', 'all'), { a: 'o', b: '' })
  assert.deepEqual(makePair(null, undefined), EMPTY_PAIR)
})

test('pickPairAgent: first, second, same-again clears, third restarts', () => {
  let p = pickPairAgent(EMPTY_PAIR, 'o')
  assert.deepEqual(p, { a: 'o', b: '' })
  assert.equal(isPairComplete(p), false)
  assert.equal(isPairSet(p), true)
  assert.deepEqual(pickPairAgent(p, 'o'), EMPTY_PAIR)
  p = pickPairAgent(p, 'u')
  assert.deepEqual(p, { a: 'o', b: 'u' })
  assert.equal(isPairComplete(p), true)
  assert.deepEqual(pickPairAgent(p, 'e'), { a: 'e', b: '' })
  assert.equal(pickPairAgent(p, 'all'), p)
})

test('prunePair drops vanished agents and keeps identity when unchanged', () => {
  const p = { a: 'o', b: 'u' }
  assert.equal(prunePair(p, () => true), p)
  assert.deepEqual(prunePair(p, k => k === 'o'), { a: 'o', b: '' })
})

const msgs = [
  { id: '1', type: 'dispatch', from: 'o', to: 'u' },
  { id: '2', type: 'return', from: 'u', to: 'o' },
  { id: '3', type: 'message', from: 'u', to: 'e' },
  { id: '4', type: 'assistant', from: 'o', to: 'u' },
  { id: '5', type: 'message', from: 'e', to: 'o' },
]

test('applyPair keeps both directions of comm messages only', () => {
  assert.deepEqual(applyPair(msgs, { a: 'o', b: 'u' }).map(m => m.id), ['1', '2'])
  assert.deepEqual(applyPair(msgs, { a: 'u', b: 'o' }).map(m => m.id), ['1', '2'])
  assert.equal(messageMatchesPair(msgs[3], { a: 'o', b: 'u' }), false)
})

test('an incomplete pair does not filter', () => {
  assert.equal(applyPair(msgs, { a: 'o', b: '' }).length, msgs.length)
  assert.equal(applyPair(msgs, { a: 'o', b: 'o' }).length, msgs.length)
})

test('chip label, announcements and empty state wording', () => {
  const p = { a: 'o', b: 'u' }
  assert.equal(pairChipLabel(p, nameOf), 'orchestrator ↔ audit-ux')
  assert.equal(pairChipLabel({ a: 'o', b: '' }, nameOf), 'orchestrator ↔ ...')
  assert.equal(pairSpokenLabel(p, nameOf), 'orchestrator and audit-ux')
  assert.equal(pairAnnouncement(p, nameOf, 2), 'Showing 2 messages between orchestrator and audit-ux')
  assert.equal(pairAnnouncement(p, nameOf, 1), 'Showing 1 message between orchestrator and audit-ux')
  assert.equal(pairAnnouncement(p, nameOf, 0), 'No messages between orchestrator and audit-ux')
  assert.equal(pairAnnouncement(EMPTY_PAIR, nameOf, 0), 'Pair filter cleared')
  assert.match(pairAnnouncement({ a: 'o', b: '' }, nameOf, 0), /second agent/)
  assert.equal(pairAnnouncement({ a: 'o', b: 'o' }, nameOf, 0), 'Select two different agents')
  assert.equal(pairEmptyText(p, nameOf), 'No messages between orchestrator and audit-ux')
})

test('shared store notifies once per change and clears', () => {
  clearPair()
  let n = 0
  const off = subscribePair(() => { n++ })
  pickPair('o'); pickPair('u')
  assert.deepEqual(getPair(), { a: 'o', b: 'u' })
  setPair('o', 'u')
  assert.equal(n, 2)
  clearPair()
  assert.deepEqual(getPair(), EMPTY_PAIR)
  assert.equal(n, 3)
  off()
  pickPair('e')
  assert.equal(n, 3)
  clearPair()
})
