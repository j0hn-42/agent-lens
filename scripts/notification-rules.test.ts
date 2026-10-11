import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  DEFAULT_RULES, COST_THRESHOLD_MAX, parseRules, serializeRules, parseCostThreshold, evaluateTriggers, emptySnapshot,
  type NotifySnapshot,
} from '../web/lib/notification-rules'
import type { UsageTotal } from '../web/lib/usage'

// Configurable notification triggers (#225): permission, error, session finished, cost threshold

const cost = (value: number | null, status: UsageTotal['status'] = 'available', estimated = false): UsageTotal => ({ value, status, estimated })
const snap = (over: Partial<NotifySnapshot> = {}): NotifySnapshot => ({ ...emptySnapshot(), ...over })
const all = { ...DEFAULT_RULES, permission: true, error: true, complete: true, cost: true, costThresholdUsd: 5 }

test('rules: defaults keep the former behaviour (permission and error on), finish and cost off', () => {
  assert.deepEqual(
    { p: DEFAULT_RULES.permission, e: DEFAULT_RULES.error, c: DEFAULT_RULES.complete, k: DEFAULT_RULES.cost },
    { p: true, e: true, c: false, k: false },
  )
  assert.ok(DEFAULT_RULES.costThresholdUsd > 0)
})

test('rules: parse survives missing, corrupt and hostile storage values', () => {
  assert.deepEqual(parseRules(null), DEFAULT_RULES)
  assert.deepEqual(parseRules('not json'), DEFAULT_RULES)
  assert.deepEqual(parseRules('[1,2]'), DEFAULT_RULES)
  assert.deepEqual(parseRules('{"permission":"yes","error":0,"complete":true}'), { ...DEFAULT_RULES, complete: true })
  assert.equal(parseRules('{"costThresholdUsd":-3}').costThresholdUsd, DEFAULT_RULES.costThresholdUsd)
  assert.equal(parseRules('{"costThresholdUsd":"9"}').costThresholdUsd, DEFAULT_RULES.costThresholdUsd)
  assert.equal(parseRules(`{"costThresholdUsd":${COST_THRESHOLD_MAX + 1}}`).costThresholdUsd, DEFAULT_RULES.costThresholdUsd)
  assert.equal(parseRules('{"costThresholdUsd":12.5}').costThresholdUsd, 12.5)
})

test('rules: serialize then parse is the identity', () => {
  const rules = { permission: false, error: true, complete: true, cost: true, costThresholdUsd: 20 }
  assert.deepEqual(parseRules(serializeRules(rules)), rules)
})

test('threshold input: a positive amount up to the cap, otherwise refused (null)', () => {
  assert.equal(parseCostThreshold('5'), 5)
  assert.equal(parseCostThreshold(' 2.50 '), 2.5)
  for (const bad of ['', '0', '-1', 'abc', 'NaN', 'Infinity', '1e999', String(COST_THRESHOLD_MAX + 1)]) assert.equal(parseCostThreshold(bad), null, bad)
})

test('no notification on the first snapshot (baseline), whatever it holds', () => {
  const cur = snap({ waitingIds: new Set(['a']), cost: cost(50) })
  assert.deepEqual(evaluateTriggers(null, cur, all), [])
})

test('permission and error: only newly blocked agents, per enabled rule, body counts the enabled kinds', () => {
  const prev = snap({ waitingIds: new Set(['a']) })
  const cur = snap({ waitingIds: new Set(['a', 'b']), errorIds: new Set(['c']) })
  const both = evaluateTriggers(prev, cur, all)
  assert.equal(both.length, 1)
  assert.equal(both[0].trigger, 'attention')
  assert.equal(both[0].body, '2 waiting / 1 error')

  const onlyError = evaluateTriggers(prev, cur, { ...all, permission: false })
  assert.equal(onlyError[0].body, '1 error')

  const onlyPermission = evaluateTriggers(prev, snap({ waitingIds: new Set(['a']), errorIds: new Set(['c']) }), { ...all, error: false })
  assert.deepEqual(onlyPermission, [], 'a new error is silent when the error rule is off')

  assert.deepEqual(evaluateTriggers(prev, prev, all), [], 'nothing new, nothing sent')
})

test('finished: a session seen active that becomes completed, named by its label', () => {
  const prev = snap({ sessions: new Map([['s1', { label: 'api refactor', status: 'active' }], ['s2', { label: 'docs', status: 'active' }]]) })
  const cur = snap({ sessions: new Map([['s1', { label: 'api refactor', status: 'completed' }], ['s2', { label: 'docs', status: 'active' }]]) })
  const out = evaluateTriggers(prev, cur, all)
  assert.equal(out.length, 1)
  assert.equal(out[0].trigger, 'complete')
  assert.equal(out[0].body, 'Session finished: api refactor')
  assert.deepEqual(evaluateTriggers(prev, cur, { ...all, complete: false }), [])
})

test('finished: a session first seen already completed (history) or a session that disappears is never announced', () => {
  const prev = snap({ sessions: new Map([['gone', { label: 'x', status: 'active' }]]) })
  const cur = snap({ sessions: new Map([['old', { label: 'history', status: 'completed' }]]) })
  assert.deepEqual(evaluateTriggers(prev, cur, all), [])
})

test('finished: several sessions in one step give one notification naming the count', () => {
  const act = (l: string) => ({ label: l, status: 'active' as const })
  const done = (l: string) => ({ label: l, status: 'completed' as const })
  const prev = snap({ sessions: new Map([['a', act('A')], ['b', act('B')]]) })
  const cur = snap({ sessions: new Map([['a', done('A')], ['b', done('B')]]) })
  assert.equal(evaluateTriggers(prev, cur, all)[0].body, '2 sessions finished')
})

test('cost: fires once when the total crosses the threshold, not while it stays above', () => {
  const below = snap({ cost: cost(3) })
  const above = snap({ cost: cost(5.2) })
  const out = evaluateTriggers(below, above, all)
  assert.equal(out.length, 1)
  assert.equal(out[0].trigger, 'cost')
  assert.equal(out[0].body, 'Cost reached $5.20 (threshold $5.00)')
  assert.deepEqual(evaluateTriggers(above, snap({ cost: cost(7) }), all), [])
  assert.equal(evaluateTriggers(snap({ cost: cost(7) }), snap({ cost: cost(1) }), all).length, 0, 'dropping back is silent')
  assert.equal(evaluateTriggers(snap({ cost: cost(1) }), snap({ cost: cost(6) }), all).length, 1, 'crossing again re-arms')
})

test('cost: the wording keeps the qualification of the figure (lower bound, estimate)', () => {
  const prev = snap({ cost: cost(1) })
  assert.equal(evaluateTriggers(prev, snap({ cost: cost(6, 'partial') }), all)[0].body, 'Cost reached at least $6.00 (threshold $5.00)')
  assert.equal(evaluateTriggers(prev, snap({ cost: cost(6, 'available', true) }), all)[0].body, 'Cost reached $6.00 estimated (threshold $5.00)')
})

test('cost: an unknown cost never triggers, and the rule off or a changed threshold is honoured', () => {
  assert.deepEqual(evaluateTriggers(snap({ cost: cost(1) }), snap({ cost: cost(null, 'unavailable') }), all), [])
  assert.deepEqual(evaluateTriggers(snap({ cost: cost(1) }), snap({ cost: cost(9) }), { ...all, cost: false }), [])
  assert.equal(evaluateTriggers(snap({ cost: cost(1) }), snap({ cost: cost(9) }), { ...all, costThresholdUsd: 10 }).length, 0)
  assert.equal(evaluateTriggers(snap({ cost: cost(null, 'unavailable') }), snap({ cost: cost(9) }), all).length, 1, 'first known figure above the threshold')
})
